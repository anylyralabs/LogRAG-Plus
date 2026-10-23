/**
 * 运行配置：全部来自环境变量，无配置文件依赖（便于容器化与本地开发）。
 *
 * 设计原则（对齐设计文档 §3.2 数据边界）：
 *  - LogShare 是唯一数据拥有者 → 本服务对 MariaDB 只读
 *  - 会话/上传副本归本服务 → 自有 SQLite
 *  - RAG 索引只读挂载 → node:sqlite 直读
 *
 * ## 关于 `.env`
 *
 * 本地开发时读**工作目录**下的 `.env`（即「从项目根启动」这一约定，见 `dotEnvPath()`）。
 * **不覆盖已存在的环境变量**——
 * 这一点是刻意的，有两个理由：
 *  1. 容器/CI 注入的变量优先于文件，符合 12-factor；
 *  2. 测试在文件顶部直接设 `process.env`，若让 `.env` 覆盖，测试会被本机
 *     开发配置污染（「测试读了我的本地模型 key」这类问题极难排查）。
 *
 * 不用 `process.loadEnvFile()` 是因为它「是否覆盖已存在变量」的语义随 Node
 * 版本变动过；这里用显式实现，行为不依赖运行时的版本差异。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 是否运行在测试进程中。
 *
 * Node 的测试运行器会给子进程设 `NODE_TEST_CONTEXT`（实测值 `child-v8`）；
 * `node --test` 时 argv 里也会有 `--test`（视调用形式而定，故两者都看）。
 * 之所以要判这个，是因为**测试必须是自洽的**：若测试读到了开发者本机的
 * `.env`（例如把本地放宽的配额当成默认值），测试就会「在我这过、在你那挂」，
 * 而这类失败极难定位——它看起来像业务 bug，实际是环境串味。
 */
function isTestProcess(): boolean {
  if (process.env['NODE_TEST_CONTEXT'] !== undefined) return true;
  return process.argv.includes('--test') || process.argv.some((a) => a.endsWith('.test.ts'));
}

/**
 * `.env` 的查找位置：**工作目录下的 `.env`**。
 *
 * 这里踩过一个只在编译产物上才出现的坑（详见本文件顶部与 `AGENTS.md`）：
 * 原实现用 `new URL('../.env', import.meta.url)`，`tsx` 直跑源码时正好是
 * `<root>/.env`，但编译后模块位于 `dist/src/config.js`，`../.env` 变成
 * `dist/.env` —— 文件不存在 → 静默 return → **配置全部回落默认值**：
 * 默认模型「未配置」、配额从 1000/日 掉到 30/日，且没有任何报错。
 *
 * 基准统一为工作目录后，与 `DATA_DIR`（默认 `./data`）、`PROMPTS_DIR`
 * （默认 `./prompts`）一致：部署时只需保证「从项目根启动」。
 * 保留此函数是为了可观测——测试直接断言它，而不是靠行为间接推断。
 */
export function dotEnvPath(): string {
  return resolve(process.cwd(), '.env');
}

