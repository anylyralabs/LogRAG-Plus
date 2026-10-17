/**
 * 日志窗口提取 —— 把「锚点 + 上下文」组装成给模型的首轮输入。
 *
 * 与 LogShare `LogWindowManager::buildInitialWindow` 的差异：
 *  1. 锚点定位改用结构性标记优先（见 anchor.ts，修复 86% 错过率）
 *  2. 大日志给**多窗口**（头部启动环境 + 崩溃点），而非单窗口
 *  3. 未定位到锚点时，不给"开服前缀日志"（那是误导），而给概况 + grep 指引
 */

import { findErrorAnchor } from './anchor.ts';

export interface WindowOptions {
  /** 单窗口字节上限 */
  maxBytes?: number;
  /** 锚点前置上下文字节上限（保留因果线索） */
  preContextBytes?: number;
  /** 是否在超大日志时附加头部环境窗口 */
  multiWindow?: boolean;
  /** 头部窗口字节上限 */
  headBytes?: number;
}

export interface LogWindow {
  /** 是否成功定位到窗口 */
  hasWindow: boolean;
  /** 窗口正文（已含前后省略标记） */
  body: string;
  /** 1-based 起始行 */
  startLine: number;
  /** 1-based 结束行 */
  endLine: number;
  /** 1-based 锚点行 */
  anchorLine: number | null;
  /** 锚点命中来源 */
  matchedBy: string | null;
  /** 是否为结构性标记（高置信） */
  structural: boolean;
  /** 总行数 */
  totalLines: number;
}

const DEFAULTS = {
  maxBytes: 12000,
  preContextBytes: 2500,
  multiWindow: true,
  headBytes: 2000,
};

/**
 * 构建初始窗口。
 *
 * @param content 日志正文
 * @param options 窗口参数
 */
export function buildLogWindow(content: string, options: WindowOptions = {}): LogWindow {
  const opts = { ...DEFAULTS, ...options };
  const lines = content.split('\n');
  const totalLines = lines.length;

  // 短日志：原样返回
  if (Buffer.byteLength(content, 'utf8') < opts.maxBytes) {
    return {
      hasWindow: true,
      body: content,
      startLine: 1,
      endLine: totalLines,
      anchorLine: null,
      matchedBy: null,
      structural: false,
      totalLines,
    };
  }

  const anchor = findErrorAnchor(lines);

  // 未定位到锚点：返回概况 + grep 指引（绝不截取开服前缀，那是误导）
  if (anchor.index === null) {
    return {
      hasWindow: false,
      body: buildOverview(content, totalLines),
      startLine: 0,
      endLine: 0,
      anchorLine: null,
      matchedBy: null,
      structural: false,
      totalLines,
    };
  }

  const window = extractAround(lines, anchor.index, opts);
  let body = window.text;

  // 多窗口：超大日志额外附头部环境信息（启动器版本、SoC、Java 版本等）
  if (opts.multiWindow && anchor.index > 200) {
    const head = extractHead(lines, opts.headBytes);
    if (head.text !== '') {
      body = `${head.text}\n\n[... 中间省略 ${head.endLine} - ${window.startLine - 1} 行 ...]\n\n${window.text}`;
    }
  }

  return {
    hasWindow: true,
    body,
    startLine: window.startLine,
    endLine: window.endLine,
    anchorLine: anchor.index + 1,
    matchedBy: anchor.matchedBy,
    structural: anchor.structural,
    totalLines,
  };
}

interface Extracted {
  text: string;
  startLine: number;
  endLine: number;
}

/** 以锚点为核心向两侧扩展，前置上下文单独限流 */
function extractAround(lines: string[], anchorIndex: number, opts: Required<WindowOptions>): Extracted {
  const anchorLineBytes = Buffer.byteLength(lines[anchorIndex]!, 'utf8') + 1;

  let start = anchorIndex;
  let end = anchorIndex;
  let total = anchorLineBytes;
  let preBytes = 0;

  // 向上：前置上下文独立限流（保留因果链，但不过度占用）
  while (start > 0) {
    const prev = Buffer.byteLength(lines[start - 1]!, 'utf8') + 1;
    if (preBytes + prev > opts.preContextBytes) break;
    if (total + prev > opts.maxBytes) break;
    start--;
    total += prev;
    preBytes += prev;
  }

  // 向下：优先吃掉完整堆栈
  while (end + 1 < lines.length) {
    const next = Buffer.byteLength(lines[end + 1]!, 'utf8') + 1;
    if (total + next > opts.maxBytes) break;
    end++;
    total += next;
  }

  // 若还有余量，继续向上补（此时前置已满足）
  while (start > 0) {
    const prev = Buffer.byteLength(lines[start - 1]!, 'utf8') + 1;
    if (total + prev > opts.maxBytes) break;
    start--;
    total += prev;
  }

  const slice = lines.slice(start, end + 1);
  const prefix = start > 0 ? `[前文已省略第 1 - ${start} 行 ...]\n` : '';
  const suffix = end < lines.length - 1 ? `\n[... 后文已省略第 ${end + 2} - ${lines.length} 行 ...]` : '';

  return {
    text: prefix + slice.join('\n') + suffix,
    startLine: start + 1,
    endLine: end + 1,
  };
}

/** 头部窗口：启动环境信息（不含开服日志正文，只取有诊断价值的行） */
function extractHead(lines: string[], maxBytes: number): Extracted {
  const meaningful: string[] = [];
  let bytes = 0;
  const limit = Math.min(lines.length, 120);

  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    // 只保留环境/版本类信息
    if (!/(Launcher version|Architecture|Device|Java|JVM|JRE|CPU|GPU|GL |Renderer|Minecraft version|Fabric|Forge|NeoForge|Operating System|Android|os\.arch|Build)/i.test(line)) {
      continue;
    }
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    meaningful.push(line);
    bytes += size;
  }

  if (meaningful.length === 0) {
    return { text: '', startLine: 0, endLine: 0 };
  }

  return {
    text: `[启动环境信息]\n${meaningful.join('\n')}`,
    startLine: 1,
    endLine: limit,
  };
}

/** 未定位锚点时的概况 + 指引 */
function buildOverview(content: string, totalLines: number): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  return [
    '待分析日志概况：',
    `- 日志总大小：${bytes} 字节，共 ${totalLines} 行。`,
    '- 预扫描未匹配到确定性崩溃标记（crash-report / hs_err / A fatal error / Minecraft has crashed）。',
    '- 已刻意不截取日志开头，避免正常启动日志产生误导。',
    '',
    '建议用 grep_log_file 定向检索（1~2 次即可）：',
    '  · 异常与级别：ERROR、FATAL、Exception、Throwable',
    '  · 因果与堆栈：Caused by、Stacktrace',
    '  · 停机与崩溃：Failed to、Shutting down、crash',
    '  · 常见故障：MixinApplyError、OutOfMemory、NoSuchMethod、ClassNotFound',
    '',
    '若检索后仍无致命错误，应客观说明"未发现明显致命错误"，不要反复换词试错。',
  ].join('\n');
}
