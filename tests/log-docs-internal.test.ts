/**
 * 日志面板端点 `GET /v1/log/{id}` —— **内部 API 路径**的测试。
 *
 * ## 为什么要与 `log-docs.test.ts` 分开成两个文件
 *
 * `fetchLog()` 有两条路径，它们**返回的信息量不一样**：
 *
 * | 路径 | 正文 | 附件 | 成因 |
 * |---|---|---|---|
 * | 内部 API（`/v1/internal/log/{id}`） | `data.content` | `data.files[]` | 结构化 JSON |
 * | 公网 raw（`/v1/raw/{id}`） | 合并全文 | **无** | 纯文本，多文件已按 `===== 文件名 =====` 拼进正文 |
 *
 * 也就是说「附件列表」这件事只有内部路径才有。而 `config.ts` 在**模块加载时**
 * 读环境变量，一个测试进程只能固定一种配置——所以两条路径必须分文件。
 *
 * 这不只是测试组织问题，它还是一条**产品事实**：独立运行（只配公网地址）时，
 * 面板拿到的是一份已合并的正文，分节信息来自 `===== 文件名 =====` 标记而不是
 * `docs[]` 数组。前端 `logdoc.ts` 的 `parseLog()` 正是按那个标记分节的，
 * 两条路径因此都能给出「哪一节是崩溃现场」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-logdocs-int-'));

interface InternalFile {
  name: string;
  size: number;
  data?: string;
}

let upstream: {
  content: string;
  files?: InternalFile[];
  created?: number;
  /** 非 200 时走错误分支 */
  status?: number;
} = { content: '' };
const hits: string[] = [];
/** 最近一次请求的请求头（验证内部令牌确实被带上） */
let lastHeaders: http.IncomingHttpHeaders = {};

const fakeInternal = http.createServer((req, res) => {
  hits.push(req.url ?? '');
  lastHeaders = req.headers;
  if (upstream.status !== undefined && upstream.status !== 200) {
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: '日志不存在或已过期' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      success: true,
      data: {
        content: upstream.content,
        files: upstream.files ?? [],
        source: 'fcl/1.3.0',
        created: upstream.created ?? 1,
      },
    }),
  );
});

await new Promise<void>((resolve) => {
  fakeInternal.listen(0, '127.0.0.1', () => resolve());
});
const addr = fakeInternal.address();
if (addr === null || typeof addr === 'string') throw new Error('假内部 API 未监听');

process.env['DATA_DIR'] = testDir;
process.env['LOGSHARE_INTERNAL_URL'] = `http://127.0.0.1:${addr.port}`;
process.env['LOGSHARE_INTERNAL_TOKEN'] = 'test-token';
process.env['LOGSHARE_PUBLIC_API_URL'] = '';

const { createHttpServer } = await import('../src/server/index.ts');

let server: Server;
let origin = '';

test.before(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('无法取得监听端口');
  origin = `http://127.0.0.1:${a.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    fakeInternal.close(() => resolve());
  });
  rmSync(testDir, { recursive: true, force: true });
});

/** 隔离靠「每个用例不同 ID」：进程内缓存按 ID 命中，没有对外清理入口 */
let idSeq = 0;
function nextId(): string {
  idSeq++;
  return `s${String(idSeq).padStart(6, '0')}`;
}

function reset(content: string, files?: InternalFile[]): void {
  upstream = { content, files };
  hits.length = 0;
}

interface DocDto {
  name: string;
  bytes: number;
  lines: number;
  content: string;
  truncated: boolean;
}

async function getDocs(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/v1/log/${encodeURIComponent(id)}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function docsOf(body: Record<string, unknown>): DocDto[] {
  return body['docs'] as DocDto[];
}

test('附件按上游给出的顺序跟在主日志之后', async () => {
  reset('main body', [
    { name: 'crash-report.txt', size: 10, data: 'crash body' },
    { name: 'launcher_log.txt', size: 13, data: 'launcher body' },
  ]);
  const r = await getDocs(nextId());

  assert.equal(r.status, 200);
  assert.deepEqual(
    docsOf(r.body).map((d) => d.name),
    ['main.log', 'crash-report.txt', 'launcher_log.txt'],
  );
});

test('没有正文的附件被跳过，不留空节', async () => {
  reset('main body', [
    { name: 'meta-only.txt', size: 100 }, // 只有元信息，没有 data
    { name: 'empty.log', size: 0, data: '' },
    { name: 'real.log', size: 1, data: 'x' },
  ]);
  const r = await getDocs(nextId());

  assert.deepEqual(
    docsOf(r.body).map((d) => d.name),
    ['main.log', 'real.log'],
    '只有元信息或空字符串的附件不应出现在面板里',
  );
});

test('总量超过 6MB 时，超出预算的文档进 omitted 而不是静默消失', async () => {
  const two = 'y'.repeat(2 * 1024 * 1024);
  // 主日志 + 三个附件各 2MB = 8MB，预算 6MB
  reset(two, [
    { name: 'a.txt', size: two.length, data: two },
    { name: 'b.txt', size: two.length, data: two },
    { name: 'c.txt', size: two.length, data: two },
  ]);
  const r = await getDocs(nextId());

  const docs = docsOf(r.body);
  const omitted = r.body['omitted'] as string[];

  const total = docs.reduce((n, d) => n + d.content.length, 0);
  assert.ok(total <= 6 * 1024 * 1024, `总下发 ${total} 不应超过 6MB 预算`);
  assert.ok(
    omitted.length > 0,
    '超出预算的文档必须列进 omitted——否则用户会以为「崩溃报告明明传了却没显示」',
  );
});

test('单份 2MB 上限与总预算同时生效：被切的那份标记 truncated', async () => {
  const three = 'z'.repeat(3 * 1024 * 1024);
  reset(three);
  const r = await getDocs(nextId());

  const doc = docsOf(r.body)[0];
  assert.equal(doc?.truncated, true);
  assert.equal(doc?.content.length, 2 * 1024 * 1024);
  assert.equal(doc?.bytes, three.length, 'bytes 报原始大小');
});

test('刚创建（60s 内）的日志标记 maybeObfuscating，供界面提示反混淆可能未完成', async () => {
  const now = Math.floor(Date.now() / 1000);
  upstream = { content: 'fresh', files: [], created: now };
  const fresh = await getDocs(nextId());
  assert.equal(fresh.body['maybeObfuscating'], true);

  upstream = { content: 'old', files: [], created: now - 3600 };
  const old = await getDocs(nextId());
  assert.equal(old.body['maybeObfuscating'], false);
});

test('上游 404 时给出「不存在或已过期」，不把内部地址未配置混进来', async () => {
  upstream = { content: '', status: 404 };
  hits.length = 0;
  const r = await getDocs(nextId());

  assert.equal(r.status, 404);
  const msg = String(r.body['error']);
  assert.match(msg, /不存在|已过期/);
});

test('内部路径同时带上令牌头与该走的 URL（少了任何一样线上都会 401）', async () => {
  reset('with token');
  await getDocs(nextId());

  assert.equal(hits.length, 1);
  assert.match(hits[0] ?? '', /^\/v1\/internal\/log\//);
  assert.equal(
    lastHeaders['x-internal-token'],
    'test-token',
    '内部 API 靠这个头鉴权；漏带会让「按 ID 读日志」在生产上静默失效',
  );
});

test('source 与 createdAt 透传给界面', async () => {
  upstream = { content: 'x', files: [], created: 1700000000 };
  const r = await getDocs(nextId());

  assert.equal(r.body['source'], 'fcl/1.3.0');
  assert.equal(r.body['createdAt'], 1700000000);
});
