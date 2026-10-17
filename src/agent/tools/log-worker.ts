/**
 * 日志工具的 worker 实现。
 *
 * 所有 CPU 密集操作在此执行，避免阻塞主线程事件循环（实测：10MB 日志 grep
 * 会导致主线程停顿 1423ms）。
 *
 * 通信协议：`{ id, op, content, options }` → `{ id, ok, payload | error }`
 */

import { parentPort } from 'node:worker_threads';

/** 单次结果字节上限 */
const MAX_RESULT_BYTES = 32_000;

/** 上下文行数上限（防止一次拉取过多） */
const MAX_CONTEXT_LINES = 5;

interface GrepOptions {
  pattern?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
}

interface ReadOptions {
  lineStart?: number;
  lineEnd?: number;
  maxBytes?: number;
}

interface Request {
  id: number;
  op: 'grep' | 'read';
  content?: string;
  options?: unknown;
}

/** 正则转义（当 pattern 不是合法正则时按字面量处理） */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(pattern, flags);
  } catch {
    // 非法正则：按字面量处理（用户常直接粘贴含特殊字符的报错原文）
    try {
      return new RegExp(escapeRegex(pattern), flags);
    } catch {
      return null;
    }
  }
}

function handleGrep(content: string, options: GrepOptions): unknown {
  const pattern = (options.pattern ?? '').trim();
  if (pattern === '') {
    return {
      ok: false,
      text: '检索词不能为空。',
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: 'empty pattern',
    };
  }

  const re = buildRegex(pattern, options.caseSensitive === true);
  if (re === null) {
    return {
      ok: false,
      text: `无法解析检索模式：${pattern}`,
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: 'invalid pattern',
    };
  }

  const contextLines = Math.max(0, Math.min(MAX_CONTEXT_LINES, options.contextLines ?? 1));
  const maxMatches = Math.max(1, Math.min(50, options.maxMatches ?? 10));

  const lines = content.split('\n');
  const totalLines = lines.length;

  // 收集命中行号
  const hitLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) hitLines.push(i);
    // 提前终止：命中数远超上限时不再全扫（大日志性能保护）
    if (hitLines.length > maxMatches * 20) break;
  }

  const totalMatches = hitLines.length;

  if (totalMatches === 0) {
    return {
      ok: true,
      text: `未找到包含 "${pattern}" 的行。\n提示：可尝试更短的关键词，或改用日志中的异常类名原文。`,
      matches: [],
      totalMatches: 0,
      truncated: false,
    };
  }

  // 取前 maxMatches 个命中，合并上下文区间（相邻/重叠区间合并，避免重复行）
  const selected = hitLines.slice(0, maxMatches);
  const ranges: Array<[number, number]> = [];
  for (const hit of selected) {
    const start = Math.max(0, hit - contextLines);
    const end = Math.min(lines.length - 1, hit + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  // 行号宽度（右对齐，便于阅读）
  const width = String(totalLines).length;

  const out: string[] = [];
  out.push(
    `在日志中检索 "${pattern}"（${options.caseSensitive === true ? '区分大小写' : '忽略大小写'}）：` +
      `共 ${totalMatches} 处匹配${totalMatches > maxMatches ? `，显示前 ${maxMatches} 处` : ''}`,
  );
  out.push('');

  const matches: Array<{ line: number; text: string }> = [];
  let bytes = Buffer.byteLength(out.join('\n'), 'utf8');
  let truncated = false;

  for (const [start, end] of ranges) {
    if (truncated) break;
    out.push(`... 第 ${start + 1} - ${end + 1} 行 ...`);
    for (let i = start; i <= end; i++) {
      const isHit = hitLines.includes(i);
      const marker = isHit ? '>' : ' ';
      const line = `${marker} ${String(i + 1).padStart(width)} | ${lines[i]}`;
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + size > MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }
      out.push(line);
      bytes += size;
      if (isHit) matches.push({ line: i + 1, text: lines[i]! });
    }
    out.push('');
  }

  if (truncated) {
    out.push(`[结果已达 ${MAX_RESULT_BYTES} 字节上限，请缩小检索范围或减少上下文行数]`);
  }

  return {
    ok: true,
    text: out.join('\n'),
    matches,
    totalMatches,
    truncated,
  };
}

function handleRead(content: string, options: ReadOptions): unknown {
  const lines = content.split('\n');
  const totalLines = lines.length;

  let start = Math.max(1, options.lineStart ?? 1);
  let end = options.lineEnd ?? totalLines;

  if (start > totalLines) {
    return {
      ok: false,
      text: `起始行 ${start} 超出日志总行数 ${totalLines}。`,
      startLine: start,
      endLine: start,
      totalLines,
      truncated: false,
      error: 'start out of range',
    };
  }

  end = Math.min(totalLines, Math.max(start, end));

  const maxBytes = Math.max(1000, options.maxBytes ?? MAX_RESULT_BYTES);
  const width = String(totalLines).length;

  const out: string[] = [];
  let bytes = 0;
  let actualEnd = start - 1;

  for (let i = start - 1; i < end; i++) {
    const line = `${String(i + 1).padStart(width)} | ${lines[i]}`;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    out.push(line);
    bytes += size;
    actualEnd = i + 1;
  }

  const truncated = actualEnd < end;
  const header = `文件共 ${totalLines} 行；本次读取第 ${start} - ${actualEnd} 行`;

  const body = [header, '', ...out].join('\n');
  const nextStart = truncated ? actualEnd + 1 : undefined;

  return {
    ok: true,
    text: truncated ? `${body}\n\n[已达字节上限，如需继续请从第 ${nextStart} 行读取]` : body,
    startLine: start,
    endLine: actualEnd,
    totalLines,
    truncated,
    ...(nextStart !== undefined ? { nextStart } : {}),
  };
}

parentPort?.on('message', (req: Request) => {
  try {
    const content = req.content ?? '';
    let payload: unknown;

    switch (req.op) {
      case 'grep':
        payload = handleGrep(content, (req.options ?? {}) as GrepOptions);
        break;
      case 'read':
        payload = handleRead(content, (req.options ?? {}) as ReadOptions);
        break;
      default:
        throw new Error(`未知操作: ${String(req.op)}`);
    }

    parentPort?.postMessage({ id: req.id, ok: true, payload });
  } catch (e) {
    parentPort?.postMessage({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
