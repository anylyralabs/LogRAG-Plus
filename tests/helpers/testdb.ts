/**
 * 测试用的 MariaDB 隔离库。
 *
 * ## 为什么每个测试文件一个库
 *
 * 原先测试用「每个用例一个临时 SQLite 文件」隔离。换到 MariaDB 后，
 * 最接近的等价物是**每个测试文件一个独立数据库**：`CREATE DATABASE lograg_test_<随机>`，
 * 用完 `DROP`。比「清表」干净——清表要处理外键顺序与自增重置，
 * 而建库/删库没有这些顾虑。
 *
 * ## 前置条件
 *
 * 需要一个能建库的账号。默认复用 `.env` 里的 `DB_USER`；若它只有单库权限，
 * 用 `TEST_DB_ADMIN_USER` / `TEST_DB_ADMIN_PASSWORD` 指定管理员账号。
 *
 * 库不可用时**跳过依赖库的测试**，不让整个套件红——本地没起 MariaDB 是常态，
 * 而「跳过」比「假绿」诚实：report 里能看到 skipped 计数。
 */

import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';

export interface TestDb {
  /** 本测试专属的库名 */
  name: string;
  /** 是否成功建库（false 时调用方应 skip） */
  ok: boolean;
  /** 不可用的原因 */
  reason?: string;
  /** 删除该库并断开 */
  dispose: () => Promise<void>;
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

/**
 * 建一个隔离库，并用它覆盖 `DB_NAME`。
 *
 * 必须在**导入被测模块之前**调用——`src/config.ts` 在模块加载时读环境变量。
 */
export async function createTestDb(): Promise<TestDb> {
  const host = env('DB_HOST', '127.0.0.1');
  const port = Number(env('DB_PORT', '3306'));
  const user = env('TEST_DB_ADMIN_USER', env('DB_USER', 'root'));
  const password = env('TEST_DB_ADMIN_PASSWORD', env('DB_PASSWORD', ''));
  const name = `lograg_test_${randomBytes(4).toString('hex')}`;

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
    await conn.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    // 让被测模块连到这个库
    process.env['DB_HOST'] = host;
    process.env['DB_PORT'] = String(port);
    process.env['DB_USER'] = user;
    process.env['DB_PASSWORD'] = password;
    process.env['DB_NAME'] = name;

    const admin = conn;
    return {
      name,
      ok: true,
      dispose: async () => {
        try {
          await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        } catch {
          /* 删库失败不阻断测试收尾 */
        }
        try {
          await admin.end();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    try {
      await conn?.end();
    } catch {
      /* ignore */
    }
    return {
      name,
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      dispose: async () => undefined,
    };
  }
}
