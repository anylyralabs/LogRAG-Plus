/**
 * 语义召回：把知识库向量从 SQLite 读出、与 query 向量做余弦。
 *
 * 向量以 Float32 小端 BLOB 存储（build.ts 写入），读回时按 4 字节还原。
 */
import { DatabaseSync } from 'node:sqlite';

import { cosine, embedTexts } from './embed.ts';

/** 从库中读出向量模型名与维度；缺失或与当前配置不符时返回 null */
export function readEmbeddingMeta(conn: DatabaseSync): { model: string; dim: number } | null {
  try {
    const rows = conn
      .prepare('SELECT key, value FROM embedding_meta')
      .all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const model = map.get('model') ?? '';
    const dim = Number(map.get('dim') ?? 0);
    if (model === '' || !Number.isFinite(dim) || dim <= 0) return null;
    return { model, dim };
  } catch {
    return null;
  }
}

function blobToVector(buf: Uint8Array): number[] {
  const copy = buf.slice();
  const f32 = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  return Array.from(f32);
}

export interface SemanticHit {
  rowid: number;
  score: number;
}

/**
 * 语义召回。
 *
 * @returns 失败时 `ok:false`（调用方据此把「语义不可用」写进结果，而不是静默用词法冒充）
 */
export async function semanticSearch(
  conn: DatabaseSync,
  query: string,
  pool: number,
  expectedModel: string,
): Promise<{ ok: true; hits: SemanticHit[] } | { ok: false; error: string }> {
  const qv = await embedTexts([query]);
  if (!qv.ok) return { ok: false, error: qv.error };
  const queryVec = qv.vectors[0];
  if (queryVec === undefined) return { ok: false, error: 'query 向量为空' };

  let rows: Array<{ rowid: number; vec: Uint8Array }>;
  try {
    rows = conn.prepare('SELECT rowid, vec FROM doc_embeddings').all() as Array<{
      rowid: number;
      vec: Uint8Array;
    }>;
  } catch {
    return { ok: false, error: '索引中没有向量（需重建索引）' };
  }

  if (rows.length === 0) return { ok: false, error: '索引中没有向量（需重建索引）' };

  // 维度不符说明索引是用别的模型建的——硬算会得到无意义的分数
  const dim = queryVec.length;
  const first = rows[0]?.vec;
  if (first !== undefined && first.byteLength / 4 !== dim) {
    return {
      ok: false,
      error: `向量维度不匹配：索引 ${first.byteLength / 4} 维，当前模型 ${expectedModel} 为 ${dim} 维。请重建索引。`,
    };
  }

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    const vec = blobToVector(row.vec);
    hits.push({ rowid: row.rowid, score: cosine(queryVec, vec) });
  }
  hits.sort((a, b) => b.score - a.score);
  return { ok: true, hits: hits.slice(0, pool) };
}
