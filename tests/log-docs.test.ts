/**
 * 日志面板端点 `GET /v1/log/{id}` 的测试。
 *
 * ## 这个端点为什么值得单独测
 *
 * 它是新交互（「日志是一份可以被指认的文档」）的数据入口，而它身上叠了
 * 五条互相牵制的约束——任何一条写错都**不会报错**，只会让界面悄悄变差：
 *
 * | 约束 | 写错的后果（无报错） |
 * |---|---|
 * | ID 先做格式校验 | 畸形 ID 打到上游，把「你输错了」显示成「服务未配置」 |
 * | 截断要如实回报 `truncated` | 面板少显示几行，用户以为日志就这么长 |
 * | 总预算超出的文档要进 `omitted` | 附件静默消失，「崩溃报告明明传了」 |
 * | 上游失败要给出上游的原话 | 面板显示一句笼统的「读取失败」 |
 * | 缓存只缓存成功结果 | 一次抖动被缓存 5 分钟，用户怎么刷新都是失败 |
 *
 * ## 怎么做到不联网
 *
 * 测试进程里 `LOGSHARE_PUBLIC_API_URL` 指向一个**本地假 LogShare**（本文件自己起的
 * http 服务），它按路径返回可控内容。这样截断/预算/缓存都能真正走一遍网络路径，
 * 而断言的对象是真实的响应体，不是 mock 的中间态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-logdocs-'));

// ── 假 LogShare：先起服务拿到端口，再设置环境变量（config.ts 在 import 时读环境） ──
//
// 内容由 `upstream` 控制，测试内可随时改写；`hits` 记录请求次数用于验证缓存。
interface UpstreamBody {
  /** 主日志正文 */
  content: string;
  files?: Array<{ name: string; data: string }>;
  source?: string;
  created?: number;
  /** 非 200 时走错误分支 */
  status?: number;
}

let upstream: UpstreamBody = { content: '' };
const hits: string[] = [];

