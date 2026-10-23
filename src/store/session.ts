/**
 * 会话与消息（MariaDB）。
 *
 * ## 与 SQLite 版的差别只在实现，不在语义
 *
 * 对外导出的函数名与签名保持不变（`findOrCreateSession` / `appendMessage` /
 * `getHistory` / `countRounds` / `checkRoundsAllowed` / `sessionTtlSeconds` /
 * `cleanupExpired`），这样 5 个调用方与既有测试不需要改。
 *
 * 唯一的语义扩展是 **`logKind`**：区分「日志正文存在本库」（native）
 * 与「正文在 LogShare、本库只存追加段」（logshare）。
 */

import { quota as quotaCfg, storage } from '../config.ts';
import { execute, query, queryOne, transaction } from './mysql.ts';

export interface Session {
  id: string;
  /** LogShare 日志 ID（`logKind='logshare'` 时必有；native 时通常为 null） */
  logId: string | null;
  /**
   * 会话归属（匿名主体：指纹优先、IP+UA 兜底）。
   *
   * 日志 ID 是公开的（就在 URL 里）。若按 logId 复用会话，任何打开同一份日志的人
   * 都会进入同一会话——既看到别人的追问，也消耗别人的轮次。会话本身仍是
   * 「知道 ID 即可回放」的 bearer 语义（无登录产品要支持换设备），但**自动复用**
   * 必须限定在同一主体内。
   */
  owner: string | null;
  /** 正文归属：本库（native）还是 LogShare（logshare） */
  logKind: 'native' | 'logshare';
  createdAt: number;
  updatedAt: number;
  /** 过期时间（秒级时间戳） */
  expiresAt: number;
}

export interface MessageScore {
  overall: number;
  deliverable: boolean;
  dimensions: {
    grounding: number | null;
    verification: number;
    actionability: number;
    economy: number;
  };
  deductions: string[];
  missingAnchors: string[];
}

export interface MessageMeta {
  asks?: Array<{ questions: string[]; reason?: string }>;
}

export interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  score: MessageScore | null;
  meta: MessageMeta | null;
  createdAt: number;
}

interface SessionRow {
  id: string;
  owner: string | null;
  log_kind: 'native' | 'logshare';
  log_ref: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  score: unknown;
  meta: unknown;
  created_at: number;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    logId: row.log_ref,
    owner: row.owner,
    logKind: row.log_kind,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at),
  };
}

/**
 * 解析 JSON 列。
 *
 * mysql2 对 `JSON` 类型**会自动反序列化成对象**，而 `TEXT` 列返回字符串。
 * 两种都可能出现（历史数据/迁移），因此这里同时接受两种形态：
 * 已是对象就直接用，是字符串才 parse。原先只做 `JSON.parse(row.score)`，
 * 遇到已解析的对象会抛错并被 catch 成 `null`——表现为「分数写进库了但读不出来」。
 */
function parseJsonColumn<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function toMessage(row: MessageRow): Message {
  const score = parseJsonColumn<MessageScore>(row.score);
  const meta = parseJsonColumn<MessageMeta>(row.meta);
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    score,
    meta,
    createdAt: Number(row.created_at),
  };
}

/** 生成会话 ID（保持既有形态：`s` + 时间戳 + 随机串） */
function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 会话 TTL。
 *
 * - 未绑定日志：`SESSION_TTL_HOURS`（默认 48 小时）
 * - 绑定 LogShare 日志：跟随 LogShare 的 `STORAGE_TIME`（默认 7 天）——
 *   否则「导入的日志还在，追加段先过期」，体验割裂
 */
export function sessionTtlSeconds(logId: string | null): number {
  if (logId !== null && logId !== '') {
    const storageTime = Number(process.env['STORAGE_TIME'] ?? 0);
    return storageTime > 0 ? storageTime : 7 * 24 * 3600;
  }
  return storage.sessionTtlHours * 3600;
}

/**
 * 查找或创建会话。
 *
 * 复用规则（与 SQLite 版一致）：
 *  1. 同一 `owner` + 同一 `logRef` 的未过期会话可复用
 *  2. 没有 `owner`（旧数据 / 匿名）时不自动复用，避免串会话
 */
