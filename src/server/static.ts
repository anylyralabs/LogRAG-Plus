/**
 * 前端静态资源托管（`web/dist`）。
 *
 * ## 为什么由 Node 服务托管，而不是交给 Nginx
 *
 * 生产入口是 `https://agent.logshare.cn/logshare/{日志ID}`。若把静态资源放在
 * Nginx 上，就必须在 Nginx 侧再写一份「`/logshare/*` 回退到 index.html」的规则，
 * 并保证它与 Node 的路由同时正确——两份配置、两个失效点。这里托管则部署形态是
 * 「一个进程 + 一层反代」，`/v1` 与页面同源，也就不需要 CORS。
 *
 * ## 路径遍历的处置方式（重点）
 *
 * 常见做法是「拼接路径后校验是否以 root 开头」，但那是**先在字符串层面
 * 做判断、再交给文件系统解释**，两者对同一路径的理解并不总是相同
 * （`..`、`%2e%2e`、符号链接、大小写、尾随点……），历史上大量遍历漏洞都出在这里。
 *
 * 这里换一个**结构性**的做法：**用户输入不参与文件路径拼接之外的任何解释**。
 *
 * - 只有一个目录会真正返回文件：`assets/`，且其文件名必须匹配
 *   `^[A-Za-z0-9._-]+$`（单段、无分隔符、无 `..`）。不匹配即 404。
 * - 其余任何 `/logshare/**` 一律返回 `index.html`——这是 SPA 深链（如
 *   `/logshare/kalkLqQ`）需要的回退行为，顺带让「构造一个奇怪路径去读文件」
 *   在语义上不可能发生：它只会拿到 index.html。
 *
 * 因此这里不存在「能读到 dist 之外的文件」的输入，而不是「试图拦住它」。
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { web as webCfg } from '../config.ts';

/**
 * 前端产物目录。
 *
 * 默认值是**工作目录下的 `web/.output/public`**（Nuxt 静态产物）。
 * 部署时可用 `WEB_DIR` 覆盖。`resolve` 只是为了把相对路径拍成绝对路径——
 * 它本身不做任何「是否在允许目录内」的判断，那件事由路由结构负责（见文件头）。
 *
 * 刻意不用「模块文件位置旁的产物目录」：源码运行时刚好正确，
 * 一旦编译到 `dist/src/` 就变成 `dist/web/dist`——路径错、文件不存在，
 * 表现是「服务正常、页面 404」，排查时极易被归因为反向代理配错。
 * 这与 `.env`、`DATA_DIR`、`PROMPTS_DIR` 的基准（工作目录）保持一致。
 */
const DEFAULT_WEB_DIR = resolve(process.cwd(), 'web', '.output', 'public');
const WEB_DIR = resolve(webCfg.dir !== '' ? webCfg.dir : DEFAULT_WEB_DIR);

/** 前端挂载的子路径（与 vite 的 `base` 一致） */
const BASE = '/logshare';

/** 单段资源文件名：**不允许**分隔符、`..`、编码字符 */
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+$/;


const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** 前端是否已构建（未构建时静默不接管路由，交由 404 处理） */
export function webBuilt(): boolean {
  return existsSync(join(WEB_DIR, 'index.html'));
}

/** 产物目录（供日志/诊断输出） */
export function webDir(): string {
  return WEB_DIR;
}

function sendIndex(res: ServerResponse, method: string): boolean {
  const index = join(WEB_DIR, 'index.html');
  if (!existsSync(index)) return false;

  let body: Buffer;
  try {
    body = readFileSync(index);
  } catch {
    return false;
  }

  res.writeHead(200, {
    'content-type': MIME['.html'] as string,
    'content-length': String(body.byteLength),
    // 入口页面必须每次校验：文件名带 hash 的资源可以长缓存，index.html 不行，
    // 否则发版后用户会一直拿到指向旧 chunk 的页面（表现为白屏 + 404 请求）。
    'cache-control': 'no-cache',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

/**
 * 处理静态资源请求。
 *
 * @returns 是否已接管该请求（false 表示交给后续路由）
 */
export function serveWeb(path: string, method: string, res: ServerResponse): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!webBuilt()) return false;

  // `/logshare`（无尾斜杠）→ 规范化到带斜杠，避免相对路径解析出问题
  if (path === BASE) {
    res.writeHead(301, { location: `${BASE}/` });
    res.end();
    return true;
  }

  // 根路径：给人一个能直接点的入口（Human 访问域名时不该看到 404）
  if (path === '/' || path === '/index.html') {
    res.writeHead(302, { location: `${BASE}/` });
    res.end();
    return true;
  }

  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;

  const rest = path.slice(BASE.length + 1); // 去掉 `/logshare/`

  // 资源文件：唯一会真正读盘的路径
  // 资源目录：Nuxt 产出 `_nuxt/`，Vite 产出 `assets/`，两者都接受
  const assetDir = ['_nuxt/', 'assets/'].find((d) => rest.startsWith(d));
  if (assetDir !== undefined) {
    const name = rest.slice(assetDir.length);
    if (!ASSET_NAME_RE.test(name)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '资源不存在' }));
      return true;
    }

    const file = join(WEB_DIR, assetDir.replace(/\/$/, ''), name);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '资源不存在' }));
      return true;
    }

    const headers: Record<string, string> = {
      'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(statSync(file).size),
      // 文件名带内容 hash，可以放心长缓存
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
    return true;
  }

  // 其余一切（含 `/logshare/`、`/logshare/{日志ID}`、`/logshare/admin`）→ SPA 入口
  return sendIndex(res, method);
}
