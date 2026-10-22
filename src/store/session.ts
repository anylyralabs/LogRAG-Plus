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
  /**
   * 会话归属（匿名主体：指纹优先、IP+UA 兜底）。
   *
   * 为什么必须有：日志 ID 是**公开的**（就在 URL 里）。若按 logId 复用会话，
   * 任何打开同一份日志的人都会进入同一个会话——既会看到别人的追问上下文，
   * 也会消耗别人的轮次。会话本身仍是「知道 ID 即可回放」的 bearer 语义
   * （无登录产品要支持换设备），但**自动复用**必须限定在同一主体内。
   *
   * 旧数据为 null：不参与自动复用，显式 sessionId 回放仍可用。
   */
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  /** 过期时间（秒级时间戳） */
  expiresAt: number;
}

/**
 * 随消息持久化的自评摘要。
 *
 * 只存界面需要的字段，不存评分器的内部明细（`groundingDetail.claims` 等）：
 * 回溯时要回答的是「这次分析当时得了多少分、哪些引用没核对上」，
 * 而不是重算一遍评分。完整明细仍在 `analysis_records` 表里。
 */
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

export interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思维链（仅 assistant） */
  reasoning: string | null;
  /** 自评摘要（仅 assistant；旧消息可能为 null） */
  score: MessageScore | null;
  /**
   * 结构化附加信息（仅 assistant）。
   *
   * 目前承载 `ask_user` 的追问清单。为什么必须落库：追问是**用户要回答的东西**，
   * 只留在 SSE 帧里或正文中，刷新后就无法再作答——这等于把「AI 反问你」变成了
   * 一次性提示。
   */
  meta: MessageMeta | null;
  createdAt: number;
}

