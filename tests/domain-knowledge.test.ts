/**
 * 已知领域知识测试。
 *
 * ## 本文件守的是什么
 *
 * 领域知识会**原文拼进每一次分析的系统提示词**，等于间接改写所有用户的结论。
 * 因此这里守三类边界：
 *
 *  1. **写入边界**：超长、空内容、重复条目必须被拒；方法论条目被**提醒**但不硬拦
 *     （误判成本高于放过成本，理由见 `src/knowledge/domain.ts` 文件头）。
 *  2. **注入边界**：优先级排序、预算截断、被跳过条目要显式告知模型；
 *     提示词里的编号列表不能被多行内容破坏。
 *  3. **访问边界（fail-closed）**：管理接口未启用 → 404；启用了但没配 Token → 仍然 404；
 *     配了 Token 但请求没带 → 401。绝不能出现「一次漏配就公网可写」。
 *
 * `ADMIN_ENABLED` / `ADMIN_TOKEN` 走 getter 实时读取，故可在同一进程内先验 404、
 * 再验 401、最后验成功——三条路径都覆盖到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-dk-'));

// ⚠️ 必须在 import 之前设置：config.ts 的部分字段在模块加载时即固化
process.env['DATA_DIR'] = testDir;
// 小预算：便于用少量条目触发截断分支
process.env['DOMAIN_KNOWLEDGE_BUDGET_CHARS'] = '300';
// 注入门槛设为 5：priority < 5 的条目只可检索、不进提示词
process.env['DOMAIN_KNOWLEDGE_INJECT_MIN_PRIORITY'] = '5';

const {
  classifyEntry,
  createDomainKnowledge,
  domainKnowledgeAudit,
  domainKnowledgeStats,
  getDomainKnowledge,
  listDomainKnowledge,
  removeDomainKnowledge,
  renderDomainKnowledgeSection,
  searchDomainKnowledge,
  updateDomainKnowledge,
} = await import('../src/knowledge/domain.ts');
const { closeDb } = await import('../src/store/db.ts');
const { buildTools, createToolContext } = await import('../src/agent/tools/index.ts');
const { createHttpServer } = await import('../src/server/index.ts');

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
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: string;
}

/** 发一个 HTTP 请求（不引入 fetch，避免其改写畸形路径/头部） */
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

/** 清空全部条目（测试间互不影响） */
function clearAll(): void {
  for (const e of listDomainKnowledge()) removeDomainKnowledge(e.id, 'test');
}

// ── 一、条目性质判定 ─────────────────────────────────────

test('性质判定：能力不可能的断言被判为事实性先验', () => {
  const a = classifyEntry('Mali 系 GPU 在 MC 26.2+ 仍不支持 Vulkan 启动，只能走 GL4ES 或 Krypton。');
  assert.equal(a.kind, 'fact');
});

test('性质判定：条件→动作句式被判为方法论并给出提醒', () => {
  const a = classifyEntry('如果最大日志文件没有超过 6000 行，可直接阅读全文，不再使用检索工具。');
  assert.equal(a.kind, 'method');
  assert.ok(a.warnings.length > 0, '应给出提醒');
  assert.match(a.warnings.join('\n'), /方法论/);
});

test('性质判定：多行内容会被提醒破坏列表结构', () => {
  const a = classifyEntry('第一行事实断言：某渲染器不支持某扩展。\n第二行也是。');
  assert.match(a.warnings.join('\n'), /换行/);
});

test('性质判定：Markdown 标题与具体路径会被提醒', () => {
  const a = classifyEntry('## 结论\n某 GPU 无法运行该特性，见 /storage/emulated/0/a。');
  const joined = a.warnings.join('\n');
  assert.match(joined, /Markdown 标题/);
  assert.match(joined, /文件路径/);
});

// ── 二、写入边界 ─────────────────────────────────────────

test('创建：空内容被拒', () => {
  const r = createDomainKnowledge({ content: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不能为空/);
});

test('创建：超过 200 字被拒并报出实际字数', () => {
  const r = createDomainKnowledge({ content: '啊'.repeat(201) });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /201 字/);
});

test('创建：多行/多空白被压成单行', () => {
  clearAll();
  const r = createDomainKnowledge({ content: '  某 GPU   不支持\n该特性。  ' });
  assert.equal(r.ok, true);
  assert.equal(r.entry?.content, '某 GPU 不支持 该特性。');
});

test('创建：仅标点不同的重复条目被拒', () => {
  clearAll();
  const first = createDomainKnowledge({ content: 'Mali GPU 不支持 Vulkan 启动。' });
  assert.equal(first.ok, true);

  const second = createDomainKnowledge({ content: 'Mali GPU 不支持 Vulkan 启动' });
  assert.equal(second.ok, false);
  assert.match(second.error ?? '', /重复/);
});

