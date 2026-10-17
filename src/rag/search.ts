/**
 * RAG 检索 —— 复用 LogShare 的 `rag/index.db`（零迁移），并修复实测缺陷。
 *
 * ## 零迁移的依据（实测确认）
 * Node 24 内置 `node:sqlite` 使用 SQLite **3.53.0**，与 PHP `pdo_sqlite` 版本**完全一致**。
 * 实测验证通过：FTS5 虚表、`bm25()`（含权重）、`snippet()`、BLOB 向量往返全部兼容，
 * 现有 114 个 chunk 可直接读取，无需重建索引、无需双写。
 *
 * ## 修复的实测缺陷
 * 1. **同源重叠 38%**：`rag_search("Mixin")` 返回 5 条全部来自同一文件。
 *    成因：`patterns/*.md` 切成 4-6 个 chunk 且 title 均含主题词，`bm25(title权重=10)`
 *    使同文件 chunk 全部高分；而同源配额只在 rerank 开启时生效。
 *    → 本实现：**同源配额独立生效**，且 `k` 语义改为「k 个来源」。
 * 2. **embedding 静默降级**：paraphrase 档 hit@5 从 93.3% 掉到 7% 却无告警。
 *    → 本实现：显式上报降级状态。
 */

import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { rag as cfg } from '../config.ts';
import { rerank } from './embed.ts';
import { readEmbeddingMeta, semanticSearch, type SemanticHit } from './semantic.ts';

export interface RagHit {
  title: string;
  body: string;
  source: string;
  /** BM25 原值（负向，越小越相关） */
  score: number;
  snippet: string;
}

export interface RagSearchResult {
  /** 是否成功执行 */
  ok: boolean;
  hits: RagHit[];
  /** 命中的不同来源文件数 */
  distinctSources: number;
  /** 面向模型的文本 */
  text: string;
  /** 语义通道是否可用（false = 降级为纯词法，需显式告知） */
  semanticAvailable: boolean;
  /** 实际走了哪条通道：融合 / 仅词法 */
  mode?: 'hybrid' | 'lexical';
  /** 语义通道降级原因（有值即说明本该融合但没融成） */
  semanticError?: string;
  /** 是否经过重排序 */
  reranked?: boolean;
  /** 重排降级原因 */
  rerankError?: string;
  error?: string;
}

/** 同源配额：单个来源文件最多占几个结果位（实测缺陷 1 的修复） */
const SOURCE_QUOTA = 1;

/** BM25 列权重：title 10 倍（与 LogShare 一致，保持检索质量不回退） */
const BM25_WEIGHTS = '10.0, 1.0, 1.0';

let db: DatabaseSync | null = null;
let dbMtimeMs = 0;

/**
 * 获取索引连接（进程级复用 + mtime 变更检测）。
 *
 * LogShare 的 `rag:build` 通过 tmp + rename 原子替换索引文件，mtime 变化即需重建连接。
 */
function getDb(): DatabaseSync | null {
  if (cfg.indexPath === '') return null;

  try {
    const stat = statSyncSafe(cfg.indexPath);
    if (stat === null) return null;

    if (db !== null && stat.mtimeMs === dbMtimeMs) return db;

    if (db !== null) {
      try {
        db.close();
      } catch {
        /* 忽略关闭失败 */
      }
      db = null;
    }

    db = new DatabaseSync(cfg.indexPath, { readOnly: true });
    dbMtimeMs = stat.mtimeMs;
    return db;
  } catch {
    return null;
  }
}

function statSyncSafe(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * 切词：英文/代码 token（用于 FTS5 前缀匹配）+ CJK 词（用于 LIKE 兜底）。
 *
 * 与 LogShare `RagSearch::splitTerms` 的思路一致：FTS5 的 porter 分词器不处理中文，
 * 故中文需走 LIKE。
 */
export function splitTerms(query: string): string[] {
  const terms: string[] = [];

  // 英文/数字/下划线 token
  const latin = query.match(/[0-9A-Za-z_]+/g) ?? [];
  for (const t of latin) {
    if (t.length >= 2) terms.push(t);
  }

  // 中文：连续 2 字以上的片段整体保留（LIKE 子串匹配）
  const cjk = query.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const t of cjk) terms.push(t);

  return [...new Set(terms)];
}

/**
 * 词法检索（FTS5 BM25 + LIKE 兜底）。
 *
 * 严格 AND 优先，无结果时降级为 OR（避免过度约束导致空手而归）。
 */
