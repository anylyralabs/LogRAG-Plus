/**
 * 前端静态托管测试。
 *
 * 这一层的核心风险只有一个：**路径遍历**。测试因此不复用 `fetch` 做请求——
 * `fetch`/`new URL` 会在客户端就把 `..` 归一化掉，于是「遍历尝试」根本到不了
 * 服务端，测试会给出虚假的安全感。这里用 `http.request` 显式指定 `path`，
 * 让 `..`（明文与百分号编码两种形态）真正打到服务端。
 *
 * 同时把「遍历失败时的行为」写死：**返回 SPA 入口，而不是文件内容**。
 * 只断言「不是 404」不够——一个把 `secret.txt` 内容返回出去的实现在
 * 「状态码不是 200」的断言下也会通过。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// ── 夹具：一个已构建的 web 目录 + 一个「不该被读到」的秘密文件 ──
const root = mkdtempSync(join(tmpdir(), 'lograg-web-'));
const webRoot = join(root, 'dist');
const secret = join(root, 'secret.txt');
const SECRET_BODY = 'TOP-SECRET-DO-NOT-SERVE';

writeFileSync(secret, SECRET_BODY, 'utf8');
mkdirSync(join(webRoot, 'assets'), { recursive: true });
writeFileSync(
  join(webRoot, 'index.html'),
  '<!doctype html><title>SPA-ENTRY</title><div id="app"></div>',
  'utf8',
);
writeFileSync(join(webRoot, 'assets', 'app-abc123.js'), 'console.log("ASSET-OK")', 'utf8');

// 必须在导入 static.ts 之前设置：模块加载时就把目录解析成了常量
process.env['WEB_DIR'] = webRoot;

const { serveWeb, webBuilt, webDir } = await import('../src/server/static.ts');

// ── 起一个真实 http 服务，把请求交给 serveWeb ──

const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (serveWeb(url.pathname, req.method ?? 'GET', res)) return;
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'fallthrough' }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 用显式 path 发请求：`fetch` 会归一化 `..`，测不出遍历 */
function raw(method: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── 构建检测 ────────────────────────────────────────────

test('产物存在时能识别出「前端已构建」', () => {
  assert.equal(webBuilt(), true);
  assert.equal(webDir(), webRoot);
});

// ── 正常路径 ────────────────────────────────────────────

test('资源文件按正确 MIME 与长缓存返回', async () => {
  const res = await raw('GET', '/logshare/assets/app-abc123.js');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.match(String(res.headers['cache-control']), /immutable/);
  assert.equal(res.body, 'console.log("ASSET-OK")');
});

test('HEAD 资源返回头部但无正文', async () => {
  const res = await raw('HEAD', '/logshare/assets/app-abc123.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], '23');
  assert.equal(res.body, '');
});

test('SPA 深链回退到入口页（/logshare/{日志ID} 必须可用）', async () => {
  const res = await raw('GET', '/logshare/kalkLqQ');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /html/);
  assert.match(res.body, /SPA-ENTRY/);
  // 入口页必须每次校验，否则发版后用户会拿到指向旧 chunk 的页面
  assert.match(String(res.headers['cache-control']), /no-cache/);
});

test('管理页深链同样回退到入口页', async () => {
  const res = await raw('GET', '/logshare/admin');
  assert.equal(res.status, 200);
  assert.match(res.body, /SPA-ENTRY/);
});

test('缺少尾斜杠与访问根路径都会被导向 /logshare/', async () => {
  const noSlash = await raw('GET', '/logshare');
  assert.equal(noSlash.status, 301);
  assert.equal(noSlash.headers['location'], '/logshare/');

  const rootPath = await raw('GET', '/');
  assert.equal(rootPath.status, 302);
  assert.equal(rootPath.headers['location'], '/logshare/');
});

// ── 遍历与畸形输入 ──────────────────────────────────────

test('编码后的遍历序列不会读到 dist 之外的文件', async () => {
  // 这里刻意不强求「一定 404」。实测发现两条不同路径：
  //
  //   `/logshare/assets/%2e%2e/secret.txt`
  //     → `new URL()` 在解析时就解开百分号编码并**归一化掉 `..` 段**，
  //       于是它到我们手上已经是 `/logshare/secret.txt`，按 SPA 入口处理（200）。
  //   `/logshare/assets/....//secret.txt`
  //     → 段名里带 `//`，归一化不会拆，落到资源名校验上被拒（404）。
  //
  // 两者都安全，但**只有一条不变量是真正要守的**：永远不返回 dist 之外的内容。
  // 断言写成「要么 404、要么就是入口页，且任何情况下都不含秘密内容」，
  // 比断言某个具体状态码更贴近风险本身。
  const attempts = [
    '/logshare/assets/..%2f..%2fsecret.txt',
    '/logshare/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/logshare/assets/%2e%2e/secret.txt',
    '/logshare/assets/....//secret.txt',
  ];
  for (const path of attempts) {
    const res = await raw('GET', path);
    assert.ok(!res.body.includes(SECRET_BODY), `${path} 泄漏了 dist 之外的文件内容`);
    if (res.status === 200) {
      assert.match(res.body, /SPA-ENTRY/, `${path} 返回了既非 404 也非入口页的内容`);
    } else {
      assert.equal(res.status, 404, `${path} 只允许 404 或 SPA 入口`);
    }
  }
});

test('多段路径不会被当作资源文件解析', async () => {
  const res = await raw('GET', '/logshare/assets/sub/app.js');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('ASSET-OK'));
});

test('明文的 `..` 被 URL 归一化后落到入口页，且绝不泄漏后端文件', async () => {
  // 归一化后是 /logshare/secret.txt：既不是 assets/ 下的文件，就按 SPA 入口处理。
  // 关键断言是「返回的是入口页」，而不是「状态码不是 200」——后者会放过一个
  // 把文件内容当 200 返回的实现。
  const res = await raw('GET', '/logshare/assets/../secret.txt');
  assert.equal(res.status, 200);
  assert.match(res.body, /SPA-ENTRY/);
  assert.ok(!res.body.includes(SECRET_BODY), '不应返回 dist 之外的文件内容');
});

test('不存在的资源返回 404 而不是回退到入口页', async () => {
  // 资源是资源：回退到 HTML 会让浏览器把 HTML 当 JS 执行，
  // 报错信息变成「Unexpected token <」，排查方向完全跑偏。
  const res = await raw('GET', '/logshare/assets/missing-file.js');
  assert.equal(res.status, 404);
  assert.match(res.body, /资源不存在/);
});

test('接口路由不会被静态托管吞掉', async () => {
  const res = await raw('POST', '/v1/chat');
  assert.equal(res.body, JSON.stringify({ ok: false, error: 'fallthrough' }));
});
