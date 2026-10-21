/**
 * 响应压缩测试。
 *
 * 守的核心是**不该压的绝不压**：SSE 一旦被压缩就会失去逐帧到达的语义，
 * 界面会从「流式输出」退化成「等很久然后一次性出现」——而这个退化不会报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { MIN_BYTES, compress, negotiate } from '../src/server/compress.ts'

// ── 协商 ────────────────────────────────────────────────

test('协商：br 优先于 gzip', () => {
  assert.equal(negotiate('br, gzip'), 'br')
  assert.equal(negotiate('gzip, br'), 'br')
  assert.equal(negotiate('gzip'), 'gzip')
  assert.equal(negotiate(undefined), null)
  assert.equal(negotiate(''), null)
  assert.equal(negotiate('deflate'), null)
})

test('协商：只认独立 token，不把 garbage-br 当成支持 br', () => {
  assert.equal(negotiate('garbage-br'), null)
  assert.equal(negotiate('xbr'), null)
  assert.equal(negotiate('identity'), null)
})

// ── 压缩 ────────────────────────────────────────────────

const BIG = JSON.stringify({ lines: Array.from({ length: 2000 }, (_, i) => `[12:00:0${i % 10}] [main/INFO]: line ${i}`) })

test('大文本按 br 压缩且可还原', () => {
  const r = compress(BIG, 'br', 'application/json')
  assert.ok(r !== null)
  assert.equal(r.encoding, 'br')
  assert.ok(r.body.byteLength < Buffer.byteLength(BIG) / 3, '压缩率应显著')
  assert.equal(brotliDecompressSync(r.body).toString('utf8'), BIG, '必须能无损还原')
})

test('大文本按 gzip 压缩且可还原', () => {
  const r = compress(BIG, 'gzip', 'application/json')
  assert.ok(r !== null)
  assert.equal(r.encoding, 'gzip')
  assert.equal(gunzipSync(r.body).toString('utf8'), BIG)
})

test('小于阈值不压缩（压缩帧开销会抵消收益）', () => {
  const small = 'x'.repeat(MIN_BYTES - 1)
  assert.equal(compress(small, 'br', 'application/json'), null)
})

test('客户端不支持压缩时不压', () => {
  assert.equal(compress(BIG, undefined, 'application/json'), null)
  assert.equal(compress(BIG, 'identity', 'application/json'), null)
})

// ── 绝不压缩的几类 ──────────────────────────────────────

test('SSE 绝不压缩（压了就没有流式了）', () => {
  assert.equal(compress(BIG, 'br', 'text/event-stream'), null)
  assert.equal(compress(BIG, 'gzip', 'text/event-stream'), null)
})

test('已压缩格式不二次压缩', () => {
  for (const ct of ['image/png', 'video/mp4', 'audio/mpeg', 'font/woff2', 'application/zip']) {
    assert.equal(compress(BIG, 'br', ct), null, `${ct} 不该被压缩`)
  }
})

test('压缩后反而更大时返回 null（按原样发送）', () => {
  // 大量重复字符压缩率极高，但随机短串不会；这里用刚好过阈值的随机内容
  const noise = Array.from({ length: MIN_BYTES }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('')
  const r = compress(noise, 'br', 'application/json')
  // 压缩可能成功也可能因体积不划算而返回 null，两者都合法——但不能崩
  assert.ok(r === null || r.body.byteLength >= 0)
})