test('创建：方法论条目只提醒不拦截（返回 warnings 且已落库）', () => {
  clearAll();
  const r = createDomainKnowledge({
    content: '如果日志超过 6000 行就优先使用检索工具，不要直接读取全文。',
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry?.kind, 'method');
  assert.ok((r.warnings ?? []).length > 0);
  assert.equal(listDomainKnowledge().length, 1, '应已落库——提醒不等于拦截');
});

test('创建：kindOverride 可显式豁免误判', () => {
  clearAll();
  const r = createDomainKnowledge({
    content: '如果看到 Mojang 认证 401 就直接忽略，那是噪音。',
    kindOverride: 'fact',
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry?.kind, 'fact');
});

// ── 三、更新与删除 ───────────────────────────────────────

test('更新：不存在返回错误', () => {
  const r = updateDomainKnowledge('dk_nope', { content: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不存在/);
});

test('更新：改内容后重新判定性质并留痕', () => {
  clearAll();
  const created = createDomainKnowledge({
    content: '某渲染器 26.3 起改用 SDL3。',
    priority: 10,
    tags: ['renderer'],
  });
  const id = created.entry?.id ?? '';
  assert.notEqual(id, '');

  const updated = updateDomainKnowledge(id, {
    content: '如果遇到渲染问题就优先检查 SDL3。',
    actor: 'tester',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.entry?.kind, 'method');
  assert.deepEqual(updated.entry?.tags, ['renderer'], '未传 tags 时应保持原值');
  assert.equal(updated.entry?.priority, 10);

  const audit = domainKnowledgeAudit(10);
  assert.equal(audit[0]?.action, 'update');
  assert.equal(audit[0]?.actor, 'tester');
});

test('更新：改成与其它条目重复被拒', () => {
  clearAll();
  const a = createDomainKnowledge({ content: '特征一：完全不同的内容甲。' });
  createDomainKnowledge({ content: '特征二：完全不同的内容乙。' });

  const r = updateDomainKnowledge(a.entry?.id ?? '', { content: '特征二：完全不同的内容乙。' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /重复/);
});

test('删除：条目消失但留痕保留', () => {
  clearAll();
  const created = createDomainKnowledge({ content: '即将被删除的一条先验事实断言。' });
  const id = created.entry?.id ?? '';

  const removed = removeDomainKnowledge(id, 'tester');
  assert.equal(removed.ok, true);
  assert.equal(getDomainKnowledge(id), null);

  const audit = domainKnowledgeAudit(10);
  assert.equal(audit[0]?.action, 'delete');
  assert.equal(audit[0]?.beforeContent, '即将被删除的一条先验事实断言。');
  assert.equal(audit[0]?.afterContent, null);
});

// ── 四、注入 ─────────────────────────────────────────────

test('注入：低于优先级门槛的条目不注入，但被显式列在跳过提示里', () => {
  clearAll();
  createDomainKnowledge({ content: '高优先级的先验事实断言一，说明某能力不可用。', priority: 10 });
  createDomainKnowledge({ content: '低优先级的先验事实断言二，说明某行为是噪音。', priority: 1 });

  const inj = renderDomainKnowledgeSection();
  assert.equal(inj.injected.length, 1);
  assert.equal(inj.skipped.length, 1);
  assert.match(inj.text, /权威先验/);
  assert.match(inj.text, /另有 1 条领域知识因超出注入预算未列出/);
  assert.match(inj.text, /expert_knowledge/, '应引导模型去检索');
});

test('注入：超出预算的条目被截断且计入 skipped', () => {
  clearAll();
  for (let i = 0; i < 10; i++) {
    createDomainKnowledge({
      content: `第 ${i} 条先验事实：某设备在特定版本下无法运行某特性，需改用替代方案。`,
      priority: 10,
    });
  }

  const inj = renderDomainKnowledgeSection();
  assert.ok(inj.injected.length > 0, '至少注入一条');
  assert.ok(inj.injected.length < 10, '预算 300 字装不下 10 条');
  assert.ok(inj.skipped.length > 0);
  assert.ok(inj.chars <= 300, `注入字符数 ${inj.chars} 不应超过预算`);
});

test('注入：按优先级降序排列', () => {
  clearAll();
  createDomainKnowledge({ content: '优先级较低的一条先验事实断言甲。', priority: 6 });
  createDomainKnowledge({ content: '优先级较高的一条先验事实断言乙。', priority: 20 });

  const inj = renderDomainKnowledgeSection();
  assert.match(inj.injected[0]?.content ?? '', /乙/, '高优先级应排在前面');
});

test('注入：无启用条目时返回空串而不是空标题（避免提示词出现空小节）', () => {
  clearAll();
  const inj = renderDomainKnowledgeSection();
  assert.equal(inj.text, '');
  assert.equal(inj.chars, 0);
});

// ── 五、检索（expert_knowledge 工具的数据面）──────────────

test('检索：中文二元组能命中（无分词器也能用）', () => {
  clearAll();
  createDomainKnowledge({ content: '移动端渲染器对帧缓冲格式支持不全，需降级处理。', priority: 10 });
  createDomainKnowledge({ content: '某加载器在26.3 起改用新映射格式。', priority: 10 });

  const hits = searchDomainKnowledge('渲染器', 10);
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? '', /渲染器/);
});

test('检索：标签命中加权', () => {
  clearAll();
  createDomainKnowledge({ content: '甲条先验事实断言，内容不含英文标签词。', tags: ['gpu'], priority: 10 });
  createDomainKnowledge({ content: '乙条先验事实断言，内容同样不含标签词。', tags: ['other'], priority: 10 });

  const hits = searchDomainKnowledge('gpu', 10);
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? '', /甲条/);
});

test('检索：空查询返回全部启用条目', () => {
  clearAll();
  createDomainKnowledge({ content: '启用的先验事实断言甲。', priority: 10 });
  createDomainKnowledge({ content: '启用的先验事实断言乙。', priority: 10 });
  createDomainKnowledge({ content: '停用的先验事实断言丙。', enabled: false, priority: 10 });

  const hits = searchDomainKnowledge('', 10);
  assert.equal(hits.length, 2, '停用条目不应被检索到');
});

test('检索：无命中返回空数组（而非报错）', () => {
  clearAll();
  createDomainKnowledge({ content: '关于帧缓冲的先验事实断言。', priority: 10 });
  assert.deepEqual(searchDomainKnowledge('完全不相干的词xyz', 10), []);
});

// ── 六、工具注册 ─────────────────────────────────────────

test('工具：无领域知识条目不注册 expert_knowledge（避免空工具占位诱导调用）', () => {
  clearAll();
  const names = buildTools(createToolContext(null, null)).map((t) => t.name);
  assert.ok(!names.includes('expert_knowledge'));
});

test('工具：有启用条目时注册 expert_knowledge', () => {
  clearAll();
  createDomainKnowledge({ content: '存在一条先验事实断言，用于触发工具注册。', priority: 10 });
  const names = buildTools(createToolContext(null, null)).map((t) => t.name);
  assert.ok(names.includes('expert_knowledge'));
});

// ── 七、统计 ─────────────────────────────────────────────

test('统计：区分事实与方法论条目（便于发现该挪去 prompts/ 的内容）', () => {
  clearAll();
  createDomainKnowledge({ content: '某设备无法运行某特性，这是已知限制。', priority: 10 });
  createDomainKnowledge({ content: '如果日志太长就优先用检索工具，不要通读。', priority: 10 });

  const s = domainKnowledgeStats();
  assert.equal(s.total, 2);
  assert.equal(s.enabled, 2);
  assert.equal(s.methodLike, 1);
  assert.equal(s.injectedCount, 2);
  assert.ok(s.injectedChars > 0);
});

// ── 八、管理接口的 fail-closed 边界 ───────────────────────

test('管理接口：未启用时返回 404（不暴露管理面存在）', async () => {
  delete process.env['ADMIN_ENABLED'];
  delete process.env['ADMIN_TOKEN'];

  const res = await call('/v1/admin/domain-knowledge');
  assert.equal(res.status, 404);
});

test('管理接口：启用但未配置 Token 时仍然返回 404（漏配表现为不可用，而非公网可写）', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  delete process.env['ADMIN_TOKEN'];

  const res = await call('/v1/admin/domain-knowledge');
  assert.equal(res.status, 404);

  const write = await call('/v1/admin/domain-knowledge', 'POST', { content: '试图匿名写入。' });
  assert.equal(write.status, 404);
});

test('管理接口：配置了 Token 但请求未携带 → 401', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  process.env['ADMIN_TOKEN'] = 'secret-token-abc';

  const res = await call('/v1/admin/domain-knowledge');
  assert.equal(res.status, 401);

  const wrong = await call('/v1/admin/domain-knowledge', 'GET', undefined, {
    'x-admin-token': 'secret-token-abd',
  });
  assert.equal(wrong.status, 401);
});

const AUTH = { 'x-admin-token': 'secret-token-abc' };

test('管理接口：Bearer 形态同样可用', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  process.env['ADMIN_TOKEN'] = 'secret-token-abc';

  const res = await call('/v1/admin/domain-knowledge', 'GET', undefined, {
    authorization: 'Bearer secret-token-abc',
  });
  assert.equal(res.status, 200);
});

