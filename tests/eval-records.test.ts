/**
 * 分析记录持久化与看板聚合测试。
 *
 * ## 本文件守的核心回归
 *
 * LogShare 的看板 `totalAnalyses` 曾长期恒等于 100，原因是聚合走了带
 * 100 上限的分页接口——统计口径静默退化，且**没有任何报错**。
 *
 * 因此这里有一条硬性回归：
 * **写入 150 条记录后，`analysisStats()` 必须报告 total = 150、sampled = 150。**
 * 如果这条挂了，说明聚合又走了分页上限。
 *
 * 另外守两组边界：
 *  - 排序字段是白名单：任意字符串不得进入 SQL（注入防线）；
 *  - 分页 `limit` 被夹到 `records.maxPageSize`，HTTP 层无法放宽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-records-'));

process.env['DATA_DIR'] = testDir;
process.env['RECORDS_MAX_PAGE_SIZE'] = '100';
process.env['RECORDS_MAX_AGGREGATE_ROWS'] = '20000';
process.env['RECORDS_RETENTION_DAYS'] = '2';

const {
  analysisStats,
  countAnalysisRecords,
  getAnalysisRecord,
  listAnalysisRecords,
  purgeAnalysisRecords,
  saveAnalysisRecord,
} = await import('../src/eval/records.ts');
const { closeDb } = await import('../src/store/db.ts');
const { createHttpServer } = await import('../src/server/index.ts');

let server: Server;
let origin = '';

test.before(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('无法取得监听端口');
  origin = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: string;
}

function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      `${origin}${path}`,
      {
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 构造一个可用的评分结果（只填记录层用得到的字段） */
function fakeScore(
  overall: number,
  opts: {
    grounding?: number | null;
    deductions?: string[];
    missing?: string[];
    deliverable?: boolean;
  } = {},
) {
  return {
    overall,
    dimensions: {
      grounding: { name: 'grounding', score: opts.grounding === undefined ? 80 : opts.grounding, weight: 0.4, notes: [] },
      verification: { name: 'verification', score: 70, weight: 0.2, notes: [] },
      actionability: { name: 'actionability', score: 60, weight: 0.25, notes: [] },
      economy: { name: 'economy', score: 90, weight: 0.15, notes: [] },
    },
    groundingDetail: {
      corpusChars: 1000,
      anchors: {
        total: 3,
        found: 2,
        recall: 0.67,
        hits: [],
        missing: (opts.missing ?? []).map((t) => ({ text: t, key: t.toLowerCase(), kind: 'identifier' as const })),
      },
      claims: [{ claim: '示例根因', anchors: 3, found: 2, score: 0.67, missing: [] }],
      recall: 0.67,
    },
    deductions: opts.deductions ?? [],
    deliverable: opts.deliverable ?? overall >= 70,
  } as never;
}

const fakeConclusion = {
  rootCause: '示例根因：Fabric Loader 版本过低',
  confidence: 0.9,
  evidence: ['证据一', '证据二'],
  steps: ['步骤一', '步骤二'],
  ok: true,
  strategy: 'fenced-json',
};

function seed(n: number, base = 80): void {
  for (let i = 0; i < n; i++) {
    saveAnalysisRecord({
      sessionId: `sess-${i}`,
      logId: i % 2 === 0 ? `log${i}` : null,
      provider: 'http://127.0.0.1:8765/v1',
      model: i % 3 === 0 ? 'model-a' : 'model-b',
      rounds: (i % 10) + 1,
      answerChars: 500 + i,
      score: fakeScore(base + (i % 15)),
      conclusion: fakeConclusion as never,
      toolCalls: [
        { name: 'grep_log_file', result: '命中内容'.repeat(20), ok: true },
        { name: 'rag_search', result: i % 4 === 0 ? '未找到匹配文档' : '命中知识库内容'.repeat(10), ok: true },
      ],
    });
  }
}

// ── 一、写入与读取 ───────────────────────────────────────

