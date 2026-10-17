/**
 * GitHub 客户端 —— 修正实测发现的三个缺陷。
 *
 * ## 实测发现的缺陷
 * 1. **`repo` 必填阻断全局检索**：实测中模型不知道仓库名时无法检索。
 *    实测证明全局搜索有效 —— 一次 `search/issues?q=SDL3+26.3+snapshot+in:title`
 *    同时命中 5 个启动器的解法（含我们需要的 ZalithLauncher2#1721）。
 * 2. **失败调用仍消耗预算**：仓库名校验在计数之后，2 次预算全浪费在猜仓库名上。
 * 3. **仓库白名单 4/6 失效**（见 registry.ts）。
 *
 * ## 本实现
 * - `repo` 可选：省略时走全局 issue 搜索
 * - 提供 `searchRepositories`：resolveRepo 失败时给候选
 * - 多 Token 轮询 + Rate-Limit 感知 + 冷却（沿用 LogShare 的思路）
 * - **失败不消耗调用方预算**（由调用方依据返回的 `ok` 判定）
 */

import { github as cfg } from '../config.ts';
import { resolveRepo } from './registry.ts';

export interface GitHubResult {
  /** 是否成功取得有效结果（无结果也算成功——不计费的判据） */
  ok: boolean;
  /** 结果文本（供模型阅读） */
  text: string;
  /** 结构化条目（供预算与后续 github_get_content 使用） */
  entries: GitHubEntry[];
  /** 失败原因（ok=false 时） */
  error?: string;
}

export interface GitHubEntry {
  kind: 'PR' | 'Issue' | 'Discussion';
  repo: string;
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  labels: string[];
  snippet: string;
}

interface TokenState {
  token: string;
  /** 冷却截止时间戳（ms） */
  cooldownUntil: number;
  remaining: number | null;
}

/**
 * Token 池：轮询 + Rate-Limit 感知 + 冷却。
 *
 * 实测中 LogShare 的同类实现有效，此处沿用相同思路但更简洁。
 */
class TokenPool {
  private readonly states: TokenState[];
  private cursor = 0;

  constructor(tokens: string[]) {
    this.states = tokens.map((token) => ({ token, cooldownUntil: 0, remaining: null }));
  }

  get size(): number {
    return this.states.length;
  }

  /** 取下一个可用 Token；全部冷却中时返回 null（调用方降级为匿名请求） */
  acquire(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.states.length; i++) {
      const idx = (this.cursor + i) % this.states.length;
      const state = this.states[idx]!;
      if (state.cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.states.length;
        return state.token;
      }
    }
    return null;
  }

  /** 记录响应头中的配额信息 */
  updateFromHeaders(token: string, headers: Headers): void {
    const state = this.states.find((s) => s.token === token);
    if (!state) return;

    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining !== null) {
      state.remaining = Number.parseInt(remaining, 10);
    }
    if (state.remaining === 0 && reset !== null) {
      const resetAt = Number.parseInt(reset, 10) * 1000;
      state.cooldownUntil = Math.max(state.cooldownUntil, resetAt);
    }
  }

  /** 遇到 403/429 时主动冷却该 Token */
  cooldown(token: string, ms: number): void {
    const state = this.states.find((s) => s.token === token);
    if (state) state.cooldownUntil = Date.now() + ms;
  }
}

const pool = new TokenPool(cfg.tokens);

/** 简易进程内缓存（避免重复请求；LogShare 用 Redis，此处先做进程级） */
const cache = new Map<string, { expires: number; value: string }>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: string): void {
  // 简单容量控制，避免无界增长
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + cfg.cacheTtlSeconds * 1000, value });
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