test('管理接口：analyze 只试算不落库', async () => {
  clearAll();
  const res = await call('/v1/admin/domain-knowledge/analyze', 'POST', {
    content: '如果日志超过 6000 行就优先检索，不要通读。',
  }, AUTH);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { kind: string; warnings: string[]; chars: number };
  assert.equal(body.kind, 'method');
  assert.ok(body.warnings.length > 0);
  assert.equal(listDomainKnowledge().length, 0, '试算不得落库');
});

test('管理接口：创建 → 列表 → 更新 → 删除 全链路', async () => {
  clearAll();

  const created = await call('/v1/admin/domain-knowledge', 'POST', {
    content: '管理接口写入的先验事实断言，说明某能力不可用。',
    priority: 10,
    tags: ['api'],
  }, AUTH);
  assert.equal(created.status, 201);
  const createdBody = JSON.parse(created.body) as { entry: { id: string } };
  const id = createdBody.entry.id;
  assert.notEqual(id, '');

  const list = await call('/v1/admin/domain-knowledge', 'GET', undefined, AUTH);
  assert.equal(list.status, 200);
  const listBody = JSON.parse(list.body) as { entries: unknown[]; stats: { total: number } };
  assert.equal(listBody.entries.length, 1);
  assert.equal(listBody.stats.total, 1);

  const updated = await call(`/v1/admin/domain-knowledge/${id}`, 'PUT', { priority: 20 }, AUTH);
  assert.equal(updated.status, 200);

  const one = await call(`/v1/admin/domain-knowledge/${id}`, 'GET', undefined, AUTH);
  assert.equal(one.status, 200);

  const removed = await call(`/v1/admin/domain-knowledge/${id}`, 'DELETE', undefined, AUTH);
  assert.equal(removed.status, 200);
  assert.equal(listDomainKnowledge().length, 0);
});

