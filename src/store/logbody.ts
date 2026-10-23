/**
 * 日志正文存储：主日志 + 追加段。
 *
 * ## 为什么按段存而不是一整块
 *
 * 「追加日志」是本服务要解决的核心问题：用户第一次给了一份 `latest.log`，
 * 后来又要补一份崩溃报告。若正文是一整块字段，追加就是「读出全文 → 拼接 → 写回」，
 * 既带来整篇重写，也会在并发下互相覆盖。
 *
 * 改成按段存之后，**追加只是插入一行**（`seq = n+1`），不碰已有数据。
 * 读取时按 `seq` 升序拼接，用 `===== 追加 N =====` 分隔——
 * 模型能看出「这是后补的材料」，而不是把它当成原文的一部分。
 *
 * ## 两种会话
 *
 * - `native`：正文全部在本库。`seq=0` 是主日志，`seq>=1` 是追加。
 * - `logshare`：主日志在 LogShare（7 天 TTL），本库**只存追加段**。
 *   读取时基础正文现取，取不到就如实说明「原日志已过期，仅追加部分可分析」。
 */

import { execute, query, queryOne } from './mysql.ts';

/** 一段日志正文 */
export interface LogSegment {
  seq: number;
  content: string;
  files: Array<{ name: string; data: string }> | null;
  source: string | null;
  bytes: number;
  lineCount: number;
  createdAt: number;
}

export interface AppendResult {
  seq: number;
  /** 追加后该会话的总段数（含主日志） */
  total: number;
}

/** 统计字节与行数（行数 = 换行数 + 1，空内容为 0） */
export function measure(content: string): { bytes: number; lineCount: number } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (content === '') return { bytes: 0, lineCount: 0 };
  let lineCount = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineCount++;
  }
  return { bytes, lineCount };
}

interface SegmentRow {
  seq: number;
  content: string;
  files: unknown;
  source: string | null;
  bytes: number;
  line_count: number;
  created_at: number;
}

function toSegment(row: SegmentRow): LogSegment {
  // 同 session.ts 的说明：mysql2 会把 JSON 列解析成对象，TEXT 列是字符串，两者都接受
  let files: LogSegment['files'] = null;
  if (row.files !== null && row.files !== undefined && row.files !== '') {
    if (typeof row.files === 'object') {
      files = row.files as LogSegment['files'];
    } else if (typeof row.files === 'string') {
      try {
        files = JSON.parse(row.files) as LogSegment['files'];
      } catch {
        files = null;
      }
    }
  }
  return {
    seq: row.seq,
    content: row.content,
    files,
    source: row.source,
    bytes: row.bytes,
    lineCount: row.line_count,
    createdAt: Number(row.created_at),
  };
}

/**
 * 写入主日志（`seq = 0`）。
 *
 * 已存在则覆盖：同一会话重复上传主日志时，以最后一次为准。
 * 追加段不受影响。
 */
export async function putBase(
  sessionId: string,
  input: {
    content: string;
    files?: Array<{ name: string; data: string }> | null;
    source?: string | null;
  },
): Promise<void> {
  const { bytes, lineCount } = measure(input.content);
  await execute(
    `INSERT INTO log_bodies (session_id, seq, content, files, source, bytes, line_count, created_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       files = VALUES(files),
       source = VALUES(source),
       bytes = VALUES(bytes),
       line_count = VALUES(line_count)`,
    [
      sessionId,
      input.content,
      input.files !== undefined && input.files !== null && input.files.length > 0
        ? JSON.stringify(input.files)
        : null,
      input.source ?? null,
      bytes,
      lineCount,
      Math.floor(Date.now() / 1000),
    ],
  );
}

/**
 * 追加一段。
 *
 * `seq` 用 `MAX(seq)+1` 在**同一条 SQL 里**算出来，避免「先查后插」的竞态。
 * 并发追加时可能撞主键——调用方按一次冲突重试即可（`attempt` 参数内部已做）。
 */