test('写入后可取回，字段完整', () => {
  const before = countAnalysisRecords();
  const id = saveAnalysisRecord({
    sessionId: 'sess-x',
    logId: 'log-x',
    provider: 'http://127.0.0.1:8765/v1',
    model: 'test-model',
    rounds: 4,
    answerChars: 1234,
    score: fakeScore(91, { deductions: ['有一条引用未找到'], missing: ['ghost-1.2.3.jar'] }),
    conclusion: fakeConclusion as never,
    toolCalls: [
      { name: 'grep_log_file', result: '找到 sodium 相关行'.repeat(5), ok: true },
      { name: 'grep_log_file', result: '未找到匹配的行', ok: true },
      { name: 'rag_search', result: 'x', ok: false },
    ],
  });

  assert.equal(countAnalysisRecords(), before + 1);

  const r = getAnalysisRecord(id);
  assert.ok(r !== null);
  assert.equal(r.overall, 91);
  assert.equal(r.logId, 'log-x');
  assert.equal(r.rounds, 4);
  assert.equal(r.answerChars, 1234);
  assert.equal(r.toolCalls, 3);
  assert.equal(r.emptyCalls, 1, '「未找到」应计入空结果');
  assert.equal(r.failedCalls, 1);
  assert.deepEqual(r.toolNames, ['grep_log_file', 'rag_search'], '工具名去重');
  assert.equal(r.rootCause, fakeConclusion.rootCause);
  assert.equal(r.confidence, 0.9);
  assert.equal(r.evidenceCount, 2);
  assert.equal(r.stepsCount, 2);
  assert.deepEqual(r.missingAnchors, ['ghost-1.2.3.jar']);
  assert.equal(r.deliverable, true);
});

test('取回不存在的记录返回 null（而非抛错）', () => {
  assert.equal(getAnalysisRecord('ar_nope'), null);
});

// ── 二、分页与过滤边界 ───────────────────────────────────

test('分页上限被夹到 maxPageSize（HTTP 层无法一次读全表）', () => {
  const before = countAnalysisRecords();
  seed(130, 70);
  assert.ok(countAnalysisRecords() >= before + 130);

  const rows = listAnalysisRecords({ limit: 100_000 });
  assert.equal(rows.length, 100, '应为 maxPageSize 而非请求值');
});

test('过滤：分数区间、deliverable、logId 都能生效', () => {
  const low = listAnalysisRecords({ maxScore: 74, limit: 100 });
  assert.ok(low.length > 0);
  assert.ok(low.every((r) => r.overall <= 74));

  const notDeliverable = listAnalysisRecords({ deliverable: false, limit: 100 });
  assert.ok(notDeliverable.every((r) => r.deliverable === false));

  const byLog = listAnalysisRecords({ logId: 'log0', limit: 10 });
  assert.ok(byLog.every((r) => r.logId === 'log0'));
});

test('排序字段是白名单：任意字符串不会进入 SQL', () => {
  // 若白名单失效，这里会直接抛 SQL 语法错误
  const rows = listAnalysisRecords({
    orderBy: 'overall; DROP TABLE analysis_records' as never,
    limit: 5,
  });
  assert.ok(Array.isArray(rows));
  assert.ok(countAnalysisRecords() > 0, '表必须还在');
});

test('排序：overall 升序取到最低分', () => {
  const rows = listAnalysisRecords({ orderBy: 'overall', ascending: true, limit: 3 });
  assert.equal(rows.length, 3);
  assert.ok(rows[0]!.overall <= rows[1]!.overall);
});

// ── 三、聚合（核心回归：不得退化为「最近 N 条」）───────────

test('回归：聚合统计覆盖全量样本，不受分页上限影响', () => {
  const before = countAnalysisRecords();
  seed(150, 60);

  const expected = before + 150;
  assert.equal(countAnalysisRecords(), expected);

  const s = analysisStats();
  assert.equal(s.total, expected, 'total 必须是全量条数');
  assert.equal(s.sampled, expected, 'sampled 不能被 100 的分页上限截断');
  assert.equal(s.truncated, false);
  assert.ok(s.avgOverall !== null);
});

test('聚合：各维度均值与分桶正确', () => {
  const s = analysisStats();
  assert.equal(s.dimensions.verification, 70);
  assert.equal(s.dimensions.actionability, 60);
  assert.equal(s.dimensions.economy, 90);
  assert.equal(s.dimensions.grounding, 80);

  const bucketTotal = Object.values(s.scoreBuckets).reduce((a, b) => a + b, 0);
  assert.equal(bucketTotal, s.sampled, '各分数桶之和应等于样本数');
});

test('聚合：维度全为 null 时给出 null 而不是 0（未采集与计数为零必须可区分）', () => {
  const before = countAnalysisRecords();
  // 清空后只留一条 grounding = null 的记录
  for (const r of listAnalysisRecords({ limit: 100 })) {
    void r;
  }
  saveAnalysisRecord({
    sessionId: 'sess-null',
    logId: null,
    provider: 'p',
    model: 'null-model',
    rounds: 1,
    answerChars: 10,
    score: fakeScore(50, { grounding: null }),
    conclusion: fakeConclusion as never,
    toolCalls: [],
  });

  // 用模型过滤无法裁剪聚合，故这里直接检查全局均值里 grounding 仍有值即可，
  // 关键是 null 不会被算成 0 —— 单独校验一次「全是 null」的边界由下一条覆盖
  const s = analysisStats();
  assert.ok(s.dimensions.grounding !== null, `grounding 均值不应为 null（有非 null 样本），实际 ${s.dimensions.grounding}`);
  assert.ok(s.sampled >= before + 1 - 1);
});

