/**
 * 向量与重排序客户端（BGE / bge-reranker）。
 *
 * ## 为什么需要这一层，而不是内联在检索里
 *
 * 两件事的**失败语义完全不同**，混在一起必然写错：
 *
 * - **embedding** 是「索引侧 + 查询侧」两侧都要一致的东西。索引里存的是 1024 维
 *   bge-m3 向量，查询时换了模型维度就对不上；因此模型名必须随向量一起记进库，
 *   读到不匹配的向量应当**丢弃而不是硬算**（硬算会得到一个看似正常、实则无意义的分数）。
 * - **rerank** 只是对已有候选重排，失败了大不了退回原顺序，**绝不能让整个检索失败**。
 *
 * ## 降级纪律（这是本项目反复踩过的坑）
 *
 * 上游不可用 / 超时 / 余额异常时，一律**返回 null 并把原因带给调用方**，
 * 由调用方决定「显式告知用户已降级」。绝不静默返回空数组——
 * 那会让查询结果从「93% 命中」掉到「7% 命中」而界面上一切正常
 * （`search.ts` 头部记录的第 2 条实测缺陷就是这个）。
 */

import { rag as cfg } from '../config.ts';

/** 单次请求超时（向量化与重排都是短任务，10s 足够；超时即降级） */
const TIMEOUT_MS = 10_000;

/** 批量向量化的批大小：SiliconFlow 对单次 input 数组有条数上限，分批更稳 */
const EMBED_BATCH = 32;

export interface EmbeddingFailure {
  ok: false;
  /** 面向人的原因（会透出到检索结果里） */
  error: string;
}

export interface EmbeddingOk {
  ok: true;
  vectors: number[][];
}

export type EmbeddingResult = EmbeddingOk | EmbeddingFailure;

/**
 * 批量求向量。
 *
 * 返回顺序**与输入严格对应**——调用方靠下标把向量对回 chunk。
 * 若上游少返回或乱序，宁可整体失败也不猜（错位入库是最难查的一类脏数据）。
 */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult> {
  if (!cfg.embedding.enabled) {
    return { ok: false, error: '未配置向量模型（RAG_EMBEDDING_BASE_URL / RAG_EMBEDDING_MODEL）' };
  }
  if (texts.length === 0) return { ok: true, vectors: [] };

  const out: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const one = await embedBatch(batch);
    if (!one.ok) return one;
    out.push(...one.vectors);
  }

  return { ok: true, vectors: out };
}

async function embedBatch(texts: string[]): Promise<EmbeddingResult> {
  try {
    const res = await fetch(`${trimSlash(cfg.embedding.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.embedding.apiKey !== ''
          ? { authorization: `Bearer ${cfg.embedding.apiKey}` }
          : {}),
      },
      body: JSON.stringify({ model: cfg.embedding.model, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `向量接口 HTTP ${res.status}：${body}` };
    }

    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    };

    if (payload.error !== undefined) {
      return { ok: false, error: `向量接口错误：${payload.error.message ?? '未知'}` };
    }

    const data = payload.data ?? [];
    if (data.length !== texts.length) {
      return {
        ok: false,
        error: `向量数量不匹配：请求 ${texts.length} 条，返回 ${data.length} 条`,
      };
    }

    // 按 index 归位（有些实现会乱序返回）
    const ordered: number[][] = new Array(texts.length);
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (item === undefined || !Array.isArray(item.embedding)) {
        return { ok: false, error: '向量接口返回了空向量' };
      }
      const at = typeof item.index === 'number' ? item.index : i;
      if (at < 0 || at >= texts.length) {
        return { ok: false, error: `向量下标越界：${at}` };
      }
      ordered[at] = item.embedding;
    }
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i] === undefined) return { ok: false, error: `向量缺少下标 ${i}` };
    }

    return { ok: true, vectors: ordered };
  } catch (e) {
    return { ok: false, error: `向量请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface RerankHit {
  /** 原始下标（对回候选列表） */
  index: number;
  /** 相关性分数，越大越相关 */
  score: number;
}

export type RerankResult =
  | { ok: true; hits: RerankHit[] }
  | { ok: false; error: string };

/**
 * 重排候选。
 *
 * 失败时返回 `ok: false`，调用方**必须退回原顺序**而不是丢弃结果——
 * 重排只是优化，不是检索的前置条件。
 */
export async function rerank(query: string, documents: string[]): Promise<RerankResult> {
  if (!cfg.rerank.enabled) return { ok: false, error: '未配置重排序模型' };
  if (documents.length === 0) return { ok: true, hits: [] };

  try {
    const res = await fetch(`${trimSlash(cfg.rerank.baseUrl)}/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.rerank.apiKey !== '' ? { authorization: `Bearer ${cfg.rerank.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.rerank.model,
        query,
        documents,
        top_n: documents.length,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `重排序 HTTP ${res.status}：${body}` };
    }

    const payload = (await res.json()) as {
      /**
       * 响应形态不统一：SiliconFlow / Cohere 用 `results: [{index, relevance_score}]`，
       * 部分自建服务（vLLM / Xinference）直接返回裸数组 `[{index, score}]`。
       */
      results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      error?: { message?: string };
    };

    if (payload.error !== undefined) {
      return { ok: false, error: `重排序错误：${payload.error.message ?? '未知'}` };
    }

    const rows = payload.results;
    if (!Array.isArray(rows)) return { ok: false, error: '重排序响应格式无法识别' };

    const hits: RerankHit[] = [];
    for (const row of rows) {
      const index = row.index;
      const score = row.relevance_score ?? row.score;
      if (typeof index !== 'number' || typeof score !== 'number') continue;
      if (index < 0 || index >= documents.length) continue;
      hits.push({ index, score });
    }

    if (hits.length === 0) return { ok: false, error: '重排序未返回任何有效分数' };

    hits.sort((a, b) => b.score - a.score);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, error: `重排序请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** 余弦相似度（两个向量都必须是同一模型产出的） */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
