/**
 * SQLite 连接与迁移注册中心。
 *
 * ## 为什么要有这一层
 * 本服务有状态数据都在 SQLite（会话、领域知识、分析记录……）。
 * 若每个模块各自 `new DatabaseSync(...)`，会得到多个连接与多套建表逻辑：
 *  - 同名表在不同模块里重复定义，列定义迟早漂移；
 *  - 每个连接各占一份 WAL 与文件句柄，进程内平白多出若干 fd；
 *  - 事务无法跨模块（例如「记录一次分析」与「更新会话轮次」应在一个事务里）。
 *
 * 因此由本模块持有**唯一连接**，各模块只注册自己的建表语句。
 *
 * ## 迁移为什么是「惰性补齐」而不是「启动时跑一遍」
 * 模块是按需 `import` 的：`eval/records.ts` 可能直到第一次分析结束才被加载。
 * 若在进程启动时统一执行迁移，晚加载的模块的表就不会被创建。
 * 因此每次 `getDb()` 都补齐尚未执行的迁移——已执行过的用集合记住，`IF NOT EXISTS`
 * 保证 DDL 本身幂等，代价只是一次 Set 查询。
 *
 * ## 为什么用 SQLite 而不是 Redis
 * LogShare 把 Redis 当**可选依赖**（`cache.enabled` 可关、failOpen 降级）。
 * 本服务若把持久状态放 Redis，就等于引入一个新的硬依赖；且 Redis 常配
 * maxmemory-policy 淘汰，不适合放不可再生数据。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { storage } from '../config.ts';

let db: DatabaseSync | null = null;

interface Migration {
  name: string;
  run: (conn: DatabaseSync) => void;
}

const migrations: Migration[] = [];

/**
 * 「已执行迁移」按**连接**记账，不能按进程。
 *
 * 测试会 `closeDb()` 后换一个库文件 `initDb(newPath)`；若用进程级集合记账，
 * 新库文件里就会**一张表都不建**（迁移全被判定为「已执行」）——这是一个只在
 * 换库路径上出现的静默失败。按连接记账则可兼顾两件事：
 *  - 新连接：集合为空 → 全部迁移重放（`IF NOT EXISTS` 保证幂等）；
 *  - 同一连接：只补跑「后来才注册」的迁移（惰性加载的模块）。
 *
 * 用 WeakMap 以免连接对象无法回收（连接关闭后应可被 GC）。
 */
const appliedByConn = new WeakMap<DatabaseSync, Set<string>>();

/**
 * 注册一个迁移。
 *
 * 应在模块顶层调用（模块被 import 时立即注册）。
 * `name` 必须全局唯一且**永不变更**——它同时是「是否已执行」的判据。
 * DDL 必须自幂等（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），
 * 因为同一个迁移可能在多个连接上重放（测试会换库文件）。
 */
export function registerMigration(name: string, run: (conn: DatabaseSync) => void): void {
  migrations.push({ name, run });
}

/** 补齐尚未执行的迁移（按连接记账） */
function ensureMigrations(conn: DatabaseSync): void {
  let done = appliedByConn.get(conn);
  if (done === undefined) {
    done = new Set<string>();
    appliedByConn.set(conn, done);
  }

  for (const m of migrations) {
    if (done.has(m.name)) continue;
    m.run(conn);
    done.add(m.name);
  }
}

/**
 * 初始化数据库（进程级单例）。
 *
 * 传入 `dbPath` 可指定库文件（测试用）；省略时用 `storage.dataDir/app.db`。
 * **已是单例时忽略新路径**——要换库请先 `closeDb()`。
 */
export function initDb(dbPath?: string): DatabaseSync {
  if (db !== null) {
    ensureMigrations(db);
    return db;
  }

  const path = dbPath ?? `${storage.dataDir}/app.db`;
  mkdirSync(dirname(path), { recursive: true });

  const conn = new DatabaseSync(path);

  // WAL：读写不互斥，适合「写少读多 + 长连接」的服务进程
  conn.exec('PRAGMA journal_mode = WAL');
  // 外键约束：会话→消息的级联删除依赖它（默认是关的）
  conn.exec('PRAGMA foreign_keys = ON');
  // 崩溃安全与并发的折中：NORMAL 在 WAL 下不会丢已提交事务
  conn.exec('PRAGMA synchronous = NORMAL');
  // 等锁而非立刻抛 SQLITE_BUSY（多副本/多进程访问同一库文件时必要）
  conn.exec('PRAGMA busy_timeout = 5000');

  db = conn;
  ensureMigrations(conn);
  return conn;
}

/** 取连接（惰性初始化，并补齐迁移） */
export function getDb(): DatabaseSync {
  return db ?? initDb();
}

/** 关闭连接（供测试与优雅退出） */
export function closeDb(): void {
  if (db === null) return;
  try {
    db.close();
  } catch {
    // 已关闭或连接损坏：忽略——关闭失败不应阻断进程退出
  }
  db = null;
}

/** 是否已初始化（供健康检查） */
export function isDbReady(): boolean {
  return db !== null;
}

/**
 * 把一组写操作包进事务。
 *
 * node:sqlite 的 `DatabaseSync` 没有 promise 化的 `transaction()` 包装，
 * 手写 BEGIN/COMMIT/ROLLBACK 容易在异常路径漏掉回滚。
 */
export function withTransaction<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // 回滚失败说明连接已不可用，原始异常更重要，继续向上抛
    }
    throw e;
  }
}