test('管理接口：写入门禁覆盖所有子路由（未带 Token 一律 401）', async () => {
  process.env['ADMIN_ENABLED'] = 'true';
  process.env['ADMIN_TOKEN'] = 'secret-token-abc';

  const probes: Array<[string, string]> = [
    ['/v1/admin/domain-knowledge/analyze', 'POST'],
    ['/v1/admin/domain-knowledge/audit', 'GET'],
    ['/v1/admin/domain-knowledge/injection', 'GET'],
    ['/v1/admin/domain-knowledge/search?q=x', 'GET'],
    ['/v1/admin/domain-knowledge/dk_x', 'GET'],
    ['/v1/admin/domain-knowledge/dk_x', 'PUT'],
    ['/v1/admin/domain-knowledge/dk_x', 'DELETE'],
  ];

  for (const [path, method] of probes) {
    const res = await call(path, method, method === 'PUT' ? {} : undefined);
    assert.equal(res.status, 401, `${method} ${path} 应为 401`);
  }
});

test('管理接口：injection 端点回显真实注入原文（含跳过提示）', async () => {
  clearAll();
  createDomainKnowledge({ content: '注入预览用的一条先验事实断言。', priority: 10 });
  createDomainKnowledge({ content: '低优先级的一条先验事实断言。', priority: 1 });

  const res = await call('/v1/admin/domain-knowledge/injection', 'GET', undefined, AUTH);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as {
    text: string;
    injected: unknown[];
    skipped: unknown[];
    chars: number;
  };
  assert.equal(body.injected.length, 1);
  assert.equal(body.skipped.length, 1);
  assert.match(body.text, /已知领域知识/);
  assert.match(body.text, /注入预览用的一条先验事实断言/);
});

test('管理接口：audit 端点返回变更留痕', async () => {
  clearAll();
  createDomainKnowledge({ content: '留痕测试用的先验事实断言一条。' });

  const res = await call('/v1/admin/domain-knowledge/audit?limit=5', 'GET', undefined, AUTH);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { records: Array<{ action: string }> };
  assert.ok(body.records.length > 0);
  assert.equal(body.records[0]?.action, 'create');
});

test('管理接口：不存在的条目返回 404（鉴权通过后）', async () => {
  const res = await call('/v1/admin/domain-knowledge/dk_nope', 'DELETE', undefined, AUTH);
  assert.equal(res.status, 404);
});
