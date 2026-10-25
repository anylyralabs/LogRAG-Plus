/**
 * 把旧 SQLite 业务库（`data/app.db`）搬到 MariaDB。
 *
 * ## 搬什么、不搬什么
 *
 * | 表 | 搬 | 原因 |
 * |---|---|---|
 * | `domain_knowledge` | 是 | 人工维护的先验知识，重建成本最高 |
 * | `domain_knowledge_audit` | 是 | 与条目配套的变更审计 |
 * | `analysis_records` | 是 | 评分看板与回归集的原料 |
 * | `sessions` / `messages` | 否 | 48 小时 TTL，旧数据基本已过期；且 native 会话的正文不在 SQLite 里 |
 *
 * ## 为什么直接按列名搬运
 *
 * MariaDB 的表结构是照着 SQLite 版**逐字段对应**建的（见 `src/store/migrate.ts`
 * 的 004/005），字段名一个都没改。于是这里不需要映射表，只需要逐行 INSERT。
 *
 * ## 幂等
 *
 * 用 `ON DUPLICATE KEY UPDATE`：同一份 SQLite 文件跑两次结果一致，
 * 迁移中断后可以直接重跑，不必先清表。
 *
 * 用法：
 * ```bash
 * npx tsx scripts/migrate_sqlite_to_mariadb.ts [--sqlite data/app.db] [--dry-run]
 * ```
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../src/store/migrate.ts';
import { closePool, execute, query } from '../src/store/mysql.ts';

interface Options {
  sqlitePath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  let sqlitePath = 'data/app.db';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sqlite') {
      const v = argv[++i];
      if (v === undefined || v === '') throw new Error('--sqlite 需要一个路径');
      sqlitePath = v;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      console.log('用法: npx tsx scripts/migrate_sqlite_to_mariadb.ts [--sqlite data/app.db] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }

  return { sqlitePath: resolve(sqlitePath), dryRun };
}

/** 读一张表，SQLite 的行是普通对象 */
function readAll(sqlite: DatabaseSync, table: string): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
}

/** 按列名生成 INSERT ... ON DUPLICATE KEY UPDATE */
async function upsert(
  table: string,
  rows: Array<Record<string, unknown>>,
  options: { skipColumns?: string[] } = {},
): Promise<number> {
  const skip = new Set(options.skipColumns ?? []);
  let n = 0;

  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => !skip.has(c));
    if (cols.length === 0) continue;

    const placeholders = cols.map(() => '?').join(', ');
    const updates = cols
      .filter((c) => c !== 'id')
      .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');

    await execute(
      `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')})
       VALUES (${placeholders})
       ${updates === '' ? '' : `ON DUPLICATE KEY UPDATE ${updates}`}`,
      cols.map((c) => row[c] ?? null),
    );
    n++;
  }

  return n;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.sqlitePath)) {
    throw new Error(`找不到 SQLite 文件：${opts.sqlitePath}`);
  }

  const sqlite = new DatabaseSync(opts.sqlitePath, { readOnly: true });

  // 先确认表存在，避免拿到一个不相干的 SQLite 文件却「迁移成功 0 条」
  const tables = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  for (const t of ['domain_knowledge', 'analysis_records']) {
    if (!tables.has(t)) throw new Error(`SQLite 里缺少表 ${t}，这不像 LogRAG+ 的业务库`);
  }

  const domain = readAll(sqlite, 'domain_knowledge');
  const audit = tables.has('domain_knowledge_audit') ? readAll(sqlite, 'domain_knowledge_audit') : [];
  const records = readAll(sqlite, 'analysis_records');

  console.log(`源：${opts.sqlitePath}`);
  console.log(`  domain_knowledge        ${domain.length} 条`);
  console.log(`  domain_knowledge_audit  ${audit.length} 条`);
  console.log(`  analysis_records        ${records.length} 条`);

  if (opts.dryRun) {
    console.log('\n--dry-run：不写入。');
    sqlite.close();
    return;
  }

  // 迁移前先建表：脚本可以在全新的库上直接跑
  const applied = await migrate();
  if (applied.applied.length > 0) {
    console.log(`\n建表：应用 ${applied.applied.length} 项迁移`);
  }

  const nDomain = await upsert('domain_knowledge', domain);
  // 审计表的 id 是自增主键，旧 id 不搬（搬了会与既有记录冲突，且 id 无业务含义）
  const nAudit = await upsert('domain_knowledge_audit', audit, { skipColumns: ['id'] });
  const nRecords = await upsert('analysis_records', records);

  console.log(`\n已写入：domain=${nDomain} audit=${nAudit} records=${nRecords}`);

  // 回读计数：以**库里的事实**收尾，而不是相信上面的循环次数
  const counts = await query<{ t: string; n: number }>(
    `SELECT 'domain_knowledge' AS t, COUNT(*) AS n FROM domain_knowledge
     UNION ALL SELECT 'domain_knowledge_audit', COUNT(*) FROM domain_knowledge_audit
     UNION ALL SELECT 'analysis_records', COUNT(*) FROM analysis_records`,
  );
  for (const c of counts) console.log(`  ${c.t} 现有 ${c.n} 条`);

  sqlite.close();
}

main()
  .catch((e: unknown) => {
    console.error(`迁移失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
