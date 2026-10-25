/**
 * 全站安全不变量：禁止 `v-html` / `innerHTML`。
 *
 * 模型输出里必然混着用户日志原文（`<`、`&`、用户自己贴的 HTML 都是常态）。
 * 一旦使用 `v-html`，XSS 从「需要绕过过滤器」变成「默认成立」。
 * Markdown 走的是 `marked.lexer` → 自有块 → Vue 模板（默认转义）。
 *
 * 这条用静态扫描守住，因为它的回归**不会报错**：页面看起来正常，
 * 只是某天某份日志里的 `<script>` 被执行了。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(vue|ts)$/.test(entry)) out.push(full)
  }
  return out
}

describe('XSS 结构性防护', () => {
  it('源码中不出现 v-html', () => {
    // 注释里提到「不用 v-html」是允许的；真正要禁的是模板属性 `v-html="…"`
    const offenders = walk(ROOT).filter((file) => /\sv-html\s*=/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([])
  })

  it('源码中不出现 innerHTML / outerHTML 赋值', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (/\.(inner|outer)HTML\s*=/.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('源码中不出现 eval / new Function', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('Markdown 渲染不使用 marked.parse / marked()', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, 'utf8')
      // 只允许 lexer：parse 会直接产出 HTML 字符串，绕开模板转义
      if (/\bmarked\.parse\s*\(|\bmarked\s*\(/.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})