function lexicalSearch(query: string, pool: number, topic: string | null): RagHit[] {
  const conn = getDb();
  if (conn === null) return [];

  const terms = splitTerms(query);
  const tokens = (query.match(/[0-9A-Za-z_]+/g) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

  const sourceFilter = topic !== null ? " AND source LIKE ? ESCAPE '\\'" : '';
  const sourceParams = topic !== null ? [`${escapeLike(topic)}/%`] : [];

  const results: RagHit[] = [];
  const seen = new Set<string>();

  // ① FTS5：AND → OR 降级
  if (tokens.length > 0) {
    const candidates = [
      tokens.map((t) => `${t}*`).join(' AND '),
      ...(tokens.length > 1 ? [tokens.map((t) => `${t}*`).join(' OR ')] : []),
    ];

    for (const match of candidates) {
      if (results.length > 0) break;
      try {
        const stmt = conn.prepare(
          `SELECT rowid, title, body, source, bm25(docs, ${BM25_WEIGHTS}) AS rank
           FROM docs WHERE docs MATCH ?${sourceFilter}
           ORDER BY rank LIMIT ?`,
        );
        const rows = stmt.all(match, ...sourceParams, pool) as Array<{
          rowid: number;
          title: string;
          body: string;
          source: string;
          rank: number;
        }>;

        for (const row of rows) {
          const key = `${row.source}#${row.title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            title: row.title,
            body: row.body,
            source: row.source,
            score: row.rank,
            snippet: extractSnippet(row.body, terms),
          });
        }
      } catch {
        // FTS5 语法错误（如特殊字符）→ 静默降级到 LIKE
      }
    }
  }

  // ② LIKE 兜底（CJK / 子串）
  if (results.length === 0 && terms.length > 0) {
    const whereParts: string[] = [];
    const params: Array<string | number> = [];

    for (const term of terms) {
      whereParts.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
      const like = `%${escapeLike(term)}%`;
      params.push(like, like);
    }

    const where = whereParts.join(' OR ');
    const topicClause = topic !== null ? " AND source LIKE ? ESCAPE '\\'" : '';
    if (topic !== null) params.push(`${escapeLike(topic)}/%`);

    try {
      const stmt = conn.prepare(
        `SELECT rowid, title, body, source FROM docs
         WHERE (${where})${topicClause} LIMIT ?`,
      );
      const rows = stmt.all(...params, pool) as Array<{
        rowid: number;
        title: string;
        body: string;
        source: string;
      }>;

      for (const row of rows) {
        const key = `${row.source}#${row.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          title: row.title,
          body: row.body,
          source: row.source,
          score: 0,
          snippet: extractSnippet(row.body, terms),
        });
      }
    } catch {
      /* LIKE 失败亦不阻断 */
    }
  }

  return results;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 片段提取：以命中词为中心截取窗口（与 LogShare SnippetExtractor 思路一致） */
function extractSnippet(body: string, terms: string[], maxChars = 400): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;

  const lower = clean.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx < 0) continue;
    const start = Math.max(0, idx - 120);
    const end = Math.min(clean.length, idx + maxChars - 120);
    return (
      (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '')
    );
  }
  return clean.slice(0, maxChars) + '…';
}

/**
 * 按来源去重：k 的语义是「k 个来源」，而非「k 条 chunk」。
 *
 * 这是修复实测缺陷 1 的核心 —— 原实现返回 5 条可能全来自同一文件。
 */
export function applySourceQuota(hits: RagHit[], quota: number): RagHit[] {
  if (quota <= 0) return hits;
  const counts = new Map<string, number>();
  const out: RagHit[] = [];
  for (const hit of hits) {
    const n = (counts.get(hit.source) ?? 0) + 1;
    counts.set(hit.source, n);
    if (n <= quota) out.push(hit);
  }
  return out;
}

export interface SearchParams {
  query: string;
  /** 期望返回的**不同来源文件**数量 */
  k?: number;
  /** 限定主题目录 */
  topic?: string | null;
}

/** 送去重排的候选数量上限（再多就是白花钱，且头部的排名已稳定） */
const RERANK_POOL = 20;

const RRF_K = 60;

/**
 * 词法 + 向量融合（RRF）。
 *
 * 为什么不用加权求和：BM25 是负值且量纲不定、余弦是 0–1，两者相加需要归一化，
 * 而归一化系数随查询变化——同一个系数在长查询上会偏向词法、短查询上偏向向量。
 * RRF 只看名次，天然免疫量纲问题。
 */
