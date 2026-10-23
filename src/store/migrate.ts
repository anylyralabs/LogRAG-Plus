/**
 * 数据库迁移。
 *
 * ## 为什么自己写而不引 knex / drizzle
 *
 * 只有十来个表、结构稳定、迁移是单向追加。引入 ORM 会带来一整套类型映射与
 * 查询构造器，而本项目所有查询都是手写 SQL（日志正文是大文本，ORM 反而碍事）。
 * 自己写的迁移器只有一件事要保证：**幂等**。
 *
 * ## 幂等
 *
 * 用 `lograg_migrations` 记账：每个迁移只跑一次。但**建表语句本身也写成
 * `IF NOT EXISTS`**——因为测试会反复在同一个库上跑，且运维可能手工执行过 DDL。
 * 记账表只用于跳过已完成的迁移，不能代替幂等。
 */

import { execute, getPool, query } from './mysql.ts';

interface Migration {
  name: string;
  /** 按顺序执行的语句；每条都必须可重复执行 */
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_sessions',
    statements: [
      `CREATE TABLE IF NOT EXISTS sessions (
        id          VARCHAR(32)  NOT NULL,
        owner       VARCHAR(64)  NULL,
        log_kind    ENUM('native','logshare') NOT NULL DEFAULT 'native',
        log_ref     VARCHAR(16)  NULL,
        created_at  BIGINT       NOT NULL,
        updated_at  BIGINT       NOT NULL,
        expires_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_sessions_owner_log (owner, log_kind, log_ref),
        KEY idx_sessions_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    name: '002_messages',
    statements: [
      `CREATE TABLE IF NOT EXISTS messages (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        session_id  VARCHAR(32)  NOT NULL,
        role        ENUM('user','assistant') NOT NULL,
        content     MEDIUMTEXT   NOT NULL,
        reasoning   MEDIUMTEXT   NULL,
        score       JSON         NULL,
        meta        JSON         NULL,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_messages_session (session_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    name: '003_log_bodies',
    statements: [
      /*
       * 主日志与追加段。
       *
       * `seq = 0` 是主日志，`1..n` 是追加段。**追加只是插入一行**，
       * 不重写已有正文——这样「补一份日志」不会带来整篇重写与并发覆盖。
       *
       * `kind='logshare'` 的会话只在这里存追加段（seq >= 1），基础正文现取。
       */
      `CREATE TABLE IF NOT EXISTS log_bodies (
        session_id  VARCHAR(32)  NOT NULL,
        seq         INT          NOT NULL,
        content     MEDIUMTEXT   NOT NULL,
        files       JSON         NULL,
        source      VARCHAR(64)  NULL,
        bytes       INT          NOT NULL DEFAULT 0,
        line_count  INT          NOT NULL DEFAULT 0,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    name: '004_analysis_records',
    statements: [
      /*
       * 与 SQLite 版**逐字段对应**（字段名不改）：迁移脚本按列名搬运，
       * 改名会让「旧数据搬过来」变成一次手工映射，容易漏字段。
       * 唯一的变化是类型：`TEXT` 存 JSON 的列改为 `JSON`，整数 `INTEGER` → `INT`。
       */
      `CREATE TABLE IF NOT EXISTS analysis_records (
        id               VARCHAR(64)  NOT NULL,
        created          BIGINT       NOT NULL,
        session_id       VARCHAR(32)  NOT NULL,
        log_id           VARCHAR(32)  NULL,
        provider         VARCHAR(64)  NOT NULL,
        model            VARCHAR(64)  NOT NULL,
        overall          INT          NOT NULL,
        deliverable      TINYINT(1)   NOT NULL,
        grounding        INT          NULL,
        verification     INT          NOT NULL,
        actionability    INT          NOT NULL,
        economy          INT          NOT NULL,
        rounds           INT          NOT NULL,
        tool_calls       INT          NOT NULL,
        empty_calls      INT          NOT NULL,
        failed_calls     INT          NOT NULL,
        tool_names       TEXT         NOT NULL,
        root_cause       TEXT         NOT NULL,
        confidence       DOUBLE       NULL,
        evidence_count   INT          NOT NULL,
        steps_count      INT          NOT NULL,
        grounding_recall DOUBLE       NULL,
        deductions       TEXT         NOT NULL,
        missing_anchors  TEXT         NOT NULL,
        answer_chars     INT          NOT NULL,
        PRIMARY KEY (id),
        KEY idx_analysis_created (created),
        KEY idx_analysis_overall (overall),
        KEY idx_analysis_log (log_id),
        KEY idx_analysis_model (model)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    name: '005_domain_knowledge',
    statements: [
      `CREATE TABLE IF NOT EXISTS domain_knowledge (
        id          VARCHAR(32)  NOT NULL,
        content     TEXT         NOT NULL,
        enabled     TINYINT(1)   NOT NULL DEFAULT 1,
        priority    INT          NOT NULL DEFAULT 0,
        tags        TEXT         NOT NULL,
        kind        VARCHAR(16)  NOT NULL DEFAULT 'unclear',
        created_at  BIGINT       NOT NULL,
        updated_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_dk_enabled (enabled, priority)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS domain_knowledge_audit (
        id             BIGINT      NOT NULL AUTO_INCREMENT,
        entry_id       VARCHAR(32) NOT NULL,
        action         VARCHAR(16) NOT NULL,
        before_content TEXT        NULL,
        after_content  TEXT        NULL,
        actor          VARCHAR(64) NOT NULL DEFAULT '',
        at             BIGINT      NOT NULL,
        PRIMARY KEY (id),
        KEY idx_dka_at (at),
        KEY idx_dka_entry (entry_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
];

/** 建记账表（必须最先执行，且本身幂等） */
async function ensureLedger(): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS lograg_migrations (
      name        VARCHAR(64) NOT NULL,
      applied_at  BIGINT      NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

/**
 * 执行所有未应用的迁移。
 *
 * 失败时抛错——迁移失败意味着表结构不完整，服务不该带着半截 schema 继续跑。
 */
export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  // 触发一次连接（配置缺失时在这里就报清楚，而不是等到第一次查询）
  getPool();
  await ensureLedger();

  const done = new Set(
    (await query<{ name: string }>('SELECT name FROM lograg_migrations')).map((r) => r.name),
  );

  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;

    /*
     * 先执行 DDL、**全部成功之后**才记账。
     *
     * 这里踩过一个坑：最初是「执行 → 记账」逐条写，但 DDL 在 MariaDB 里
     * 是**隐式提交**的，不能包进事务；一旦某个迁移中途失败（例如用了保留字
     * `lines` 作列名），已执行的那部分不会回滚，而记账也没写——下次重跑
     * `CREATE TABLE IF NOT EXISTS` 会跳过、但缺的列补不上。
     *
     * 更糟的是当时观察到「001/002 已记账但表结构是错的」：记账写在了
     * 循环外，失败前先写了记录。所以顺序必须是「先做完、后记账」，
     * 且记账失败要让整个迁移失败（否则下次会重复执行）。
     */
    for (const sql of m.statements) {
      await execute(sql);
    }
    await execute('INSERT INTO lograg_migrations (name, applied_at) VALUES (?, ?)', [
      m.name,
      Math.floor(Date.now() / 1000),
    ]);
    applied.push(m.name);
  }

  return { applied, skipped: done.size };
}

/** 供测试与诊断：已应用的迁移名 */
export async function appliedMigrations(): Promise<string[]> {
  const rows = await query<{ name: string }>('SELECT name FROM lograg_migrations ORDER BY name');
  return rows.map((r) => r.name);
}

/** 迁移清单（供测试断言表结构齐全） */
export function migrationNames(): string[] {
  return MIGRATIONS.map((m) => m.name);
}
