/**
 * 响应压缩（Brotli / gzip）。
 *
 * ## 为什么需要
 *
 * `GET /v1/log/{id}` 返回一份 2604 行的移动端日志约 **265 KB**（实测）。
 * 这类文本的压缩率极高（Brotli 约 8–12 倍），而主要用户是手机上的玩家——
 * 不压缩等于让每次打开日志面板都多花几百 KB 流量与等待。
 *
 * ## 为什么自己写而不引中间件
 *
 * 只有两个写出点（`json()` 与静态资源），引入 `compression` 中间件反而要处理
 * 它和 SSE 的冲突：**SSE 必须不压缩且不缓冲**，否则流式输出会变成一次性吐出。
 * 自己写可以显式排除 `text/event-stream`。
 *
 * ## 阈值
 *
 * 小于 1 KB 的响应压缩后往往更大（HTTP 头 + 压缩帧开销），实测 378 字节的
 * `/health` 压完还是 378 字节。因此设 `MIN_BYTES` 下限。
 */

import { constants as zlibConstants, brotliCompressSync, gzipSync } from 'node:zlib';

/** 小于此值不压缩：压缩帧开销会抵消收益 */
export const MIN_BYTES = 1024;

export type Encoding = 'br' | 'gzip' | null;

/**
 * 按 `Accept-Encoding` 选压缩方式。
 *
 * Brotli 优先：同一份 JSON 上 br 比 gzip 再小约 20%，而解压成本对现代浏览器可忽略。
 * 只看是否**出现**该 token，不解析 q 值——浏览器实际发送的 q 值几乎恒为默认，
 * 为此写一个完整的 q 值解析器不值得。
 */
export function negotiate(header: string | undefined): Encoding {
  if (header === undefined || header === '') return null;
  const lower = header.toLowerCase();
  // `br` 必须是独立 token，避免把 `Accept-Encoding: garbage-br` 当成支持
  if (/(^|[,;\s])br($|[,;\s])/.test(lower)) return 'br';
  if (/(^|[,;\s])gzip($|[,;\s])/.test(lower)) return 'gzip';
  return null;
}

export interface Compressed {
  body: Buffer;
  encoding: 'br' | 'gzip';
}

/**
 * 压缩正文。
 *
 * @returns 不压缩（太小 / 无协商）时返回 `null`，调用方按原样发送
 */
export function compress(
  body: Buffer | string,
  acceptEncoding: string | undefined,
  contentType: string,
): Compressed | null {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;

  // 已压缩格式再压一次只会变大
  if (isPrecompressed(contentType)) return null;
  // SSE 绝不能压缩：会破坏逐帧到达的语义
  if (contentType.startsWith('text/event-stream')) return null;
  if (buf.byteLength < MIN_BYTES) return null;

  const encoding = negotiate(acceptEncoding);
  if (encoding === null) return null;

  try {
    const out =
      encoding === 'br'
        ? brotliCompressSync(buf, {
            params: {
              // 质量 5 是速度/体积的平衡点：再高对 JSON 收益有限，但 CPU 明显上升
              [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            },
          })
        : gzipSync(buf, { level: 6 });

    // 压完反而更大时按原样发送（短文本会出现）
    if (out.byteLength >= buf.byteLength) return null;
    return { body: out, encoding };
  } catch {
    // 压缩失败不影响响应：退回未压缩
    return null;
  }
}

/** 已经是压缩格式的 MIME：再压没有意义 */
function isPrecompressed(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t.startsWith('image/') ||
    t.startsWith('video/') ||
    t.startsWith('audio/') ||
    t.startsWith('font/') ||
    t.includes('zip') ||
    t.includes('brotli') ||
    t.includes('gzip')
  );
}
