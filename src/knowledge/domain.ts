/**
 * 已知领域知识 —— 管理员维护的「事实性先验」。
 *
 * ## 与知识库（`knowledge/`）的区别
 *
 * | | 知识库 | 已知领域知识 |
 * |---|---|---|
 * | 内容 | 故障模式、修复步骤（可检索的文档） | 短小的先验事实（一句话） |
 * | 更新 | 改文件 + 重建索引 | 在线增删改，**毫秒级生效** |
 * | 用途 | 模型主动检索 | **原文注入系统提示词**，形成权威约束 |
 * | 谁来写 | 开发者 | 运维（无需改代码） |
 *
 * 两者互补：知识库是「可以查到」的，领域知识是「必须知道」的。
 *
 * ## 为什么要做「条目性质校验」（对 LogShare 版本的针对性优化）
 *
 * LogShare 线上现有 6 条领域知识，其中至少有 2 条其实是**方法论**：
 *
 * ```
 * 「如果最大日志文件没有超过 6000 行……可直接阅读全文，不再使用检索工具。
 *   如果超过两次没有检索到关键词，尝试使用行数预览工具大规模查看日志。」
 * 「如果是 FCL/ZL2 等移动端启动器报错，优先搜索 Renderer 关键字定位所使用的渲染器。」
 * ```
 *
 * 这两条都在回答「**怎么搜**」，而方法论的正确归属是 `prompts/`：
 *
 *  1. 它们被当作**事实**注入后，模型会把「排查流程」当成「已知结论」；
 *  2. 它们的**高频通用词**（日志、检索、工具、行数）会稀释领域知识的信号；
 *  3. 修方法论要改代码/配置，比改提示词文件麻烦得多，导致长期没人动。
 *
 * 但**不能硬拒**：误判会把真正该留的先验也挡在外面（例如
 * 「Mojang 认证 401 系错误噪音，忽略即可」兼有祈使语气却是纯事实）。
 * 因此本模块只做 `classifyEntry()` 给出**性质判定 + 提醒**，由管理员决定。
 *
 * ## 注入策略（双向可用）
 *
 *  - **注入**：按优先级取条目原文拼进系统提示词，总长受 `injectBudgetChars` 约束；
 *    超预算的条目被跳过，并在提示词里**显式列出被跳过的条目标题**，
 *    避免模型误以为「已知领域知识就这些」。
 *  - **检索**：同一批条目同时挂成 `expert_knowledge` 工具。工具名不是随便取的——
 *    线上 9353 条分析记录里，模型**自发**调用过 3 次 `expert_knowledge` 与
 *    23 次 `knowledge_search`（系统里都不存在，全部报错）。模型确实想要这个能力。
 */

import { domainKnowledge as cfg } from '../config.ts';
import { query, queryOne, transaction } from '../store/mysql.ts';

export interface DomainKnowledge {
  id: string;
  /** 条目正文（≤ `maxEntryChars`） */
  content: string;
  enabled: boolean;
  /** 越大越靠前注入 */
  priority: number;
  /** 分类标签（自由文本，供检索与分组） */
  tags: string[];
  /** 性质判定结果 */
  kind: EntryKind;
  createdAt: number;
  updatedAt: number;
}

/** 条目性质 */
export type EntryKind =
  /** 事实性先验：某 GPU 不支持某特性、某版本已变更依赖…… */
  | 'fact'
  /** 方法论：怎么搜、用哪个工具、读多少行——正解应在 `prompts/` */
  | 'method'
  /** 无法判定 */
  | 'unclear';

export interface EntryAnalysis {
  kind: EntryKind;
  /** 面向管理员的提醒（非致命） */
  warnings: string[];
}

export interface MutationResult {
  ok: boolean;
  entry?: DomainKnowledge;
  /** 校验/冲突失败时的原因（面向管理员，中文） */
  error?: string;
  /** 非致命提醒 */
  warnings?: string[];
}

// ── 表结构 ───────────────────────────────────────────────

/*
 * 表结构由 `src/store/migrate.ts` 统一管理（MariaDB）。
 * 原先这里的 SQLite `registerMigration` 已移除——两处建表必然漂移。
 */

