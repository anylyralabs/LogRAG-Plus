/**
 * 会话存储（SQLite）。
 *
 * ## 保留期策略
 * | 来源 | 保留期 |
 * |---|---|
 * | 独立发起（无 LogShare ID） | 48 小时 |
 * | 携带 LogShare 日志 ID | 跟随日志 TTL（由调用方传入 `expiresAt`） |
 *
 * ## 为什么用 SQLite 而非 Redis
 * LogShare 把 Redis 当**可选依赖**（`cache.enabled` 可关、`failOpen` 降级）。
 * 本服务若把会话存 Redis，就引入了一个新的硬依赖，且会话是有状态数据，
 * 不适合放在可被清空的缓存里（Redis 常配 maxmemory-policy 淘汰）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { storage } from '../config.ts';
import { checkSessionRounds } from '../quota/limiter.ts';
import { closeDb, getDb, initDb, registerMigration } from './db.ts';

export interface Session {
  id: string;
  /** 关联的 LogShare 日志 ID（可空） */
  logId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 过期时间（秒级时间戳） */
  expiresAt: number;
}

export interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思维链（仅 assistant） */
  reasoning: string | null;
  createdAt: number;
}

/**
 * 会话与消息的表结构。
 *
 * 迁移在模块顶层注册，由 `store/db.ts` 在首次 `getDb()` 时补齐。
 */
registerMigration('001_sessions_and_messages', (conn) => {
  conn.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    log_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);

  conn.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    created_at INTEGER NOT NULL
  )`);

  conn.exec('CREATE INDEX IF NOT EXISTS idx_sessions_log_id ON sessions(log_id)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)');
});

/**
 * 初始化存储。
 *
 * 保留此名与 `closeStore` 是为了不破坏既有调用方与测试；
 * 实际的连接与迁移逻辑已收敛到 `store/db.ts`。
 */
export function initStore(dbPath?: string): DatabaseSync {
  return initDb(dbPath);
}

/** 生成会话 ID */
function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认 TTL（秒） */
function defaultTtlSeconds(): number {
  return storage.sessionTtlHours * 3600;
}

/**
 * 查找或创建会话。
 *
 * 若传了 `logId`：
 *  - 已有该 logId 的未过期会话 → 复用（同一日志不重复建会话）
 *  - 否则新建，TTL 由调用方指定（跟随日志 TTL）
 */
export function findOrCreateSession(logId: string | null, ttlSeconds?: number): Session {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);

  if (logId !== null && logId !== '') {
    const existing = conn
      .prepare('SELECT * FROM sessions WHERE log_id = ? AND expires_at > ? ORDER BY updated_at DESC LIMIT 1')
      .get(logId, now) as
      | { id: string; log_id: string | null; created_at: number; updated_at: number; expires_at: number }
      | undefined;

    if (existing !== undefined) {
      return {
        id: existing.id,
        logId: existing.log_id,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
        expiresAt: existing.expires_at,
      };
    }
  }

  const id = newSessionId();
  const ttl = ttlSeconds ?? defaultTtlSeconds();
  const expiresAt = now + ttl;

  conn
    .prepare('INSERT INTO sessions (id, log_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, logId, now, now, expiresAt);

  return {
    id,
    logId,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };
}

/** 按 ID 取会话（自动过滤已过期） */
export function getSession(sessionId: string): Session | null {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = conn
    .prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
    .get(sessionId, now) as
    | { id: string; log_id: string | null; created_at: number; updated_at: number; expires_at: number }
    | undefined;

  if (row === undefined) return null;

  return {
    id: row.id,
    logId: row.log_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** 追加消息 */
export function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  reasoning?: string,
): void {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);

  conn
    .prepare('INSERT INTO messages (session_id, role, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, reasoning ?? null, now);

  conn.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
}

/**
 * 取会话历史（供模型上下文）。
 *
 * @param limit 最多返回多少条（默认 20——控制 token 消耗）
 */
export function getHistory(sessionId: string, limit = 20): Message[] {
  const conn = getDb();

  const rows = conn
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionId, limit) as Array<{
    id: number;
    session_id: string;
    role: string;
    content: string;
    reasoning: string | null;
    created_at: number;
  }>;

  // 反转为时间正序
  return rows.reverse().map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    reasoning: r.reasoning,
    createdAt: r.created_at,
  }));
}

/** 会话轮次（用户消息数） */
export function countRounds(sessionId: string): number {
  const conn = getDb();
  const row = conn
    .prepare("SELECT count(*) AS n FROM messages WHERE session_id = ? AND role = 'user'")
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 检查会话是否还能继续（轮次上限）。
 *
 * 每会话轮次上限由配置控制（默认 10）；达到上限后应提示用户开新会话，
 * 而不是让上下文无限增长（token 成本与模型注意力都会劣化）。
 *
 * 判据委托给 `quota/limiter.ts::checkSessionRounds`——此前这里与那里各实现了
 * 一份上限判定（一份读环境变量、一份读配置），属重复且易漂移。现由 quota 持有
 * 唯一口径（纯函数：传入已用轮次，返回是否还允许）。
 *
 * 附带修掉一个隐患：原实现用 `Number(process.env.X ?? 10)`，若环境变量被设成
 * 非数字会得到 `NaN`，使 `used < NaN` 恒为 false —— 会话被**永久锁死**。
 * 配置层的 `envInt` 会把非法值回落到默认值，不会出现该情况。
 */
export function checkRoundsAllowed(sessionId: string): { allowed: boolean; remaining: number } {
  return checkSessionRounds(countRounds(sessionId));
}

/** 会话保留期（秒）：携带 logId 时跟随日志 TTL */
export function sessionTtlSeconds(logId: string | null): number {
  if (logId !== null && logId !== '') {
    // 跟随日志 TTL（LogShare 默认 7 天，可由 STORAGE_TIME 覆盖）
    const storageTime = Number(process.env.STORAGE_TIME ?? 0);
    return storageTime > 0 ? storageTime : 7 * 24 * 3600;
  }
  return storage.sessionTtlHours * 3600;
}

/** 清理过期会话（返回删除数） */
export function cleanupExpired(): number {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);
  const info = conn.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return Number(info.changes);
}

/** 供测试关闭（保留原名，委托给共享连接层） */
export function closeStore(): void {
  closeDb();
}