/** assistant 消息的结构化附加信息 */
export interface MessageMeta {
  /** 本轮模型发起的追问（可能多次） */
  asks?: Array<{ questions: string[]; reason?: string }>;
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
 * 给 messages 补 `score` 列。
 *
 * 为什么不是改 001：已部署的库不会重放 001（迁移按名记账，且建表是
 * `IF NOT EXISTS`），直接改 001 会让老库永远缺这一列。新库则先建表、
 * 再由本迁移补列，两条路径都得到同一结构。
 *
 * SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS`，因此先看
 * `PRAGMA table_info` 再决定——迁移本身仍必须幂等（测试会换库重放）。
 */
registerMigration('002_messages_score', (conn) => {
  const cols = conn.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'score')) return;
  conn.exec('ALTER TABLE messages ADD COLUMN score TEXT');
});

/**
 * 给 sessions 补 `owner` 列。
 *
 * 修的是一个隐私缺陷：日志 ID 公开可得，按 logId 复用会话会让**所有访客**
 * 进入同一个会话（看到彼此的追问、共享轮次额度）。加上归属后，自动复用
 * 只发生在同一匿名主体内；显式 sessionId 仍可跨设备回放（bearer 语义，
 * 无登录产品的必要取舍）。
 *
 * 旧数据 owner 为 NULL：不参与自动复用，显式 sessionId 回放照常。
 */
registerMigration('003_sessions_owner', (conn) => {
  const cols = conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'owner')) return;
  conn.exec('ALTER TABLE sessions ADD COLUMN owner TEXT');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner_log ON sessions(owner, log_id)');
});

/**
 * 给 messages 补 `meta` 列（结构化附加信息）。
 *
 * 首个用途是 `ask_user` 的追问清单。追问落库才有「刷新后仍能回答」的可能：
 * 它需要同时具备问题文本与「这是第几轮问的」两个信息，塞进正文既不可解析，
 * 也会污染模型后续读到的历史。
 */
registerMigration('004_messages_meta', (conn) => {
  const cols = conn.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'meta')) return;
  conn.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
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
 * 解析落库的自评 JSON。
 *
 * 坏数据按 `null` 处理而不是抛出：一条旧消息的评分损坏不应让整个
 * 会话回放接口 500——界面缺一个自检面板，比打不开对话好得多。
 */
function parseMessageScore(raw: string | null): MessageScore | null {
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<MessageScore>;
    if (typeof v.overall !== 'number' || typeof v.deliverable !== 'boolean') return null;
    const d = v.dimensions;
    return {
      overall: v.overall,
      deliverable: v.deliverable,
      dimensions: {
        grounding: typeof d?.grounding === 'number' ? d.grounding : null,
        verification: typeof d?.verification === 'number' ? d.verification : 0,
        actionability: typeof d?.actionability === 'number' ? d.actionability : 0,
        economy: typeof d?.economy === 'number' ? d.economy : 0,
      },
      deductions: Array.isArray(v.deductions)
        ? v.deductions.filter((s): s is string => typeof s === 'string')
        : [],
      missingAnchors: Array.isArray(v.missingAnchors)
        ? v.missingAnchors.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * 查找或创建会话。
 *
 * 若传了 `logId` 且给了 `owner`：
 *  - 同一主体在该日志下已有未过期会话 → 复用（同一日志不重复建会话）
 *  - 否则新建，TTL 由调用方指定（跟随日志 TTL）
 *
 * ## 为什么复用必须带 owner
 * 日志 ID 就在 URL 里，任何拿到它的人都能打开同一份日志。若只按 logId 复用，
 * 两个陌生访客会进入同一个会话：能看到彼此的追问内容，还会互相消耗轮次额度。
 * 这是实测暴露的问题——两台设备打开同一个 logId，拿到了同一个 sessionId。
 *
 * `owner` 为空时**不复用**（旧数据或调用方未提供归属），宁可多建一个会话，
 * 也不要把两个人拼到一起。
 */
export function findOrCreateSession(
  logId: string | null,
  ttlSeconds?: number,
  owner?: string,
): Session {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);
  const ownerKey = owner !== undefined && owner !== '' ? owner : null;

  if (logId !== null && logId !== '' && ownerKey !== null) {
    const existing = conn
      .prepare(
        'SELECT * FROM sessions WHERE log_id = ? AND owner = ? AND expires_at > ? ORDER BY updated_at DESC LIMIT 1',
      )
      .get(logId, ownerKey, now) as
      | {
          id: string;
          log_id: string | null;
          owner: string | null;
          created_at: number;
          updated_at: number;
          expires_at: number;
        }
      | undefined;

    if (existing !== undefined) {
      return {
        id: existing.id,
        logId: existing.log_id,
        owner: existing.owner,
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
    .prepare(
      'INSERT INTO sessions (id, log_id, owner, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, logId, ownerKey, now, now, expiresAt);

  return {
    id,
    logId,
    owner: ownerKey,
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
    | {
        id: string;
        log_id: string | null;
        owner: string | null;
        created_at: number;
        updated_at: number;
        expires_at: number;
      }
    | undefined;

  if (row === undefined) return null;

  return {
    id: row.id,
    logId: row.log_id,
    owner: row.owner,
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
  score?: MessageScore,
  meta?: MessageMeta,
): void {
  const conn = getDb();
  const now = Math.floor(Date.now() / 1000);

  conn
    .prepare(
      'INSERT INTO messages (session_id, role, content, reasoning, score, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      role,
      content,
      reasoning ?? null,
      score === undefined ? null : JSON.stringify(score),
      meta === undefined ? null : JSON.stringify(meta),
      now,
    );

  conn.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
}

/**
 * 解析落库的结构化附加信息。
 *
 * 与评分一样按「坏数据当没有」处理：一条旧消息的 meta 损坏不应让整个会话
 * 回放失败。只保留认识的字段，避免把任意 JSON 透传给前端。
 */
function parseMessageMeta(raw: string | null): MessageMeta | null {
  if (raw === null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as { asks?: unknown };
    if (!Array.isArray(v.asks)) return null;
    const asks = v.asks
      .map((item) => {
        if (item === null || typeof item !== 'object') return null;
        const rec = item as { questions?: unknown; reason?: unknown };
        const questions = Array.isArray(rec.questions)
          ? rec.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
          : [];
        if (questions.length === 0) return null;
        return {
          questions,
          ...(typeof rec.reason === 'string' && rec.reason !== '' ? { reason: rec.reason } : {}),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return asks.length === 0 ? null : { asks };
  } catch {
    return null;
  }
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
    score: string | null;
    meta: string | null;
    created_at: number;
  }>;

  // 反转为时间正序
  return rows.reverse().map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    reasoning: r.reasoning,
    score: parseMessageScore(r.score),
    meta: parseMessageMeta(r.meta),
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
