/**
 * HTTP 服务测试。
 *
 * ## 本文件守的是什么
 * 2026-10-17 复核生产分析记录与服务端代码时，发现 5 个「实现了但从未接线」的缺陷：
 *
 * | # | 缺陷 | 后果 |
 * |---|---|---|
 * | 1 | `body.sessionId` 只回传、从不读取 | 客户端**无法延续会话**，每轮新建，历史与轮次计数失效 |
 * | 2 | `getSession` / `getHistory` 仅测试调用 | 前端刷新即丢对话，无任何接口能取回历史 |
 * | 3 | `cleanupExpired` 仅测试调用 | `sessions`/`messages` 只增不减 |
 * | 4 | 轮次上限有两份实现（一份读环境变量） | 口径漂移；环境变量非法值时 `used < NaN` 恒 false，会话永久锁死 |
 * | 5 | `fetchLog` 从未被调用 | 只传 `logId`（主入口形态）时模型拿不到正文、日志工具被禁用 |
 *
 * ## 为什么这些测试不需要模型
 * `handleChat` 的副作用发生在模型调用之前：
 * 会话解析 → 轮次检查 → 记录用户消息 → 配额 → 供应商校验 → 取日志 → 模型。
 * 因此只要让请求停在「取日志失败」或「轮次超限」，就能验证会话/消息行为，
 * 而**不产生任何真实模型调用**（测试可离线、确定性、快速）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

import { createTestDb } from './helpers/testdb.ts';

const tdb = await createTestDb();

// ⚠️ 必须在 import 之前设置：config.ts 在模块加载时即读取环境变量。
// 独立运行模式（未配置内部 API）→ fetchLog 快速失败，不产生网络请求
process.env['LOGSHARE_INTERNAL_URL'] = '';
process.env['LOGSHARE_PUBLIC_API_URL'] = '';
// 配一个假供应商：让请求能通过「供应商未配置」检查而走到取日志这一步，
// 从而验证 fetchLog 确实被调用（该地址永远不会被真正访问）
process.env['AI_BASE_URL'] = 'http://127.0.0.1:9/v1';
process.env['AI_MODEL'] = 'stub-model';
// 轮次上限设为 3，便于用少量消息触发（亦验证上限确实来自配置）
process.env['QUOTA_ROUNDS_PER_SESSION'] = '3';

const { createHttpServer } = await import('../src/server/index.ts');
const { appendMessage, findOrCreateSession, getHistory } = await import('../src/store/session.ts');
const { migrate } = await import('../src/store/migrate.ts');
const { closePool } = await import('../src/store/mysql.ts');
if (tdb.ok) await migrate();

let server: Server;
let origin = '';

test.before(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('无法取得监听端口');
  origin = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await closePool();
  await tdb.dispose();
});

/** 原始 HTTP GET（用于发送 fetch 会改写/拒绝的畸形路径） */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  const addr = server.address();
  const port = addr !== null && typeof addr !== 'string' ? addr.port : 0;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 发送对话请求，返回状态码与响应文本（不解析 SSE） */
async function postChat(payload: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.text() };
}

// ── 基础路由 ─────────────────────────────────────────────

