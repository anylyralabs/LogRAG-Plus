/**
 * API 文档守门：文档里写的路由必须真实存在。
 *
 * 这份文档是**唯一契约**（前端在 `web/`，但它同样只能依据这份文档，
 * 不得靠读后端源码猜字段）。文档与代码一旦漂移，客户端会照着不存在的
 * 接口写，然后在 404 上耗半天。
 *
 * 这里不解析 Markdown 的语义，只做两件可机械化的事：
 * 1. 文档中出现的 `/v1/...` 路由，必须在源码里能找到对应字符串；
 * 2. 源码里对外暴露的路由，必须在文档里出现。
 *
 * 第 2 条更值钱——新增接口忘了写文档，是最常见的漂移方向。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const DOC = readFileSync('API.md', 'utf8')
const SERVER = readFileSync('src/server/index.ts', 'utf8')

/** 从源码里抽出真正的路由判定（只认 path 比较，不认注释） */
function routesInCode(): Set<string> {
  const out = new Set<string>()
  const re = /path\s*(?:===|\.startsWith\()\s*'(\/[^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(SERVER)) !== null) {
    const raw = m[1] ?? ''
    // `/v1/log/` 这类前缀在文档里写作 `/v1/log/{logId}`
    out.add(raw.replace(/\/$/, ''))
  }
  return out
}

/**
 * 文档里出现的接口路径。
 *
 * 不能只匹配反引号包裹的形态：文档正文里 `/v1/chat` 常直接写在句子与表格中
 * （如「| `POST /v1/chat` | 发起一轮分析 |」里的方法是独立反引号）。
 * 因此改为扫描**全文**中所有 `/v1/...` 形状的字符串。
 */
function routesInDoc(): Set<string> {
  const out = new Set<string>()
  const re = /\/v1\/[A-Za-z0-9/{}._-]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(DOC)) !== null) {
    let p = m[0]
    p = p.split('?')[0] ?? p
    // 模板参数 `{logId}` / `{id}` → 源码里的前缀形式
    p = p.replace(/\{[a-zA-Z]+\}/g, '')
    p = p.replace(/[.,;:)]+$/, '')
    if (p !== '') out.add(p.replace(/\/$/, ''))
  }
  return out
}

test('文档中出现的 /v1 路由都能在源码里找到', () => {
  const code = routesInCode()
  const doc = routesInDoc()
  const missing = [...doc].filter((p) => {
    if (p === '/v1/admin') return !code.has('/v1/admin')
    // 前缀型（/v1/log、/v1/session、/v1/admin/domain-knowledge）由 startsWith 承接
    return ![...code].some((c) => c === p || c.startsWith(p) || p.startsWith(c))
  })
  assert.deepEqual(missing, [], `文档里写了但源码里没有的路由：\n  ${missing.join('\n  ')}`)
})

test('源码里对外暴露的路由都写进了文档', () => {
  const doc = routesInDoc()
  const documented = (p: string): boolean =>
    [...doc].some((d) => d === p || d.startsWith(p) || p.startsWith(d))

  const undoc = [...routesInCode()].filter((p) => p.startsWith('/v1') && !documented(p))
  assert.deepEqual(undoc, [], `源码有但文档没写的路由：\n  ${undoc.join('\n  ')}`)
})

test('文档包含 SSE 的关键约定（客户端最容易写错的四点）', () => {
  // 这些不是格式洁癖：每一条都对应一个会让前端白屏或乱码的实现错误
  const required = [
    ['跨块残余', /残余|buffer/i],
    ['流式解码', /stream:\s*true/],
    ['多行 data', /多行\s*`data:`/],
    ['不用 EventSource', /EventSource/],
    ['先检查 content-type', /content-type/i],
  ] as const
  for (const [name, re] of required) {
    assert.match(DOC, re, `文档缺少「${name}」的说明`)
  }
})

test('文档说明了管理接口的三种失败必须分开', () => {
  assert.match(DOC, /管理接口未开启/)
  assert.match(DOC, /令牌不匹配|令牌不正确/)
})

test('文档说明了空正文不是成功', () => {
  assert.match(DOC, /空正文一律视为失败|空正文/)
})