async function githubFetch(path: string, accept = 'application/vnd.github+json'): Promise<FetchOutcome> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;

  // 优先用 Token，全部冷却时降级为匿名（配额更低但可用）
  const token = pool.acquire();
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'LogRAG-Plus/0.1',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (token) pool.updateFromHeaders(token, res.headers);

    if (res.status === 403 || res.status === 429) {
      if (token) pool.cooldown(token, 60_000);
      return { ok: false, status: res.status, body: null, error: 'GitHub API 限流，请稍后重试' };
    }
    if (res.status === 422) {
      // 实测中 404 仓库会返回 422：仓库不存在或无权访问
      return { ok: false, status: 422, body: null, error: '仓库不存在或无权访问（GitHub 422）' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, error: `GitHub API 返回 HTTP ${res.status}` };
    }

    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, body: null, error: `GitHub 请求失败: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function extractSnippet(body: string, query: string): string {
  if (body === '') return '';
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const lower = body.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 120);
      const end = Math.min(body.length, idx + 280);
      return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '');
    }
  }
  return body.slice(0, 300).replace(/\s+/g, ' ').trim();
}

interface RawIssue {
  number?: number;
  title?: string;
  state?: string;
  updated_at?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  pull_request?: unknown;
  repository_url?: string;
}

function mapIssue(item: RawIssue, fallbackRepo: string, query: string): GitHubEntry {
  const labels: string[] = [];
  if (Array.isArray(item.labels)) {
    for (const l of item.labels) {
      if (l && typeof l.name === 'string') labels.push(l.name);
    }
  }
  // 全局检索时 repository_url 给出真实仓库（repo 参数省略的场景）
  let repo = fallbackRepo;
  if (typeof item.repository_url === 'string') {
    const m = item.repository_url.match(/repos\/(.+)$/);
    if (m) repo = m[1]!;
  }

  return {
    kind: item.pull_request ? 'PR' : 'Issue',
    repo,
    number: item.number ?? 0,
    title: item.title ?? '',
    state: item.state ?? 'open',
    updatedAt: (item.updated_at ?? '').slice(0, 10),
    labels,
    snippet: extractSnippet(item.body ?? '', query),
  };
}

export interface SearchOptions {
  /** 可选：限定仓库（owner/repo 或别名）。省略时走全局检索 */
  repo?: string;
  /** all | issue | pr | discussion */
  type?: 'all' | 'issue' | 'pr' | 'discussion';
  /** all | open | closed */
  state?: 'all' | 'open' | 'closed';
  maxResults?: number;
}

/**
 * 检索 Issues / PRs。
 *
 * **repo 可选** —— 这是修复实测缺陷 1 的关键：不知道仓库名时也能检索。
 */
export async function search(query: string, options: SearchOptions = {}): Promise<GitHubResult> {
  const q = query.trim();
  if (q === '') {
    return { ok: false, text: '检索词不能为空。请提供具体的报错类名、异常特征或关键词。', entries: [], error: 'empty query' };
  }

  const { repo: repoInput, type = 'all', state = 'all' } = options;
  const limit = Math.max(1, Math.min(10, options.maxResults ?? 5));

  // 组装限定符
  const qualifiers: string[] = [];
  let resolvedRepo: string | null = null;
  let archivedNote = '';

  if (repoInput && repoInput.trim() !== '') {
    const resolved = resolveRepo(repoInput);
    if (resolved.repo === null) {
      // 解析失败：不再直接报错，而是走全局检索并提示
      return {
        ok: false,
        text: [
          `未能识别仓库 "${repoInput}"。已尝试全局检索的建议：`,
          `- 省略 repo 参数可直接在 GitHub 全站检索 Issues/PRs`,
          `- 或使用 github_search_repos 按关键词查找仓库`,
          `- 也可直接传 owner/repo 形式的完整路径`,
        ].join('\n'),
        entries: [],
        error: 'repo unresolved',
      };
    }
    resolvedRepo = resolved.repo;
    qualifiers.push(`repo:${resolvedRepo}`);
    if (resolved.archived) {
      archivedNote = `\n⚠️ 注意：\`${resolved.repo}\` 已归档，内容可能过时。建议改查 \`${resolved.replacedBy}\`。`;
    }
  }

  if (type === 'pr') qualifiers.push('is:pr');
  else if (type === 'issue') qualifiers.push('is:issue');
  if (state === 'closed') qualifiers.push('is:closed');
  else if (state === 'open') qualifiers.push('is:open');

  const fullQuery = [...qualifiers, q].join(' ');
  const cacheKey = `search:${fullQuery}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return { ok: true, text: cached, entries: [] };
  }

  const outcome = await githubFetch(
    `/search/issues?q=${encodeURIComponent(fullQuery)}&per_page=${limit}&sort=updated&order=desc`,
  );

  if (!outcome.ok) {
    return { ok: false, text: `GitHub 检索失败：${outcome.error}`, entries: [], error: outcome.error };
  }

  const data = outcome.body as { total_count?: number; items?: RawIssue[] } | null;
  const items = data?.items ?? [];

  if (items.length === 0) {
    const scope = resolvedRepo ? `在仓库 \`${resolvedRepo}\` 中` : '在 GitHub 全站';
    return {
      ok: true, // 无结果是"成功执行"，不计入预算惩罚
      text: [
        `${scope}检索 "${q}" 未找到相关 Issue、PR 或 Discussion。`,
        '建议：',
        '1. 缩短关键词，或只保留最核心的异常类名（如去掉包名前缀）；',
        '2. 英文异常类名与中文症状词互译重试；',
        resolvedRepo
          ? '3. 去掉 repo 限定扩大到全站检索（答案可能在别的仓库）；'
          : '3. 换用报错中的其他特征词重试。',
      ].join('\n'),
      entries: [],
    };
  }

  const entries = items.map((it) => mapIssue(it, resolvedRepo ?? '', q));
  const total = data?.total_count ?? entries.length;

  const lines: string[] = [];
  const scope = resolvedRepo ? `在仓库 \`${resolvedRepo}\` 中` : '在 GitHub 全站';
  lines.push(`${scope}检索 "${q}" 命中 ${total} 条（显示前 ${entries.length} 条）：`);
  lines.push('');
  entries.forEach((e, i) => {
    const repoTag = resolvedRepo === null ? ` · ${e.repo}` : '';
    lines.push(`${i + 1}. [${e.kind} #${e.number}] ${e.title}`);
    lines.push(`   状态: ${e.state} · 更新: ${e.updatedAt}${repoTag}`);
    if (e.labels.length > 0) lines.push(`   标签: ${e.labels.join(', ')}`);
    if (e.snippet !== '') lines.push(`   摘要: ${e.snippet}`);
    lines.push('');
  });
  lines.push('如需完整内容，调用 github_get_content（repo + number）。');
  if (archivedNote) lines.push(archivedNote);

  const text = lines.join('\n');
  cacheSet(cacheKey, text);

  return { ok: true, text, entries };
}