export async function findOrCreateSession(
  logId: string | null,
  ttlSeconds: number,
  owner: string | null = null,
  logKind: 'native' | 'logshare' = logId !== null ? 'logshare' : 'native',
): Promise<Session> {
  const ts = now();

  if (logId !== null && owner !== null) {
    const existing = await queryOne<SessionRow>(
      `SELECT id, owner, log_kind, log_ref, created_at, updated_at, expires_at
         FROM sessions
        WHERE owner = ? AND log_ref = ? AND expires_at > ?
        ORDER BY updated_at DESC
        LIMIT 1`,
      [owner, logId, ts],
    );
    if (existing !== null) return toSession(existing);
  }

  const id = newSessionId();
  const expiresAt = ts + ttlSeconds;

  await transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO sessions (id, owner, log_kind, log_ref, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, owner, logKind, logId, ts, ts, expiresAt],
    );
  });

  return {
    id,
    logId,
    owner,
    logKind,
    createdAt: ts,
    updatedAt: ts,
    expiresAt,
  };
}

/** 按 ID 取会话（过期返回 null） */
export async function getSession(sessionId: string): Promise<Session | null> {
  const row = await queryOne<SessionRow>(
    `SELECT id, owner, log_kind, log_ref, created_at, updated_at, expires_at
       FROM sessions WHERE id = ? AND expires_at > ?`,
    [sessionId, now()],
  );
  return row === null ? null : toSession(row);
}

/** 追加一条消息，并刷新会话的 `updated_at` */
export async function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  options: {
    reasoning?: string | null;
    score?: MessageScore | null;
    meta?: MessageMeta | null;
  } = {},
): Promise<Message> {
  const ts = now();
  const scoreJson = options.score !== undefined && options.score !== null
    ? JSON.stringify(options.score)
    : null;
  const metaJson = options.meta !== undefined && options.meta !== null
    ? JSON.stringify(options.meta)
    : null;

  const result = await execute(
    `INSERT INTO messages (session_id, role, content, reasoning, score, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, role, content, options.reasoning ?? null, scoreJson, metaJson, ts],
  );

  await execute('UPDATE sessions SET updated_at = ? WHERE id = ?', [ts, sessionId]);

  return {
    id: Number(result.insertId),
    sessionId,
    role,
    content,
    reasoning: options.reasoning ?? null,
    score: options.score ?? null,
    meta: options.meta ?? null,
    createdAt: ts,
  };
}

/** 取历史消息（按时间升序，只取最近 `limit` 条） */
export async function getHistory(sessionId: string, limit = 20): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT id, session_id, role, content, reasoning, score, meta, created_at
       FROM messages WHERE session_id = ?
       ORDER BY id DESC LIMIT ?`,
    [sessionId, limit],
  );
  return rows.map(toMessage).reverse();
}

/**
 * 轮次数 = **用户提问次数**（`role = 'user'`）。
 *
 * 口径必须与既有实现一致：一轮 = 用户问一次，而不是模型答一次。
 * 写成 `role = 'assistant'` 会让「轮次上限」在模型失败、没产出回答时
 * 永不递增——用户就能无限重试，而这正是配额要防的情形。
 */
export async function countRounds(sessionId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`,
    [sessionId],
  );
  return Number(row?.n ?? 0);
}

/** 检查轮次是否还有余量 */
export async function checkRoundsAllowed(
  sessionId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const used = await countRounds(sessionId);
  const limit = Math.max(1, quotaCfg.roundsPerSession);
  return { allowed: used < limit, remaining: Math.max(0, limit - used) };
}

/**
 * 清理过期会话。
 *
 * 先删正文再删会话：`log_bodies` 没有外键（MariaDB 分区表历史原因与
 * 删除性能考虑），漏删会留下孤儿正文，长期占用空间。
 */
export async function cleanupExpired(): Promise<number> {
  const ts = now();

  const expired = await query<{ id: string }>(
    'SELECT id FROM sessions WHERE expires_at <= ? LIMIT 500',
    [ts],
  );
  if (expired.length === 0) return 0;

  const ids = expired.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  await execute(`DELETE FROM log_bodies WHERE session_id IN (${placeholders})`, ids);
  await execute(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids);
  const r = await execute(`DELETE FROM sessions WHERE id IN (${placeholders})`, ids);

  return r.affectedRows;
}

/** 统计（诊断用） */
export async function sessionStats(): Promise<{
  sessions: number;
  messages: number;
  expired: number;
}> {
  const [s, m, e] = await Promise.all([
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM messages'),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?', [now()]),
  ]);
  return {
    sessions: Number(s?.n ?? 0),
    messages: Number(m?.n ?? 0),
    expired: Number(e?.n ?? 0),
  };
}