function loadDotEnv(): void {
  if (isTestProcess()) return;

  const path = dotEnvPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // 没有 .env 是正常情况
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 去掉成对的引号（`KEY="a b"`）
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少必需的环境变量: ${name}`);
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 必须是整数，实际: ${v}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'on', 'yes'].includes(v.toLowerCase());
}

/** 服务监听 */
export const server = {
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 8080),
  /** 端口被占用时自动递增（PORT、PORT+1…）；设 false 则撞端口即失败 */
  portAutoIncrement: envBool('PORT_AUTO_INCREMENT', true),
};

/**
 * 前端静态资源。
 *
 * `dir` 为空表示用默认位置（源码目录旁的 `web/dist`）。之所以做成可配置项，
 * 是因为部署时该目录常被换成挂载卷（`web/dist` 与源码不同层），
 * 而**写错路径的表现是「服务正常、页面 404」**——那种缺陷只能靠配置项显式表达。
 */
export const web = {
  dir: env('WEB_DIR', ''),
};

/**
 * LogShare 联动配置。
 * 未配置 LOGSHARE_INTERNAL_URL 时进入「独立运行模式」，相关能力降级。
 */
export const logshare = {
  internalUrl: env('LOGSHARE_INTERNAL_URL', ''),
  internalToken: env('LOGSHARE_INTERNAL_TOKEN', ''),
  /** 公网 API 地址（用于读取日志详情的兜底路径） */
  publicApiUrl: env('LOGSHARE_PUBLIC_API_URL', ''),
  get enabled(): boolean {
    return this.internalUrl !== '';
  },
  /**
   * **读**日志的可用条件：内部 API 或公网 API 任一可用即可。
   *
   * 为什么必须与 `enabled` 分开（实测缺陷，2026-10-17）：
   * `fetchLog()` 里**已经实现**了「内部优先、公网兜底」两条路径，
   * 但入口处用 `enabled`（只认内部地址）一刀切挡掉，于是配了
   * `LOGSHARE_PUBLIC_API_URL` 也永远走不到公网分支——表现为
   * 「明明配了公网地址，却提示未配置联动」。文档里把它写成「兜底路径」，
   * 代码里也写了兜底实现，只有门禁没让它生效。
   *
   * `enabled` 保留原语义（是否有内部联动），因为它还决定「能否写入」——
   * 上传必须走 LogShare 的完整写入流水线，公网路径不承担这个职责。
   */
  get canRead(): boolean {
    return this.internalUrl !== '' || this.publicApiUrl !== '';
  },
  /**
   * **上传**日志的可用条件。
   *
   * 与 `canRead` 同样放宽到公网路径：LogShare 的公网 `POST /v1/log`
   * 就是真实客户端在用的入口，它走的是同一套完整流水线
   * （脱敏 → 去重 → 异步反混淆 → 安全审核）。因此「必须经 LogShare 处理」
   * 这条约束在两条路径下都成立，放宽不会绕过脱敏。
   */
  get canUpload(): boolean {
    return this.internalUrl !== '' || this.publicApiUrl !== '';
  },
};

/**
 * MariaDB：**同一个实例、两个库**。
 *
 * - `lograg`（读写）：本服务自己的会话、日志正文、追加段、分析记录、领域知识。
 * - `logshare`（只读）：导入的日志正文，跟随 LogShare 的 7 天 TTL。
 *
 * 两个库默认在**同一个实例**上（共用 `DB_HOST` / `DB_PORT`），但账号与库名分开：
 * 本服务对 `logshare` 只需要 SELECT，对 `lograg` 需要读写。
 *
 * **可完全独立部署**：把 `DB_HOST` 指向另一个实例、`DB_NAME` 改成别的库名即可，
 * 代码不假设任何具体实例或库名。两个库分处不同实例时，用
 * `LOGSHARE_DB_HOST` / `LOGSHARE_DB_PORT` 单独覆盖 LogShare 那一侧。
 */
export const db = {
  host: env('DB_HOST', ''),
  port: envInt('DB_PORT', 3306),
  user: env('DB_USER', 'lograg'),
  password: env('DB_PASSWORD', ''),
  database: env('DB_NAME', 'lograg'),
  connectionLimit: envInt('DB_POOL_SIZE', 4),
  get enabled(): boolean {
    return db.host !== '';
  },
};

/**
 * LogShare 库（只读）。
 *
 * 主机/端口默认继承 `DB_HOST` / `DB_PORT`（同实例不同库），可单独覆盖。
 * 未配置或连不上时，导入日志改走公网只读 API 兜底——这是**降级**而不是失败：
 * 追加段仍在本库，分析仍可进行。
 */
export const logshareDb = {
  host: env('LOGSHARE_DB_HOST', env('DB_HOST', '')),
  port: envInt('LOGSHARE_DB_PORT', envInt('DB_PORT', 3306)),
  user: env('LOGSHARE_DB_USER', 'lograg_ro'),
  password: env('LOGSHARE_DB_PASSWORD', env('DB_PASSWORD', '')),
  database: env('LOGSHARE_DB_NAME', 'logshare'),
  connectionLimit: envInt('LOGSHARE_DB_POOL_SIZE', 2),
  get enabled(): boolean {
    return logshareDb.host !== '';
  },
};

/**
 * SpinYarn 反混淆（可选）。
 *
 * 走 C ABI 直调（koffi），与 LogShare 共用同一份 mappings 目录；
 * 配了 `SPINYARN_REDIS_URL` 时还共用同一个 Redis 缓存
 * （缓存键由库内部决定，同 mappings + 同 URL 即自然共享）。
 *
 * 任一项缺失即整体禁用，分析流程不受影响（反混淆是增强，不是前置条件）。
 */
export const logshareDeobf = {
  /** C ABI 动态库路径，如 `/app/mappings/libspinyarn_capi.so` */
  soPath: env('SPINYARN_SO', ''),
  /** mappings 目录（`*.tiny.gz`），与 LogShare 配置一致 */
  mappingsDir: env('SPINYARN_MAPPINGS_DIR', ''),
  /** Redis URL；空 = on-demand（无共享缓存） */
  redisUrl: env('SPINYARN_REDIS_URL', ''),
  cacheMax: envInt('SPINYARN_CACHE_MAX', 10),
  cacheHigh: envInt('SPINYARN_CACHE_HIGH', 10),
  cacheLow: envInt('SPINYARN_CACHE_LOW', 7),
  get enabled(): boolean {
    return logshareDeobf.soPath !== '' && logshareDeobf.mappingsDir !== '';
  },
};

/** Redis：可选依赖（LogShare 本身即把 Redis 当可选，此处保持一致的降级语义） */
export const redis = {
  host: env('REDIS_HOST', ''),
  port: envInt('REDIS_PORT', 6379),
  password: env('REDIS_PASSWORD', ''),
  database: envInt('REDIS_DB', 0),
  /** key 前缀隔离：避免与 LogShare 的 ai:* / log:* / rag:* / events:* 冲突 */
  prefix: env('REDIS_KEY_PREFIX', 'agent:'),
  get enabled(): boolean {
    return this.host !== '';
  },
};

/** 本地存储（会话 / 上传副本 / 供应商配置） */
export const storage = {
  dataDir: env('DATA_DIR', './data'),
  /** 独立会话保留期（小时）；携带 LogShare ID 的会话跟随日志 TTL */
  sessionTtlHours: envInt('SESSION_TTL_HOURS', 48),
};

/**
 * 管理接口。
 *
 * ## 默认关闭，且「开了但没配 Token」也算未启用
 * 见 `src/security/adminAuth.ts` 的 fail-closed 说明。这里的默认值
 * （`ADMIN_ENABLED=false`、`ADMIN_TOKEN=''`）就是那条安全边界的配置面。
 */
export const admin = {
  get enabled(): boolean {
    return envBool('ADMIN_ENABLED', false);
  },
  /**
   * 管理令牌。**必须是 getter**：若写成普通字段，它会在模块加载时固化，
   * 此后即使补配环境变量也不再生效——表现为「配了 Token 却依然 404，
   * 且没有任何错误提示」，排查成本很高（测试已覆盖该路径）。
   */
  get token(): string {
    return env('ADMIN_TOKEN', '');
  },
};

/** RAG 索引（只读挂载 LogShare 的 rag/index.db） */
export const rag = {
  /**
   * 索引路径。默认值与 `src/rag/build-cli.ts` 的输出路径**必须一致**：
   * 若这里留空，`search()` 会返回「索引不可用」，而构建命令又刚刚报告
   * 「索引构建完成」——两边都正常，唯一的效果是知识库静默不可用。
   * 这类「各自都对、合起来不对」的默认值缺陷排查成本很高，故在默认值层面消掉。
   */
  indexPath: env('RAG_INDEX_PATH', './data/rag/index.db'),
  /** 语义检索 provider（可选；不可用时降级为纯词法并显式告知） */
  embedding: {
    baseUrl: env('RAG_EMBEDDING_BASE_URL', ''),
    apiKey: env('RAG_EMBEDDING_API_KEY', ''),
    model: env('RAG_EMBEDDING_MODEL', ''),
    get enabled(): boolean {
      return this.baseUrl !== '' && this.model !== '';
    },
  },
  /**
   * 重排序 provider（可选）。
   *
   * 与 embedding 分开配置：两者常常不是同一个服务（这里 embedding 用 bge-m3、
   * 重排序用 bge-reranker-v2-m3，虽然同属 SiliconFlow，但换成自建
   * vLLM / Xinference 时往往只部署其中一个）。留空则显式跳过重排，
   * 检索结果附带「未重排」的说明，而不是假装排过。
   */
  rerank: {
    baseUrl: env('RAG_RERANK_BASE_URL', ''),
    apiKey: env('RAG_RERANK_API_KEY', ''),
    model: env('RAG_RERANK_MODEL', ''),
    get enabled(): boolean {
      return this.baseUrl !== '' && this.model !== '';
    },
  },
};

/**
 * 默认模型供应商（服务端兜底）。
 * 用户在网页上配置的供应商优先于此。
 */
export const defaultProvider = {
  baseUrl: env('AI_BASE_URL', ''),
  apiKey: env('AI_API_KEY', ''),
  model: env('AI_MODEL', ''),
  get configured(): boolean {
    return this.baseUrl !== '' && this.model !== '';
  },
};

/** GitHub 排障工具（多 Token 轮询；无 Token 时降级为匿名限流） */
export const github = {
  tokens: env('GITHUB_TOKENS', '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== ''),
  get enabled(): boolean {
    return envBool('GITHUB_ENABLED', true);
  },
  cacheTtlSeconds: envInt('GITHUB_CACHE_TTL', 3600),
  timeoutMs: envInt('GITHUB_TIMEOUT_MS', 8000),
};

/** Web 搜索 MCP（Exa） */
export const webSearch = {
  url: env('WEB_SEARCH_MCP_URL', 'https://mcp.exa.ai/mcp'),
  get enabled(): boolean {
    return this.url !== '';
  },
};

/** 配额（按成本分级；详见设计文档 §2.2） */
export const quota = {
  chat: envInt('QUOTA_CHAT_PER_DAY', 30),
  logId: envInt('QUOTA_LOGID_PER_DAY', 20),
  upload: envInt('QUOTA_UPLOAD_PER_DAY', 5),
  /** IP 兜底阈值：指纹被清除时的兜底约束（高于主阈值） */
  ipFallbackMultiplier: envInt('QUOTA_IP_FALLBACK_MULTIPLIER', 4),
  roundsPerSession: envInt('QUOTA_ROUNDS_PER_SESSION', 10),
  /** 达到该比例时前端提示剩余次数 */
  warnThreshold: 0.8,
};

/** Agent 行为约束 */
export const agent = {
  maxRounds: envInt('AGENT_MAX_ROUNDS', 30),
  /** 单轮工具调用上限（防止失控） */
  maxToolCallsPerRound: envInt('AGENT_MAX_TOOL_CALLS_PER_ROUND', 8),
  /** 会话总工具调用预算 */
  toolBudget: envInt('AGENT_TOOL_BUDGET', 40),
};

/**
 * 已知领域知识（管理员维护的先验规则）。
 *
 * ## 为什么要独立配置
 * 这类内容是**运维共识**而非文档事实：它随线上观察变化，必须能在线增删改，
 * 而不必改代码或重建索引（重建索引要几十秒且期间检索不可用）。
 *
 * ## 单条字数上限为什么是硬约束
 * 条目会**原文拼进系统提示词**（不做摘要——摘要会引入偏差，而这类内容容不下偏差）。
 * 若允许长条目，单条就能挤占整个提示词预算；200 字的下限压力会迫使运维把话写清楚。
 */
export const domainKnowledge = {
  get enabled(): boolean {
    return envBool('DOMAIN_KNOWLEDGE_ENABLED', true);
  },
  /** 单条上限（字）——硬约束，超出拒绝写入 */
  maxEntryChars: envInt('DOMAIN_KNOWLEDGE_MAX_CHARS', 200),
  /** 注入系统提示词的总预算（字）；超出则按优先级截断并显式告知模型 */
  injectBudgetChars: envInt('DOMAIN_KNOWLEDGE_BUDGET_CHARS', 4000),
  /**
   * 注入的最小优先级：低于此值的条目**不进提示词**，但仍可被
   * `expert_knowledge` 工具检索到。用于把「常用先验」与「备查先验」分层。
   */
  injectMinPriority: envInt('DOMAIN_KNOWLEDGE_INJECT_MIN_PRIORITY', 0),
  /** 注入小节的标题 */
  injectTitle: env('DOMAIN_KNOWLEDGE_TITLE', '已知领域知识'),
};

/**
 * 分析记录。
 *
 * ## 为什么要有硬上限
 * `listAnalysisRecords` 会被 HTTP 端点直接调用。若 `limit` 由请求参数自由决定，
 * 一次请求就能把整张表读出来。因此这里设两道闸：
 *  - `maxPageSize`：单次查询上限（HTTP 层不得放宽）；
 *  - `maxAggregateRows`：聚合统计的采样上限。内部聚合调用方必须显式
 *    放宽到这一档，否则均值会静默退化为「最近 N 条的均值」。
 *
 * 这组数字直接来自 LogShare 生产环境的教训：那里的看板 `totalAnalyses`
 * 曾长期恒等于 100，因为聚合走了带 100 上限的分页接口。
 */
export const records = {
  /** 单次分页查询上限 */
  maxPageSize: envInt('RECORDS_MAX_PAGE_SIZE', 100),
  /** 聚合统计的采样上限 */
  maxAggregateRows: envInt('RECORDS_MAX_AGGREGATE_ROWS', 20000),
  /** 保留天数（到期由清理协程删除） */
  retentionDays: envInt('RECORDS_RETENTION_DAYS', 90),
};

/** 安全 */
export const security = {
  /** 供应商 API Key 加密密钥（32 字节 hex/base64）；缺失时自动生成并落盘 */
  encryptionKey: env('SECRET_KEY', ''),
  /** 可信反向代理（用于解析真实客户端 IP；与 LogShare 保持一致） */
  trustedProxies: env(
    'TRUSTED_PROXIES',
    '127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
  )
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  /** 自定义供应商 URL 是否允许回环地址（自建 Ollama 场景） */
  allowLoopbackProvider: envBool('ALLOW_LOOPBACK_PROVIDER', false),
};

export const isDev = env('NODE_ENV', 'development') !== 'production';

/** 启动时打印生效配置（不含密钥明文） */
export function describeConfig(): Record<string, unknown> {
  return {
    // 由 start.ts 打印真实监听端口（可能是递增后的），这里不重复
    server: server.port,
    logshare: logshare.enabled ? logshare.internalUrl : '(独立运行模式)',
    db: db.enabled ? `${db.user}@${db.host}:${db.port}/${db.database} (只读)` : '(未配置)',
    redis: redis.enabled ? `${redis.host}:${redis.port} prefix=${redis.prefix}` : '(未配置，降级)',
    ragIndex: rag.indexPath || '(未配置)',
    ragEmbedding: rag.embedding.enabled ? rag.embedding.model : '(未配置，纯词法)',
    defaultProvider: defaultProvider.configured ? defaultProvider.model : '(未配置)',
    github: github.enabled ? `${github.tokens.length} 个 Token` : '关闭',
    quota: `chat=${quota.chat}/logId=${quota.logId}/upload=${quota.upload} 每日, ${quota.roundsPerSession} 轮/会话`,
  };
}