/**
 * 按关键词搜索**仓库** —— 用于 resolveRepo 失败时给出候选。
 *
 * 实测依据：`search/repositories?q=ZalithLauncher` 一次就找到
 * `ZalithLauncher/ZalithLauncher2`（2029 stars，活跃）。
 */
export async function searchRepositories(keyword: string, limit = 5): Promise<GitHubResult> {
  const q = keyword.trim();
  if (q === '') {
    return { ok: false, text: '关键词不能为空。', entries: [], error: 'empty keyword' };
  }

  const cacheKey = `repos:${q}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return { ok: true, text: cached, entries: [] };

  const outcome = await githubFetch(
    `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`,
  );

  if (!outcome.ok) {
    return { ok: false, text: `仓库搜索失败：${outcome.error}`, entries: [], error: outcome.error };
  }

  const data = outcome.body as {
    total_count?: number;
    items?: Array<{ full_name?: string; stargazers_count?: number; open_issues_count?: number; archived?: boolean; pushed_at?: string; description?: string }>;
  } | null;

  const items = data?.items ?? [];
  if (items.length === 0) {
    return { ok: true, text: `未找到与 "${q}" 匹配的仓库。`, entries: [] };
  }

  const lines = [`与 "${q}" 匹配的仓库（按 star 降序）：`, ''];
  for (const r of items) {
    const archived = r.archived ? ' [已归档]' : '';
    lines.push(`- \`${r.full_name}\`${archived} — ${r.stargazers_count ?? 0} stars, ${r.open_issues_count ?? 0} open issues`);
    if (r.description) lines.push(`  ${r.description.slice(0, 150)}`);
    if (r.pushed_at) lines.push(`  最后推送: ${r.pushed_at.slice(0, 10)}`);
  }
  lines.push('');
  lines.push('提示：可直接把上述 `owner/repo` 传给 github_search 的 repo 参数。');

  const text = lines.join('\n');
  cacheSet(cacheKey, text);
  return { ok: true, text, entries: [] };
}

export interface ContentOptions {
  repo: string;
  number: number;
  type?: 'auto' | 'issue' | 'pr' | 'discussion';
}

/**
 * 读取单条 Issue/PR 的完整内容。
 *
 * 实测中这是"读取答案"的主力工具，但因前置检索失败而几乎没用上（27 份仅 8 次）。
 */
export async function getContent(options: ContentOptions): Promise<GitHubResult> {
  const resolved = resolveRepo(options.repo);
  if (resolved.repo === null) {
    return { ok: false, text: `未识别仓库 "${options.repo}"。请用 github_search_repos 查找。`, entries: [], error: 'repo unresolved' };
  }
  if (!Number.isInteger(options.number) || options.number <= 0) {
    return { ok: false, text: 'number 必须是正整数（Issue/PR 编号）。', entries: [], error: 'invalid number' };
  }

  const repo = resolved.repo;
  const cacheKey = `content:${repo}:${options.number}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return { ok: true, text: cached, entries: [] };

  const outcome = await githubFetch(`/repos/${repo}/issues/${options.number}`);
  if (!outcome.ok) {
    return { ok: false, text: `读取失败：${outcome.error}`, entries: [], error: outcome.error };
  }

  const item = outcome.body as {
    number?: number;
    title?: string;
    state?: string;
    created_at?: string;
    updated_at?: string;
    body?: string;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
    pull_request?: { merged_at?: string | null };
  } | null;

  if (!item) {
    return { ok: false, text: '返回内容为空。', entries: [], error: 'empty body' };
  }

  const isPr = item.pull_request !== undefined;
  const kind = isPr ? 'PR' : 'Issue';
  const merged = item.pull_request?.merged_at;
  const labels = (item.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string');

  const lines = [
    `### [${kind} #${item.number}] ${item.title}`,
    `- 仓库: \`${repo}\``,
    `- 状态: ${item.state}${merged ? `（已合并于 ${merged.slice(0, 10)}）` : ''}`,
    `- 作者: ${item.user?.login ?? '未知'} · 创建: ${(item.created_at ?? '').slice(0, 10)}`,
  ];
  if (labels.length > 0) lines.push(`- 标签: ${labels.join(', ')}`);
  lines.push('');
  lines.push('**正文：**');
  const body = (item.body ?? '').trim();
  lines.push(body === '' ? '(无正文)' : body.slice(0, 8000));
  if (resolved.archived) {
    lines.push('');
    lines.push(`⚠️ 该仓库已归档，建议改查 \`${resolved.replacedBy}\`。`);
  }

  const text = lines.join('\n');
  cacheSet(cacheKey, text);
  return { ok: true, text, entries: [] };
}

/** 供测试重置内部状态 */
export function __resetForTest(): void {
  cache.clear();
}
