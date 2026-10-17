/**
 * 语义检索与重排序的守门测试。
 *
 * 全部用本地假服务，不连真实 API（测试必须离线、确定性）。
 * 守的核心是**降级必须可见**：语义不可用时要显式报错，而不是静默用词法冒充。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-semantic-'));

/** 假上游：向量维度可控，重排序分数可控 */
let embedDim = 4;
let embedFails = false;
/** 只返回前 N 条（模拟上游少返回） */
let embedShort: number | null = null;
let rerankFails = false;
let embedCalls = 0;
let rerankCalls = 0;

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: string) => (body += c));
  req.on('end', () => {
    if (req.url === '/embeddings') {
      embedCalls++;
      if (embedFails) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '余额不足' } }));
        return;
      }
      const parsed = JSON.parse(body) as { input: string[] };
      const data = parsed.input.map((_t, index) => ({
        index,
        embedding: Array.from({ length: embedDim }, (_v, i) => (i === 0 ? 1 : 0.1 * (index + 1))),
      }));
      const out = embedShort === null ? data : data.slice(0, embedShort);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: out }));
      return;
    }
    if (req.url === '/rerank') {
      rerankCalls++;
      if (rerankFails) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '上游挂了' } }));
        return;
      }
      const parsed = JSON.parse(body) as { documents: string[] };
      const results = parsed.documents.map((d, index) => ({
        index,
        relevance_score: d.includes('命中') ? 0.9 : 0.1,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
const addr = fake.address();
if (addr === null || typeof addr === 'string') throw new Error('假上游未监听');
const origin = `http://127.0.0.1:${addr.port}`;

process.env['DATA_DIR'] = testDir;
process.env['RAG_EMBEDDING_BASE_URL'] = origin;
process.env['RAG_EMBEDDING_MODEL'] = 'test-embed';
process.env['RAG_RERANK_BASE_URL'] = origin;
process.env['RAG_RERANK_MODEL'] = 'test-rerank';

const { embedTexts, rerank, cosine } = await import('../src/rag/embed.ts');

test.after(() => {
  fake.close();
  rmSync(testDir, { recursive: true, force: true });
});

// ── 向量 ────────────────────────────────────────────────

test('向量：返回顺序与输入严格对应（错位入库是最难查的脏数据）', async () => {
  embedFails = false;
  const r = await embedTexts(['a', 'b', 'c']);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.vectors.length, 3);
  // 假上游按 index 生成递增的第二维，据此可判断是否归位
  assert.notDeepEqual(r.vectors[0], r.vectors[1]);
  assert.notDeepEqual(r.vectors[1], r.vectors[2]);
  assert.ok(r.vectors.every((v) => v.length === embedDim));
});

test('向量：批量超过批大小时仍完整（分批拼接不丢项）', async () => {
  embedFails = false;
  const texts = Array.from({ length: 70 }, (_v, i) => `t${i}`);
  const r = await embedTexts(texts);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.vectors.length, 70);
});

test('向量：上游少返回时整体失败，不猜（错位拼进索引后再也查不出来）', async () => {
  embedShort = 2; // 请求 5 条却只给 2 条
  const r = await embedTexts(['a', 'b', 'c', 'd', 'e']);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /数量不匹配/);
  embedShort = null;
});

test('向量：上游报错时把原因带出来（不静默降级）', async () => {
  embedFails = true;
  const r = await embedTexts(['x']);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /余额不足|HTTP 402/);
  embedFails = false;
});

// ── 余弦 ────────────────────────────────────────────────

test('余弦：同向量为 1、正交为 0、维度不同为 0', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

// ── 重排序 ──────────────────────────────────────────────

test('重排：按分数降序返回原始下标', async () => {
  rerankFails = false;
  const r = await rerank('q', ['无关 A', '命中 B', '无关 C']);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hits[0]?.index, 1, '含「命中」的那条应排第一');
  assert.ok(r.hits[0]!.score > r.hits[1]!.score);
});

test('重排：失败时明确返回 ok:false（调用方据此保留原序）', async () => {
  rerankFails = true;
  const r = await rerank('q', ['a', 'b']);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /500|上游挂了/);
  rerankFails = false;
});

test('重排：空文档列表不发请求', async () => {
  const before = rerankCalls;
  const r = await rerank('q', []);
  assert.equal(r.ok, true);
  assert.equal(rerankCalls, before, '空列表不该打上游');
});
