/**
 * MariaDB 连接池。
 *
 * ## 为什么用 mysql2 而不是等 Node 内置
 *
 * Node 24 没有 MySQL 驱动。`mysql2` 是纯 JS（无原生编译），Termux/Android 可直接用，
 * 且支持 Promise API 与预处理语句。
 *
 * ## 连接不可用时的行为
 *
 * **与任何数据库服务一样**：调用方收到错误，接口返回 5xx 并记错误日志。
 * 不做内存兜底、不做静默降级——那样会把「库挂了」伪装成「一切正常」，
 * 用户的数据却在丢失。内存实现只用于测试。
 */

import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';

import { db as cfg } from '../config.ts';

let pool: Pool | null = null;

/** 取连接池（惰性创建）。未配置 `DB_HOST` 时抛错，由调用方决定如何呈现。 */
export function getPool(): Pool {
  if (pool !== null) return pool;

  if (!cfg.enabled) {
    throw new Error(
      '未配置 MariaDB（DB_HOST 为空）。本服务的会话、日志、分析记录都存在 MariaDB，' +
        '请先配置 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME。',
    );
  }

  pool = createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connectionLimit,
    // 时区统一用 UTC：库里存的是秒级时间戳（BIGINT），但 DATE 字段仍要一致
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    // 大日志正文：MEDIUMTEXT 上限 16MB，这里不额外限制
    multipleStatements: false,
  });

  return pool;
}

/**
 * 查询多行。
 *
 * 不约束成 mysql2 的 `RowDataPacket`：那个接口要求一个 `constructor.name` 的字面量
 * 类型，调用方每定义一个行接口都要继承它，徒增噪音。这里用 `Record` 约束，
 * 由调用方声明行形状（SQL 是手写的，本来也没法从类型反推）。
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

/** 查询单行 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * 执行写操作，返回受影响行数与插入 ID。
 *
 * 参数用 `any[]` 而不是 `unknown[]`：mysql2 的 `execute` 只接受
 * `ExecuteValues`（`string | number | bigint | boolean | Date | Buffer | null`），
 * 而 `unknown[]` 无法赋给它。这里在边界处放开，由调用方保证参数类型
 * （所有调用点传的都是标量或 null）。
 */
export async function execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

/**
 * 在事务里执行。
 *
 * 用于「插会话 + 插主日志」这类必须原子完成的操作：半途失败时若只写了一半，
 * 会留下没有正文的会话，用户点进去看到空页面而不知道为什么。
 */
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try {
      await conn.rollback();
    } catch {
      /* 回滚失败不掩盖原始错误 */
    }
    throw e;
  } finally {
    conn.release();
  }
}

/** 健康探测：`SELECT 1` */
export async function ping(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** 关闭连接池（优雅退出 / 测试） */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  const p = pool;
  pool = null;
  try {
    await p.end();
  } catch {
    /* 关闭失败不阻断退出 */
  }
}

/** 仅供测试：注入一个已构造的池（或置 null 重置） */
export function setPoolForTest(p: Pool | null): void {
  pool = p;
}