interface Row {
  id: string;
  content: string;
  enabled: number;
  priority: number;
  tags: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

function toEntry(r: Row): DomainKnowledge {
  return {
    id: r.id,
    content: r.content,
    enabled: r.enabled !== 0,
    priority: r.priority,
    tags: r.tags === '' ? [] : r.tags.split(',').filter((t) => t !== ''),
    kind: r.kind as EntryKind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 生成条目 ID（`dk_` 前缀，与日志/会话 ID 区隔，便于人工辨认） */
function newEntryId(): string {
  return `dk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── 性质校验 ─────────────────────────────────────────────

/** 方法论句式 */
const METHOD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(如果|若|当)[^。；]{0,60}(就|则|应|要|可|直接)/, reason: '条件→动作句式' },
  { re: /(优先|首先|其次|然后|最后|尽可能|尽量|避免|不要|禁止|应当|建议|推荐)/, reason: '祈使/次序词' },
  { re: /(检索|搜索|读取|查看|阅读|排查|定位|工具|调用|grep|read|search|preview)/i, reason: '检索/工具动作词' },
  { re: /(不超过|超过|大于|少于)[^。；]{0,20}(行|次|个|条)/, reason: '阈值型操作规则' },
];

/** 事实性先验句式 */
const FACT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(不支持|无法|不能|不兼容|不适配|不可用)/, reason: '能力/兼容性断言' },
  { re: /(已知|实测|经验证|已确认|据观察)/, reason: '已知性断言' },
  { re: /(由于|因为|导致|引起|原因是|根源|本质)/, reason: '因果断言' },
  { re: /(系|是)[^。；]{0,30}(噪音|误报|正常现象|预期行为)/, reason: '噪音/误报判定' },
  { re: /(已(切换|变更|更改为|移除|替换)|自[^。；]{0,20}起)/, reason: '版本演进断言' },
  { re: /(表现(为|成)|现象是|特征是)/, reason: '现象描述' },
];

/**
 * 判定条目性质并给出提醒。
 *
 * 判据是**启发式**，只用于提醒、不做强制拦截——详见文件头注释里
 * 「Mojang 认证 401」的反例。
 */
export function classifyEntry(content: string): EntryAnalysis {
  const text = content.trim();
  const warnings: string[] = [];

  let methodHits = 0;
  let factHits = 0;
  const methodReasons: string[] = [];
  const factReasons: string[] = [];

  for (const p of METHOD_PATTERNS) {
    if (p.re.test(text)) {
      methodHits++;
      methodReasons.push(p.reason);
    }
  }
  for (const p of FACT_PATTERNS) {
    if (p.re.test(text)) {
      factHits++;
      factReasons.push(p.reason);
    }
  }

  let kind: EntryKind;
  if (methodHits > factHits) {
    kind = 'method';
  } else if (factHits > 0) {
    kind = 'fact';
  } else {
    kind = 'unclear';
  }

  if (kind === 'method') {
    warnings.push(
      `这条读起来像**方法论**（命中：${methodReasons.join('、')}）。` +
        '领域知识只应放「事实性先验」——即模型自己无法从日志推断、且长期成立的结论' +
        '（如「Mali 系 GPU 在 26.2+ 仍无法用 Vulkan 启动」）。' +
        '「先搜什么、读多少行、用哪个工具」属于方法论，正确归属是 prompts/ 下的提示词资产：' +
        '放在这里会被当作已知事实注入，且其通用词会稀释领域知识的检索信号。',
    );
  } else if (kind === 'unclear') {
    warnings.push(
      '未能判定性质（既不像事实断言，也不像方法论）。请确认这条是「模型无法从日志推断的长期事实」，' +
        '否则它更适合放进知识库或提示词。',
    );
  }

  // 结构类提醒：这些不是致命问题，但通常说明条目没写透
  if (text.includes('\n')) {
    warnings.push('包含换行。领域知识会原文拼进系统提示词，多行会破坏编号列表结构，建议压成一句话。');
  }
  if (/^#{1,6}\s/m.test(text)) {
    warnings.push('包含 Markdown 标题。标题属于文档结构，领域知识应为单句陈述。');
  }
  if (/(?:^|\s)\/(?:storage|sdcard|data|system|mnt|home|opt|usr)\//i.test(text)) {
    warnings.push('包含具体文件路径。路径因设备/启动器而异，先验结论通常不应依赖具体路径。');
  }
  if (/[A-Za-z]:[\\/]|\.minecraft[\\/]/i.test(text)) {
    warnings.push('包含具体文件路径。路径因设备/启动器而异，先验结论通常不应依赖具体路径。');
  }
  if (text.length > cfg.maxEntryChars * 0.9) {
    warnings.push(`长度已接近上限（${text.length}/${cfg.maxEntryChars} 字），后续补充会被拒绝，建议精简。`);
  }

  return { kind, warnings };
}

/** 归一化用于重复检测：去空白与标点，便于发现「换了标点其实是同一条」 */
function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’()（）\-—_/\\]/g, '')
    .trim();
}

// ── 查询 ─────────────────────────────────────────────────

export interface ListOptions {
  /** 只看启用的 */
  enabledOnly?: boolean;
  /** 按标签过滤（任一匹配） */
  tag?: string;
  /** 关键字（对内容做子串匹配，大小写不敏感） */
  keyword?: string;
  limit?: number;
}

/** 列出条目（按优先级降序、更新时间降序） */
export async function listDomainKnowledge(options: ListOptions = {}): Promise<DomainKnowledge[]> {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.enabledOnly === true) where.push('enabled = 1');
  if (options.tag !== undefined && options.tag !== '') {
    // tags 以逗号分隔存储；用两侧逗号包裹做整体匹配，避免 "ab" 命中 "abc"
    where.push("(',' || tags || ',') LIKE ?");
    params.push(`%,${options.tag},%`);
  }
  if (options.keyword !== undefined && options.keyword !== '') {
    where.push('content LIKE ?');
    params.push(`%${options.keyword}%`);
  }

  const sql =
    'SELECT * FROM domain_knowledge' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY priority DESC, updated_at DESC' +
    (options.limit !== undefined ? ' LIMIT ?' : '');

  if (options.limit !== undefined) params.push(options.limit);

  const rows = await query<Row>(sql, params);
  return rows.map(toEntry);
}

/** 取单条 */
export async function getDomainKnowledge(id: string): Promise<DomainKnowledge | null> {
  // `queryOne` 查不到时返回 **null**（不是 undefined）。这里踩过：原写
  // `row === undefined` 判断失效，`toEntry(null)` 直接抛「Cannot read properties of null」，
  // 表现为「查不存在的条目返回 500 而不是 404」。
  const row = await queryOne<Row>('SELECT * FROM domain_knowledge WHERE id = ?', [id]);
  return row === null ? null : toEntry(row);
}

export interface DomainKnowledgeStats {
  total: number;
  enabled: number;
  /** 性质为「方法论」的条目数——应当趋近 0（这些该挪去 prompts/） */
  methodLike: number;
  /** 性质无法判定的条目数 */
  unclear: number;
  /** 按 tags 统计 */
  byTag: Record<string, number>;
  /** 注入系统提示词的字符数与条数 */
  injectedChars: number;
  injectedCount: number;
  /** 因预算或优先级未注入的条数 */
  skippedCount: number;
}

/** 统计（供 Admin 面板） */
export async function domainKnowledgeStats(): Promise<DomainKnowledgeStats> {
  const all = await listDomainKnowledge();
  const injection = await renderDomainKnowledgeSection();
  const byTag: Record<string, number> = {};
  for (const e of all) {
    for (const t of e.tags) byTag[t] = (byTag[t] ?? 0) + 1;
  }

  return {
    total: all.length,
    enabled: all.filter((e) => e.enabled).length,
    methodLike: all.filter((e) => e.kind === 'method').length,
    unclear: all.filter((e) => e.kind === 'unclear').length,
    byTag,
    injectedChars: injection.chars,
    injectedCount: injection.injected.length,
    skippedCount: injection.skipped.length,
  };
}

// ── 写入 ─────────────────────────────────────────────────

export interface CreateInput {
  content: string;
  enabled?: boolean;
  priority?: number;
  tags?: string[];
  /** 操作者标识（写审计用） */
  actor?: string;
  /**
   * 覆盖自动性质判定。
   *
   * 用途：管理员确认「这确实是先验事实，虽然读起来像祈使句」
   * （例如「Mojang 认证 401 是噪音，忽略即可」）。这是**显式豁免**，
   * 有了它才能既保留提醒、又不让提醒变成拦路虎。
   */
  kindOverride?: EntryKind;
}

/** 校验并规范化输入，返回错误信息或规范化后的值 */
function validateContent(raw: string): { ok: true; content: string } | { ok: false; error: string } {
  const content = raw.trim().replace(/\s+/g, ' ');

  if (content === '') return { ok: false, error: '内容不能为空' };
  if ([...content].length > cfg.maxEntryChars) {
    return {
      ok: false,
      error: `内容超过单条上限：${[...content].length} 字 > ${cfg.maxEntryChars} 字。请精简为一句可执行的事实性结论。`,
    };
  }
  return { ok: true, content };
}

/** 检查是否与既有条目重复 */
async function findDuplicate(content: string, excludeId?: string): Promise<DomainKnowledge | null> {
  const target = normalizeForDedup(content);
  if (target === '') return null;

  for (const existing of await listDomainKnowledge()) {
    if (excludeId !== undefined && existing.id === excludeId) continue;
    if (normalizeForDedup(existing.content) === target) return existing;
  }
  return null;
}

/** 新建条目 */
export async function createDomainKnowledge(input: CreateInput): Promise<MutationResult> {
  const v = validateContent(input.content);
  if (!v.ok) return { ok: false, error: v.error };

  const dup = await findDuplicate(v.content);
  if (dup !== null) {
    return { ok: false, error: `与既有条目重复（${dup.id}）：${dup.content}` };
  }

  const analysis = classifyEntry(v.content);
  const kind = input.kindOverride ?? analysis.kind;
  const now = nowSeconds();
  const entry: DomainKnowledge = {
    id: newEntryId(),
    content: v.content,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 0,
    tags: (input.tags ?? []).map((t) => t.trim()).filter((t) => t !== ''),
    kind,
    createdAt: now,
    updatedAt: now,
  };

  await transaction(async (conn) => {
    await conn.execute(
      'INSERT INTO domain_knowledge (id, content, enabled, priority, tags, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        entry.id,
        entry.content,
        entry.enabled ? 1 : 0,
        entry.priority,
        entry.tags.join(','),
        entry.kind,
        entry.createdAt,
        entry.updatedAt,
      ],
    );
    await writeAudit(conn, entry.id, 'create', null, entry.content, input.actor ?? '');
  });

  return { ok: true, entry, warnings: analysis.warnings };
}

export interface UpdateInput {
  content?: string;
  enabled?: boolean;
  priority?: number;
  tags?: string[];
  actor?: string;
  kindOverride?: EntryKind;
}

/** 更新条目 */
export async function updateDomainKnowledge(id: string, input: UpdateInput): Promise<MutationResult> {
  const existing = await getDomainKnowledge(id);
  if (existing === null) return { ok: false, error: '条目不存在' };

  let content = existing.content;
  let warnings: string[] = [];

  if (input.content !== undefined) {
    const v = validateContent(input.content);
    if (!v.ok) return { ok: false, error: v.error };
    content = v.content;

    const dup = await findDuplicate(content, id);
    if (dup !== null) {
      return { ok: false, error: `与既有条目重复（${dup.id}）：${dup.content}` };
    }
    const analysis = classifyEntry(content);
    warnings = analysis.warnings;
  }

  const kind =
    input.kindOverride ??
    (input.content !== undefined ? classifyEntry(content).kind : existing.kind);

  const next: DomainKnowledge = {
    ...existing,
    content,
    enabled: input.enabled ?? existing.enabled,
    priority: input.priority ?? existing.priority,
    tags: input.tags !== undefined ? input.tags.map((t) => t.trim()).filter((t) => t !== '') : existing.tags,
    kind,
    updatedAt: nowSeconds(),
  };

  await transaction(async (conn) => {
    await conn.execute(
      'UPDATE domain_knowledge SET content = ?, enabled = ?, priority = ?, tags = ?, kind = ?, updated_at = ? WHERE id = ?',
      [
        next.content,
        next.enabled ? 1 : 0,
        next.priority,
        next.tags.join(','),
        next.kind,
        next.updatedAt,
        id,
      ],
    );
    await writeAudit(conn, id, 'update', existing.content, next.content, input.actor ?? '');
  });

  return { ok: true, entry: next, warnings };
}

/** 删除条目 */
export async function removeDomainKnowledge(id: string, actor = ''): Promise<MutationResult> {
  const existing = await getDomainKnowledge(id);
  if (existing === null) return { ok: false, error: '条目不存在' };

  await transaction(async (conn) => {
    await conn.execute('DELETE FROM domain_knowledge WHERE id = ?', [id]);
    await writeAudit(conn, id, 'delete', existing.content, null, actor);
  });

  return { ok: true, entry: existing };
}

async function writeAudit(
  conn: { execute: (sql: string, params?: any[]) => Promise<unknown> },
  entryId: string,
  action: string,
  before: string | null,
  after: string | null,
  actor: string,
): Promise<void> {
  await conn.execute(
    'INSERT INTO domain_knowledge_audit (entry_id, action, before_content, after_content, actor, at) VALUES (?, ?, ?, ?, ?, ?)',
    [entryId, action, before, after, actor, nowSeconds()],
  );
}

export interface AuditRecord {
  id: number;
  entryId: string;
  action: string;
  beforeContent: string | null;
  afterContent: string | null;
  actor: string;
  at: number;
}

/** 变更留痕（倒序） */
export async function domainKnowledgeAudit(limit = 50): Promise<AuditRecord[]> {
  const cap = Math.max(1, Math.min(limit, 500));
  const rows = (await query<{
    id: number;
    entry_id: string;
    action: string;
    before_content: string | null;
    after_content: string | null;
    actor: string;
    at: number;
  }>('SELECT * FROM domain_knowledge_audit ORDER BY id DESC LIMIT ?', [cap]));

  return rows.map((r) => ({
    id: r.id,
    entryId: r.entry_id,
    action: r.action,
    beforeContent: r.before_content,
    afterContent: r.after_content,
    actor: r.actor,
    at: r.at,
  }));
}

// ── 检索（供 expert_knowledge 工具）──────────────────────

/**
 * 按关键词检索条目。
 *
 * 为何不用知识库那套 BM25：领域知识条目短（≤200 字）、量少（通常 <50 条），
 * 词频统计没有意义。这里用「查询词命中个数」排序，行为可预测、无依赖。
 *
 * 中文没有空格分词，故同时按**字符二元组**匹配——「渲染器」能命中
 * 「渲染器兼容性」这类连续文本。这是覆盖率的折中，不是精确分词。
 */
export async function searchDomainKnowledge(
  query: string,
  limit = 20,
): Promise<DomainKnowledge[]> {
  const all = await listDomainKnowledge({ enabledOnly: true });
  const q = query.trim().toLowerCase();

  if (q === '') return all.slice(0, limit);

  const tokens = tokenize(q);
  if (tokens.length === 0) return all.slice(0, limit);

  const scored = all.map((e) => {
    const hay = e.content.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score++;
    }
    // 标签命中给额外分：运维打的标签是有意的归类信号
    for (const tag of e.tags) {
      if (q.includes(tag.toLowerCase())) score += 2;
    }
    return { e, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.e.priority - a.e.priority)
    .slice(0, limit)
    .map((s) => s.e);
}

/** 切词：ASCII 单词按非字母数字切；CJK 取二元组 */
function tokenize(s: string): string[] {
  const out = new Set<string>();

  for (const m of s.matchAll(/[a-z0-9_.+\-]{2,}/g)) {
    out.add(m[0]);
  }

  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (run === '') continue;
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }

  return [...out];
}

// ── 提示词注入 ───────────────────────────────────────────

export interface Injection {
  /** 实际注入的条目（按优先级） */
  injected: DomainKnowledge[];
  /** 因优先级不足或超出预算而未注入的条目 */
  skipped: DomainKnowledge[];
  /** 拼好的提示词片段（无条目时为空串） */
  text: string;
  /** 注入的字符数 */
  chars: number;
}

/**
 * 组装注入系统提示词的「已知领域知识」小节。
 *
 * 两个刻意的设计：
 *
 *  1. **不做摘要**。这些条目之所以叫「已知」，就是因为它们是运维已经确认过的结论；
 *     用模型摘要会引入二次偏差，而这里容不下偏差。
 *  2. **超预算时显式列出被跳过的条目**。若只是静默丢弃，模型会以为
 *     「已知领域知识就这些」从而过度自信；列出来它就知道还有没看到的部分，
 *     可以去调 `expert_knowledge` 检索。
 */
export async function renderDomainKnowledgeSection(): Promise<Injection> {
  if (!cfg.enabled) {
    return { injected: [], skipped: [], text: '', chars: 0 };
  }

  const all = await listDomainKnowledge({ enabledOnly: true });
  const eligible = all.filter((e) => e.priority >= cfg.injectMinPriority);
  const lowPriority = all.filter((e) => e.priority < cfg.injectMinPriority);

  const injected: DomainKnowledge[] = [];
  const skipped: DomainKnowledge[] = [...lowPriority];
  let chars = 0;

  for (const e of eligible) {
    // +3 是列表项前缀 `- ` 与换行的开销
    const cost = e.content.length + 3;
    if (chars + cost > cfg.injectBudgetChars) {
      skipped.push(e);
      continue;
    }
    injected.push(e);
    chars += cost;
  }

  if (injected.length === 0) {
    return { injected, skipped, text: '', chars: 0 };
  }

  const lines: string[] = [
    `## ${cfg.injectTitle}`,
    '',
    '以下是运维团队确认过的**权威先验**。它们优先于你的推测与知识库内容——',
    '与它们冲突时按它们判断；如果它们与日志证据直接矛盾，指出矛盾而不是默默忽略。',
    '',
  ];

  for (const e of injected) {
    lines.push(`- ${e.content}`);
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push(
      `（另有 ${skipped.length} 条领域知识因超出注入预算未列出。` +
        '如判断与当前问题相关，可用 `expert_knowledge` 工具检索。）',
    );
  }

  lines.push('');

  return { injected, skipped, text: lines.join('\n'), chars };
}