export async function appendSegment(
  sessionId: string,
  input: {
    content: string;
    files?: Array<{ name: string; data: string }> | null;
    source?: string | null;
  },
  attempt = 0,
): Promise<AppendResult> {
  const { bytes, lineCount } = measure(input.content);

  const next = await queryOne<{ n: number | null }>(
    'SELECT MAX(seq) AS n FROM log_bodies WHERE session_id = ?',
    [sessionId],
  );
  // 主日志可能是 logshare 类型（本库没有 seq=0），此时追加从 1 开始
  const seq = (next?.n ?? 0) + 1;

  try {
    await execute(
      `INSERT INTO log_bodies (session_id, seq, content, files, source, bytes, line_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        seq,
        input.content,
        input.files !== undefined && input.files !== null && input.files.length > 0
          ? JSON.stringify(input.files)
          : null,
        input.source ?? null,
        bytes,
        lineCount,
        Math.floor(Date.now() / 1000),
      ],
    );
  } catch (e) {
    // 并发追加撞主键：重算一次（只重试一次，避免活锁）
    const code = (e as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY' && attempt < 1) {
      return appendSegment(sessionId, input, attempt + 1);
    }
    throw e;
  }

  const total = await countSegments(sessionId);
  return { seq, total };
}

/** 该会话在本库里的段数 */
export async function countSegments(sessionId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM log_bodies WHERE session_id = ?',
    [sessionId],
  );
  return Number(row?.n ?? 0);
}

/** 取全部段（按 seq 升序） */
export async function listSegments(sessionId: string): Promise<LogSegment[]> {
  const rows = await query<SegmentRow>(
    'SELECT seq, content, files, source, bytes, line_count, created_at FROM log_bodies WHERE session_id = ? ORDER BY seq',
    [sessionId],
  );
  return rows.map(toSegment);
}

/** 取主日志段（`seq = 0`），没有则 null */
export async function getBase(sessionId: string): Promise<LogSegment | null> {
  const row = await queryOne<SegmentRow>(
    'SELECT seq, content, files, source, bytes, line_count, created_at FROM log_bodies WHERE session_id = ? AND seq = 0',
    [sessionId],
  );
  return row === null ? null : toSegment(row);
}

/** 取追加段（`seq >= 1`） */
export async function listAppends(sessionId: string): Promise<LogSegment[]> {
  const rows = await query<SegmentRow>(
    'SELECT seq, content, files, source, bytes, line_count, created_at FROM log_bodies WHERE session_id = ? AND seq >= 1 ORDER BY seq',
    [sessionId],
  );
  return rows.map(toSegment);
}

/**
 * 合并成一份可供模型阅读的正文。
 *
 * 分隔标记刻意写成 `===== 追加 N =====`：
 * 与 LogShare 多文件合并的 `===== 文件名 =====` 同形，界面既有的分节解析
 * （`logdoc.ts` 的 `SECTION_RE`）能直接识别，不需要为「追加」再写一套解析。
 */
export function mergeSegments(base: string | null, appends: LogSegment[]): string {
  const parts: string[] = [];
  if (base !== null && base !== '') parts.push(base);
  for (const seg of appends) {
    const label = seg.source !== null && seg.source !== '' ? seg.source : `追加 ${seg.seq}`;
    parts.push(`===== ${label} =====\n${seg.content}`);
  }
  return parts.join('\n\n');
}

/** 删除会话的全部正文（会话过期清理时调用） */
export async function deleteBodies(sessionId: string): Promise<number> {
  const r = await execute('DELETE FROM log_bodies WHERE session_id = ?', [sessionId]);
  return r.affectedRows;
}

/** 正文总字节（用于配额与体积上限判断） */
export async function totalBytes(sessionId: string): Promise<number> {
  const row = await queryOne<{ n: number | null }>(
    'SELECT SUM(bytes) AS n FROM log_bodies WHERE session_id = ?',
    [sessionId],
  );
  return Number(row?.n ?? 0);
}