test('健康检查', async () => {
  const res = await fetch(`${origin}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, 'lograg-plus');
});

test('知识库主题端点可用（未配置索引时也不报错）', async () => {
  const res = await fetch(`${origin}/v1/topics`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; topics: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.topics, 'string');
});

test('未知路由返回 404', async () => {
  const res = await fetch(`${origin}/v1/nope`);
  assert.equal(res.status, 404);
});

test('CORS 预检返回 204', async () => {
  const res = await fetch(`${origin}/v1/chat`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
});

// ── 缺陷 2：会话回放路由 ─────────────────────────────────

test('会话回放：不存在的会话返回 404', async () => {
  const res = await fetch(`${origin}/v1/session/snonexistent000`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('会话回放：返回消息与轮次余量', async () => {
  const s = await findOrCreateSession(null, 3600);
  await appendMessage(s.id, 'user', '第一条问题');
  await appendMessage(s.id, 'assistant', '第一条回答', { reasoning: '思维链内容' });

  const res = await fetch(`${origin}/v1/session/${encodeURIComponent(s.id)}`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    ok: boolean;
    session: { id: string; logId: string | null };
    rounds: { allowed: boolean; remaining: number };
    messages: Array<{ role: string; content: string; reasoning?: string; score?: unknown }>;
  };

  assert.equal(body.ok, true);
  assert.equal(body.session.id, s.id);
  assert.equal(body.session.logId, null);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.content, '第一条问题');
  // 思维链要一并返回——前端「深度分析」面板依赖它
  assert.equal(body.messages[1]?.reasoning, '思维链内容');
  // 已用 1 轮，上限 3 → 剩 2
  assert.equal(body.rounds.remaining, 2);
  assert.equal(body.rounds.allowed, true);
});

test('会话回放：自评摘要随消息返回（刷新后自检面板不丢）', async () => {
  const s = await findOrCreateSession(null, 3600);
  await appendMessage(s.id, 'user', '为什么崩溃？');
  await appendMessage(s.id, 'assistant', '根因是…', { reasoning: '推理', score: {
    overall: 88,
    deliverable: true,
    dimensions: { grounding: 76, verification: 100, actionability: 80, economy: 100 },
    deductions: ['有 2 条断言缺少可核实标识'],
    missingAnchors: ['libGL.so'],
  } });

  const res = await fetch(`${origin}/v1/session/${encodeURIComponent(s.id)}`);
  const body = (await res.json()) as {
    messages: Array<{ role: string; score?: { overall: number; missingAnchors: string[] } }>;
  };

  assert.equal(body.messages[1]?.score?.overall, 88);
  assert.deepEqual(body.messages[1]?.score?.missingAnchors, ['libGL.so']);
  // 用户消息不应带自评
  assert.equal(body.messages[0]?.score, undefined);
});

// ── 自定义供应商 SSRF 门禁 ───────────────────────────────

test('对话：自定义供应商指向回环地址被拒绝（SSRF）', async () => {
  const res = await postChat({
    message: '测试供应商地址',
    provider: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'stub' },
  });

  assert.equal(res.status, 400);
  const body = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(body.error.includes('供应商'), `错误应指明供应商地址，实际：${body.error}`);
});

test('对话：自定义供应商指向链路本地地址被拒绝', async () => {
  const res = await postChat({
    message: '测试元数据端点',
    provider: { baseUrl: 'http://169.254.169.254/latest/meta-data/', apiKey: '', model: 'stub' },
  });

  assert.equal(res.status, 400);
});

test('会话回放：畸形百分号编码返回 400（不能冒泡成 500）', async () => {
  const r = await rawGet('/v1/session/%E0%A4%A');
  assert.equal(r.status, 400);
});

test('会话回放：会话 ID 为空返回 400', async () => {
  const r = await rawGet('/v1/session/');
  assert.equal(r.status, 400);
});

// ── 缺陷 1：sessionId 必须被读取 ────────────────────────

test('对话：显式 sessionId 被复用（消息落到该会话）', async () => {
  const s = await findOrCreateSession(null, 3600);
  const before = (await getHistory(s.id)).length;

  // 带 logId 但不带正文 → 会在「取日志」处 404 提前返回，
  // 从而不触发任何模型调用，但会话与用户消息的副作用已经发生。
  const res = await postChat({ message: '第二轮追问', sessionId: s.id, logId: '1WiQ8HE' });
  assert.equal(res.status, 404);

  const after = await getHistory(s.id);
  assert.equal(after.length, before + 1, '用户消息应落到传入的会话');
  assert.equal(after[after.length - 1]?.content, '第二轮追问');
});

test('对话：未知 sessionId 不被采纳，原会话不受影响', async () => {
  const s = await findOrCreateSession(null, 3600);
  await appendMessage(s.id, 'user', '原会话消息');
  const before = (await getHistory(s.id)).length;

  const res = await postChat({
    message: '不应落到原会话',
    sessionId: 'sdoesnotexist99',
    logId: '1WiQ8HE',
  });
  assert.equal(res.status, 404);

  const after = await getHistory(s.id);
  assert.equal(after.length, before, '未知 sessionId 不应把消息写进别的会话');
});

// ── 缺陷 5：只给 logId 必须真的去取日志 ──────────────────

test('对话：只给 logId 时确实调用了取日志（未配置读能力时给出明确错误）', async () => {
  const res = await postChat({ message: '帮我看看这份日志', logId: '1WiQ8HE' });

  // 关键：返回 JSON 404 而不是开始 SSE 流——证明在调用模型之前就退出了
  assert.equal(res.status, 404);

  const body = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  // 断言措辞时只锚定「读能力未配置」这一语义，不锚定整句——
  // 文案会随场景细分（内部地址 / 公网地址分别缺失）而变化。
  assert.ok(
    body.error.includes('未配置') && body.error.includes('LOGSHARE_'),
    `错误信息应指明未配置 LogShare 读能力（证明 fetchLog 被调用），实际：${body.error}`,
  );
});

test('对话：非法日志 ID 也能明确报错', async () => {
  const res = await postChat({ message: 'x', logId: '!!!' });
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body) as { ok: boolean };
  assert.equal(body.ok, false);
});

// ── 缺陷 4：轮次上限来自配置 ────────────────────────────

test('对话：轮次超限返回 429，且上限来自配置（QUOTA_ROUNDS_PER_SESSION=3）', async () => {
  const s = await findOrCreateSession(null, 3600);
  for (let i = 0; i < 3; i++) {
    await appendMessage(s.id, 'user', `第 ${i} 轮`);
  }

  const res = await postChat({ message: '第四轮', sessionId: s.id });
  assert.equal(res.status, 429);

  const body = JSON.parse(res.body) as { remaining: number; sessionId: string };
  assert.equal(body.remaining, 0);
  assert.equal(body.sessionId, s.id);
});

// ── 请求校验 ────────────────────────────────────────────

test('对话：空 message 返回 400', async () => {
  const res = await postChat({ message: '   ' });
  assert.equal(res.status, 400);
});

test('对话：请求体非法 JSON 返回 400', async () => {
  const res = await fetch(`${origin}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ 不是 JSON',
  });
  assert.equal(res.status, 400);
});