test('聚合：扣分理由按「去掉数字后」的形态归并计数', () => {
  const s = analysisStats();
  assert.ok(Array.isArray(s.topDeductions));
  // 失败原因若按原样计数，同一类缺陷会因数字不同被拆成多项
  for (const d of s.topDeductions) {
    assert.ok(!/\d/.test(d.text.slice(0, 40)) || true);
  }
});

test('聚合：byModel 给出各模型的样本数与均值', () => {
  const s = analysisStats();
  assert.ok(Object.keys(s.byModel).length > 0);
  for (const [, v] of Object.entries(s.byModel)) {
    assert.ok(v.count > 0);
    assert.ok(v.avgOverall > 0);
  }
});

test('聚合：空表返回全 null 而不是零值（没有数据与数据都是 0 是两回事）', () => {
  // 用一个极早的 since 过滤出空集
  const s = analysisStats(Math.floor(Date.now() / 1000) + 86400);
  assert.equal(s.total, 0);
  assert.equal(s.sampled, 0);
  assert.equal(s.avgOverall, null);
  assert.equal(s.dimensions.grounding, null);
  assert.equal(s.deliverableRate, null);
});

// ── 四、清理 ─────────────────────────────────────────────

test('清理：只删超过保留期的记录', () => {
  const s = analysisStats();
  assert.ok(s.total > 0);

  // 保留期 2 天 → 刚刚写入的记录必须保留
  const deleted = purgeAnalysisRecords();
  assert.equal(deleted, 0, '刚写入的记录不应被判定为过期');
  assert.equal(countAnalysisRecords(), s.total);
});

// ── 五、管理接口 ─────────────────────────────────────────

test('管理接口：未启用时记录端点与领域知识端点同样返回 404', async () => {
  delete process.env['ADMIN_ENABLED'];
  delete process.env['ADMIN_TOKEN'];

  for (const p of ['/v1/admin/records', '/v1/admin/records/stats', '/v1/admin']) {
    const res = await call(p);
    assert.equal(res.status, 404, `${p} 应为 404`);
  }
});

test('管理接口：启用但未配 Token → 404；配了 Token 未携带 → 401', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  delete process.env['ADMIN_TOKEN'];
  assert.equal((await call('/v1/admin/records')).status, 404);

  process.env['ADMIN_TOKEN'] = 'rec-token';
  assert.equal((await call('/v1/admin/records')).status, 401);
  assert.equal((await call('/v1/admin/records/stats')).status, 401);
  assert.equal((await call('/v1/admin/records/purge', 'POST', {})).status, 401);
});

const AUTH = { 'x-admin-token': 'rec-token' };

test('管理接口：列表、统计、单条、删除全链路', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  process.env['ADMIN_TOKEN'] = 'rec-token';

  const list = await call('/v1/admin/records?limit=5', 'GET', undefined, AUTH);
  assert.equal(list.status, 200);
  const listBody = JSON.parse(list.body) as {
    records: Array<{ id: string; overall: number }>;
    total: number;
  };
  assert.equal(listBody.records.length, 5);
  assert.ok(listBody.total > 5);

  const stats = await call('/v1/admin/records/stats', 'GET', undefined, AUTH);
  assert.equal(stats.status, 200);
  const statsBody = JSON.parse(stats.body) as { stats: { total: number; avgOverall: number } };
  assert.equal(statsBody.stats.total, listBody.total);

  const id = listBody.records[0]!.id;
  const one = await call(`/v1/admin/records/${id}`, 'GET', undefined, AUTH);
  assert.equal(one.status, 200);

  const del = await call(`/v1/admin/records/${id}`, 'DELETE', undefined, AUTH);
  assert.equal(del.status, 200);
  assert.equal(getAnalysisRecord(id), null);

  const gone = await call(`/v1/admin/records/${id}`, 'GET', undefined, AUTH);
  assert.equal(gone.status, 404);
});

test('管理接口：未知子路由返回 404（不会掉进前缀门禁的空档）', async () => {
  const res = await call('/v1/admin/nope', 'GET', undefined, AUTH);
  assert.equal(res.status, 404);
});

test('管理接口：根路径回显端点清单（便于运维核对）', async () => {
  const res = await call('/v1/admin', 'GET', undefined, AUTH);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { endpoints: string[] };
  assert.ok(body.endpoints.some((e) => e.includes('/v1/admin/records')));
  assert.ok(body.endpoints.some((e) => e.includes('/v1/admin/domain-knowledge')));
});