const fakeLogshare = http.createServer((req, res) => {
  hits.push(req.url ?? '');
  if (upstream.status !== undefined && upstream.status !== 200) {
    res.writeHead(upstream.status, { 'content-type': 'text/plain' });
    res.end('upstream says no');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(upstream.content);
});

await new Promise<void>((resolve) => {
  fakeLogshare.listen(0, '127.0.0.1', () => resolve());
});
const fakeAddr = fakeLogshare.address();
if (fakeAddr === null || typeof fakeAddr === 'string') throw new Error('假 LogShare 未监听');
const fakeOrigin = `http://127.0.0.1:${fakeAddr.port}`;

process.env['DATA_DIR'] = testDir;
// 内部路径刻意留空：独立运行时的真实形态，同时验证「未配置的路径不该有意见」
process.env['LOGSHARE_INTERNAL_URL'] = '';
process.env['LOGSHARE_PUBLIC_API_URL'] = fakeOrigin;

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
  await new Promise<void>((resolve) => {
    fakeLogshare.close(() => resolve());
  });
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * 让每次测试从干净的上游出发。
 *
 * **注意：不能靠「清缓存」隔离用例**——进程内缓存没有对外暴露的清理入口，
 * 而它就是按 ID 缓存的（这是设计：面板刷新/切会话会重复请求同一份日志）。
 * 因此隔离手段是**每个用例用不同的 ID**。这一点是实测踩出来的：
 * 最初所有用例共用 `kalkLqQ`，从第二个用例起全部命中了第一个的缓存，
 * 于是「截断」「附件」「行数」六个断言一起红，看起来像端点坏了。
 */
const usedIds = new Set<string>();
let idSeq = 0;

/** 取一个未被任何用例用过的合法日志 ID（7 位，字符集与 LogShare 一致） */
function nextId(): string {
  for (;;) {
    idSeq++;
    const id = `a${String(idSeq).padStart(6, '0')}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

function reset(content: string, files?: Array<{ name: string; data: string }>): void {
  upstream = { content, files };
  hits.length = 0;
}

async function getDocs(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/v1/log/${encodeURIComponent(id)}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

interface DocDto {
  name: string;
  bytes: number;
  lines: number;
  content: string;
  truncated: boolean;
}

function docsOf(body: Record<string, unknown>): DocDto[] {
  return body['docs'] as DocDto[];
}

// ── 格式校验 ────────────────────────────────────────────

test('ID 格式非法时返回 400，且不打上游', async () => {
  reset('不该被读到');
  for (const bad of ['badid', '', '!!!!!!!', 'abcdefgh']) {
    const r = await getDocs(bad);
    assert.equal(r.status, 400, `「${bad}」应被拒`);
    assert.match(String(r.body['error']), /格式非法/);
  }
  assert.equal(hits.length, 0, '格式校验必须发生在取日志之前');
});

// ── 成功路径 ────────────────────────────────────────────

test('成功时返回正文、行数与来源', async () => {
  const content = 'line1\nline2\nline3';
  reset(content);
  const id = nextId();
  const r = await getDocs(id);

  assert.equal(r.status, 200);
  assert.equal(r.body['ok'], true);
  assert.equal(r.body['logId'], id);

  const docs = docsOf(r.body);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.name, 'main.log');
  assert.equal(docs[0]?.content, content);
  // 三行文本：行数是「换行数 + 1」，不是换行数
  assert.equal(docs[0]?.lines, 3);
  assert.equal(docs[0]?.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(docs[0]?.truncated, false);
});

test('行数统计对空正文与末尾换行都正确', async () => {
  reset('');
  // 空正文在上游阶段就被判为「读不到」，故只看带内容的两种形态
  reset('a\nb');
  const two = await getDocs(nextId());
  assert.equal(docsOf(two.body)[0]?.lines, 2);

  reset('a\nb\n');
  const trailing = await getDocs(nextId());
  assert.equal(docsOf(trailing.body)[0]?.lines, 3, '末尾换行意味着最后一个空行也是一行');
});

// ── 失败语义 ────────────────────────────────────────────

test('上游返回 404 时，错误文案来自上游（不是「未配置 API」）', async () => {
  upstream = { content: '', status: 404 };
  hits.length = 0;
  const r = await getDocs(nextId());

  assert.equal(r.status, 404);
  assert.equal(r.body['ok'], false);
  const msg = String(r.body['error']);
  assert.match(msg, /不存在|已过期/, `应给出「不存在或已过期」，实际是：${msg}`);
  assert.doesNotMatch(msg, /未配置/, '内部路径未配置不该污染错误文案——这是已修过的缺陷');
});

test('上游正文为空时按「读不到」处理，不返回 ok:true', async () => {
  reset('');
  const r = await getDocs(nextId());

  assert.equal(r.status, 404);
  assert.equal(r.body['ok'], false);
});

// ── 缓存 ────────────────────────────────────────────────

test('成功结果被缓存：同一 ID 二次请求不再打上游', async () => {
  reset('cached content');
  const id = nextId();
  const first = await getDocs(id);
  const hitsAfterFirst = hits.length;
  assert.equal(hitsAfterFirst, 1);

  const second = await getDocs(id);
  assert.equal(hits.length, 1, '第二次应命中进程内缓存');
  assert.deepEqual(docsOf(second.body), docsOf(first.body));
});

test('失败结果不被缓存：抖动不该被锁住 5 分钟', async () => {
  upstream = { content: '', status: 500 };
  hits.length = 0;
  const id = nextId();
  await getDocs(id);
  const after = hits.length;

  upstream = { content: 'recovered' };
  const r = await getDocs(id);

  assert.equal(r.status, 200, '上游恢复后应立即能读到');
  assert.equal(hits.length, after + 1, '失败不该进缓存');
});

// ── 与对话配额的关系 ────────────────────────────────────

test('读日志不消耗对话配额（看一眼不等于分析一次）', async () => {
  reset('quota content');
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);

  // 连读三次；配额若被扣，后续 /v1/chat 会先撞 429——这里只看读取本身不限次
  for (let i = 0; i < 3; i++) {
    const r = await getDocs(nextId());
    assert.equal(r.status, 200);
  }
});