function mergeByRowid(conn: DatabaseSync, lexical: RagHit[], semantic: SemanticHit[]): RagHit[] {
  const score = new Map<number, number>();
  const byRowid = new Map<number, { title: string; body: string; source: string; snippet: string }>();

  lexical.forEach((hit, i) => {
    const rowid = rowidOf(conn, hit.source, hit.title);
    if (rowid === null) return;
    byRowid.set(rowid, { title: hit.title, body: hit.body, source: hit.source, snippet: hit.snippet });
    score.set(rowid, (score.get(rowid) ?? 0) + 1 / (RRF_K + i + 1));
  });

  semantic.forEach((hit, i) => {
    const existing = score.get(hit.rowid) ?? 0;
    score.set(hit.rowid, existing + 1 / (RRF_K + i + 1));
  });

  // 只有向量命中的条目需要回表取正文
  for (const hit of semantic) {
    if (byRowid.has(hit.rowid)) continue;
    const row = conn
      .prepare('SELECT title, body, source FROM docs WHERE rowid = ?')
      .get(hit.rowid) as { title: string; body: string; source: string } | undefined;
    if (row === undefined) continue;
    byRowid.set(hit.rowid, { ...row, snippet: row.body.slice(0, 400) });
  }

  const out: RagHit[] = [];
  for (const [rowid, fused] of score) {
    const info = byRowid.get(rowid);
    if (info === undefined) continue;
    out.push({ ...info, score: -fused });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

/** 由 source + title 反查 rowid（词法结果里 query 未带 rowid） */
function rowidOf(conn: DatabaseSync, source: string, title: string): number | null {
  const row = conn
    .prepare('SELECT rowid FROM docs WHERE source = ? AND title = ? LIMIT 1')
    .get(source, title) as { rowid: number } | undefined;
  return row?.rowid ?? null;
}

/**
 * 检索知识库。
 *
 * `k` 语义为「不同来源文件数」——若同源配额后不足 k，会用同源 chunk 补足
 * （保证结果数量，但优先展示多样性）。
 */
export async function search(params: SearchParams): Promise<RagSearchResult> {
  const query = params.query.trim();
  if (query === '') {
    return {
      ok: false,
      hits: [],
      distinctSources: 0,
      text: '检索词不能为空。',
      semanticAvailable: false,
      error: 'empty query',
    };
  }

  const k = Math.max(1, Math.min(20, params.k ?? 5));
  const topic = params.topic ?? null;

  if (getDb() === null) {
    return {
      ok: false,
      hits: [],
      distinctSources: 0,
      text: '知识库索引不可用（RAG_INDEX_PATH 未配置或文件不存在）。',
      semanticAvailable: false,
      error: 'index unavailable',
    };
  }

  // 召回池：扩大后再做同源配额，避免配额后数量不足
  const pool = Math.max(k * 6, 30);
  const conn = getDb()!;
  const lexical = lexicalSearch(query, pool, topic);

  // 语义召回（可选）。失败时仍返回词法结果，但把原因带出去——
  // 静默降级正是实测缺陷 2（paraphrase 命中率 93%→7% 而界面无异常）。
  let semanticError: string | undefined;
  let merged = lexical;
  if (cfg.embedding.enabled) {
    const meta = readEmbeddingMeta(conn);
    if (meta === null) {
      semanticError = '索引未包含向量（需重建索引）';
    } else if (meta.model !== cfg.embedding.model) {
      semanticError = `索引向量由 ${meta.model} 生成，当前配置为 ${cfg.embedding.model}，请重建索引`;
    } else {
      const sem = await semanticSearch(conn, query, pool, cfg.embedding.model);
      if (sem.ok) merged = mergeByRowid(conn, lexical, sem.hits);
      else semanticError = sem.error;
    }
  }

  // 重排：只重排召回池的前若干条，失败即保留原序
  let reranked = false;
  let rerankError: string | undefined;
  if (cfg.rerank.enabled && merged.length > 1) {
    const head = merged.slice(0, Math.min(merged.length, RERANK_POOL));
    const rr = await rerank(query, head.map((h) => `${h.title}\n${h.body}`.slice(0, 1200)));
    if (rr.ok) {
      const ordered = rr.hits.map((x) => head[x.index]).filter((h): h is RagHit => h !== undefined);
      const rest = merged.slice(head.length);
      merged = [...ordered, ...rest];
      reranked = true;
    } else {
      rerankError = rr.error;
    }
  }

  const raw = merged;

  if (raw.length === 0) {
    const scope = topic !== null ? `（目录范围：${topic}）` : '';
    return {
      ok: true,
      hits: [],
      distinctSources: 0,
      text: [
        `未在知识库中找到相关文档${scope}。`,
        '建议：',
        '1. 换用日志中的异常类名或错误串原词（如 MixinTransformerError）再检索；',
        topic !== null
          ? '2. 去掉 topic 限定扩大到全库；'
          : '2. 尝试该异常链中 Caused by 后的类名（往往才是文档记录的）；',
        '3. 若确实未覆盖，改用 GitHub 或网络检索。',
      ].join('\n'),
      semanticAvailable: semanticError === undefined && cfg.embedding.enabled,
      mode: semanticError === undefined && cfg.embedding.enabled ? 'hybrid' : 'lexical',
      reranked,
      ...(semanticError !== undefined ? { semanticError } : {}),
      ...(rerankError !== undefined ? { rerankError } : {}),
    };
  }

  // ① 先按来源去重（多样性优先）
  const diverse = applySourceQuota(raw, SOURCE_QUOTA);
  const diverseKeys = new Set(diverse.map((h) => `${h.source}#${h.title}`));

  // ② 取前 k 个不同来源
  const selected = diverse.slice(0, k);

  // ③ 不足 k 时用剩余 chunk 补足（保证数量，但已优先多样性）
  if (selected.length < k) {
    for (const hit of raw) {
      if (selected.length >= k) break;
      const key = `${hit.source}#${hit.title}`;
      if (diverseKeys.has(key) && selected.includes(hit)) continue;
      if (selected.some((s) => `${s.source}#${s.title}` === key)) continue;
      selected.push(hit);
    }
  }

  const distinctSources = new Set(selected.map((h) => h.source)).size;

  const lines: string[] = [
    `在知识库中找到 ${selected.length} 条相关文档（来自 ${distinctSources} 个不同文件）：`,
    '',
  ];
  selected.forEach((hit, i) => {
    lines.push(`[${i + 1}] ${hit.title}`);
    lines.push(`    来源: ${hit.source}`);
    lines.push(`    片段: ${hit.snippet}`);
    lines.push('');
  });

  // 降级必须写进结果（修复实测缺陷 2：静默降级）
  if (semanticError !== undefined) {
    lines.push(`ℹ️ 语义检索已降级为纯词法：${semanticError}`);
  }
  if (!cfg.embedding.enabled) {
    lines.push(
      'ℹ️ 语义检索未启用，以上为纯词法检索结果。若结果不相关，请改用日志中出现的**精确词面**（异常类名原文、错误码）。',
    );
  }
  if (rerankError !== undefined) {
    lines.push(`ℹ️ 重排序已跳过：${rerankError}`);
  }

  return {
    ok: true,
    hits: selected,
    distinctSources,
    text: lines.join('\n'),
    semanticAvailable: semanticError === undefined && cfg.embedding.enabled,
    mode: semanticError === undefined && cfg.embedding.enabled ? 'hybrid' : 'lexical',
    reranked,
    ...(semanticError !== undefined ? { semanticError } : {}),
    ...(rerankError !== undefined ? { rerankError } : {}),
  };
}

/** 列出知识库主题（供 list_topics 工具） */
export function listTopics(): string {
  const conn = getDb();
  if (conn === null) {
    return '知识库索引不可用。';
  }

  try {
    const rows = conn
      .prepare(
        `SELECT source, count(*) AS chunks FROM docs
         GROUP BY source ORDER BY source`,
      )
      .all() as Array<{ source: string; chunks: number }>;

    const byTopic = new Map<string, { files: number; chunks: number }>();
    for (const row of rows) {
      const topic = row.source.split('/')[0] ?? 'other';
      const entry = byTopic.get(topic) ?? { files: 0, chunks: 0 };
      entry.files += 1;
      entry.chunks += row.chunks;
      byTopic.set(topic, entry);
    }

    const total = rows.reduce((sum, r) => sum + r.chunks, 0);
    const lines = [`知识库主题目录（共 ${rows.length} 个文件 / ${total} 个分块）：`, ''];
    for (const [topic, stat] of [...byTopic.entries()].sort()) {
      lines.push(`- ${topic}：${stat.files} 个文件，${stat.chunks} 个分块`);
    }
    lines.push('');
    lines.push('提示：检索时可直接给出异常类名或症状关键词，无需先选定目录。');
    return lines.join('\n');
  } catch (e) {
    return `读取主题失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 索引统计（供健康检查） */
export function stats(): { files: number; chunks: number } | null {
  const conn = getDb();
  if (conn === null) return null;
  try {
    const row = conn.prepare('SELECT count(*) AS chunks, count(DISTINCT source) AS files FROM docs').get() as
      | { chunks: number; files: number }
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** 供测试关闭连接 */
export function closeDb(): void {
  if (db !== null) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
    dbMtimeMs = 0;
  }
}
