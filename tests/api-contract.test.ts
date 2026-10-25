/**
 * 接口字段契约守门。
 *
 * `api-doc.test.ts` 只校验「路由存在」——文档写了 `/v1/upload`，代码里也有，
 * 就算过。但它拦不住**同一个路由下字段名漂移**：
 *
 * | 实际发生的漂移 | 后果 |
 * |---|---|
 * | 上传响应返回 `id`，文档写 `logId` | 前端跳 `/undefined`，页面空白但无报错 |
 * | 会话回放返回顶层 `session` 对象，文档写 `sessionId` | 刷新即丢对话 |
 * | 领域知识新增只认 `content`，文档写 `text` | 保存成功但条目内容为空 |
 *
 * 这类缺陷的共性是**两边各自都正常**：服务端返回 200，前端拿着 `undefined`
 * 继续跑。因此只能靠「字段级断言」在 CI 里抓。
 *
 * 本文件不复刻全部字段（那会变成第二份 API 文档），只钉住**前端启动路径上
 * 必读的字段**——即「少了它界面就不可用」的那些。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { createTestDb } from './helpers/testdb.ts';

const tdb = await createTestDb();

process.env['LOGSHARE_INTERNAL_URL'] = '';
process.env['LOGSHARE_PUBLIC_API_URL'] = '';
process.env['AI_BASE_URL'] = 'http://127.0.0.1:9/v1';
process.env['AI_MODEL'] = 'stub-model';
// 管理接口需要显式开启：三态语义只在开启后才可测
process.env['ADMIN_ENABLED'] = 'true';
process.env['ADMIN_TOKEN'] = 'contract-test-token';

const { createHttpServer } = await import('../src/server/index.ts');
const { appendMessage, findOrCreateSession } = await import('../src/store/session.ts');
const { migrate } = await import('../src/store/migrate.ts');
const { closePool } = await import('../src/store/mysql.ts');
if (tdb.ok) await migrate();
const { createDomainKnowledge } = await import('../src/knowledge/domain.ts');

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

const ADMIN = { 'x-admin-token': 'contract-test-token' };

async function getJson(path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${origin}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── 会话回放 ─────────────────────────────────────────────

test('会话回放：前端必读字段都在（session.id / rounds / messages）', async () => {
  const s = await findOrCreateSession(null, 3600);
  await appendMessage(s.id, 'user', '你好');

  const { status, body } = await getJson(`/v1/session/${encodeURIComponent(s.id)}`);
  assert.equal(status, 200);

  // 文档曾写成顶层 sessionId —— 这里钉住真实形状
  const session = body['session'] as Record<string, unknown> | undefined;
  assert.ok(session !== undefined, '响应必须有 session 对象');
  assert.equal(typeof session['id'], 'string');
  assert.ok('logId' in session, 'session.logId 必须存在（可为 null）');
  assert.equal(typeof session['hasLog'], 'boolean', 'session.hasLog 必须存在：纯对话为 false，上传的会话为 true');
  assert.equal(session['hasLog'], false, '没有主日志的纯对话会话应报告 hasLog=false');
  assert.equal(typeof body['rounds'], 'object');
  assert.ok(Array.isArray(body['messages']));
  assert.equal(body['sessionId'], undefined, '顶层不应再出现 sessionId（避免两份来源）');
});

test('会话回放：消息字段名与前端类型一致', async () => {
  const s = await findOrCreateSession(null, 3600);
  await appendMessage(s.id, 'user', '问题');
  await appendMessage(s.id, 'assistant', '回答', { reasoning: '思维链' });

  const { body } = await getJson(`/v1/session/${encodeURIComponent(s.id)}`);
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const assistant = messages[1];
  assert.ok(assistant !== undefined);

  assert.equal(assistant['role'], 'assistant');
  assert.equal(typeof assistant['content'], 'string');
  assert.equal(typeof assistant['reasoning'], 'string');
  assert.equal(typeof assistant['createdAt'], 'number');
});

test('会话回放：hasLog 同时覆盖主日志与纯追加', async () => {
  const { putBase, appendSegment } = await import('../src/store/logbody.ts');

  // native 上传：主日志（seq=0）归属会话自身
  const native = await findOrCreateSession(null, 3600);
  await putBase(native.id, { content: '主日志正文' });
  const nativeRes = await getJson(`/v1/session/${encodeURIComponent(native.id)}`);
  assert.equal(
    (nativeRes.body['session'] as Record<string, unknown>)['hasLog'],
    true,
    '有主日志的会话必须报告 hasLog=true',
  );

  // 纯对话追加：没有 seq=0，但 seq>=1 同样构成可读正文
  const appended = await findOrCreateSession(null, 3600);
  await appendSegment(appended.id, { content: '后来补的崩溃报告' });
  const appendedRes = await getJson(`/v1/session/${encodeURIComponent(appended.id)}`);
  assert.equal(
    (appendedRes.body['session'] as Record<string, unknown>)['hasLog'],
    true,
    '纯对话被追加材料后也应报告 hasLog=true',
  );
});

// ── 上传 ─────────────────────────────────────────────────

test('上传：响应字段是 logId，不是 id（前端据此跳转）', async () => {
  // 未配置 LogShare 上传能力 → 503，但**参数校验在转发之前**。
  // 这里只验「有 logId 这个字段契约」需要走成功路径，故直接断言失败路径的
  // 错误语义，同时用类型层断言字段名（见下一条针对成功形状的静态检查）。
  const res = await fetch(`${origin}/v1/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'log line' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(body.error.includes('LogShare'), '错误应指明未配置 LogShare 上传能力');
});

test('上传：源码返回 logId 而不是 id（字段名静态守门）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server/index.ts', import.meta.url), 'utf8');

  // 定位上传成功响应块
  const start = src.indexOf('async function handleUpload');
  assert.ok(start >= 0, '找不到 handleUpload');
  const block = src.slice(start, start + 6000);

  // 架构改革后：上传直接落本库，返回的 logId 就是**会话 ID**（URL 形态 /s/{id}）
  assert.match(block, /logId:\s*session\.id/, '上传响应必须用 logId 字段（值为会话 ID）');
  assert.doesNotMatch(block, /^\s*id:\s*session\.id/m, '不应再返回裸 id 字段');
  // 反混淆改为同步执行，用真实结果代替旧的「可能未完成」占位
  assert.match(block, /deobfuscated:\s*deob\.changed/, '必须回报反混淆是否生效');
});

// ── 领域知识 ─────────────────────────────────────────────

test('领域知识：新增字段是 content（不是 text）', async () => {
  const created = await fetch(`${origin}/v1/admin/domain-knowledge`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '契约测试：某 GPU 不支持某特性。' }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { ok: boolean; entry?: { id: string; content: string } };
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.entry?.content, '契约测试：某 GPU 不支持某特性。');

  // `text` 字段**不被采纳**：宁可表现为「内容为空被拒」，也不要静默存一条空条目
  const wrong = await fetch(`${origin}/v1/admin/domain-knowledge`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '用错字段名的内容。' }),
  });
  assert.equal(wrong.status, 400, '只传 text 时应当拒绝，而不是静默存空');

  // 清理，避免影响同文件后续断言
  if (createdBody.entry !== undefined) {
    await fetch(`${origin}/v1/admin/domain-knowledge/${encodeURIComponent(createdBody.entry.id)}`, {
      method: 'DELETE',
      headers: ADMIN,
    });
  }
});

test('领域知识：列表响应结构（entries / stats）', async () => {
  await createDomainKnowledge({ content: '契约测试：这是一条先验事实断言。' });

  const { status, body } = await getJson('/v1/admin/domain-knowledge', ADMIN);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body['entries']));
  const stats = body['stats'] as Record<string, unknown> | undefined;
  assert.ok(stats !== undefined);
  assert.equal(typeof stats['total'], 'number');
  assert.equal(typeof stats['enabled'], 'number');
  assert.equal(typeof stats['injectedChars'], 'number');

  const entries = body['entries'] as Array<Record<string, unknown>>;
  const first = entries[0];
  assert.ok(first !== undefined);
  assert.equal(typeof first['id'], 'string');
  assert.equal(typeof first['content'], 'string');
  assert.equal(typeof first['enabled'], 'boolean');
  assert.ok(Array.isArray(first['tags']));
});

// ── 分析记录 ─────────────────────────────────────────────

test('分析记录：列表带 total，记录字段与前端类型一致', async () => {
  const { status, body } = await getJson('/v1/admin/records?limit=5', ADMIN);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body['records']));
  assert.equal(typeof body['total'], 'number');

  const records = body['records'] as Array<Record<string, unknown>>;
  const first = records[0];
  if (first !== undefined) {
    // 看板与详情抽屉都直接读这些字段
    for (const key of ['id', 'overall', 'deliverable', 'rounds', 'toolCalls', 'rootCause']) {
      assert.ok(key in first, `记录缺少字段 ${key}`);
    }
  }
});

test('分析记录：统计字段形状', async () => {
  const { status, body } = await getJson('/v1/admin/records/stats', ADMIN);
  assert.equal(status, 200);
  const stats = body['stats'] as Record<string, unknown>;
  assert.ok(stats !== undefined);
  for (const key of ['total', 'sampled', 'truncated', 'scoreBuckets', 'topDeductions', 'byModel']) {
    assert.ok(key in stats, `统计缺少字段 ${key}`);
  }
  const dims = stats['dimensions'] as Record<string, unknown>;
  for (const key of ['grounding', 'verification', 'actionability', 'economy']) {
    assert.ok(key in dims, `维度缺少 ${key}`);
  }
});

// ── 健康检查 ─────────────────────────────────────────────

test('健康检查：rag 与 config 形状', async () => {
  const { status, body } = await getJson('/health');
  assert.equal(status, 200);
  assert.equal(body['service'], 'lograg-plus');
  const rag = body['rag'] as Record<string, unknown>;
  assert.equal(typeof rag['chunks'], 'number');
  assert.equal(typeof rag['files'], 'number');
  assert.equal(typeof body['config'], 'object');
});
