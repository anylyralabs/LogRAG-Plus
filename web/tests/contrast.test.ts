/**
 * 可访问性守门：对比度。
 *
 * 对比度退化是**没有报错**的：调一档灰、换一个 muted，页面看起来「还是那样」，
 * 但正文的可读性已经掉了。这里用设计令牌里的实际色值做纯计算，
 * 覆盖深色与浅色两套主题的正文、辅助文字、状态色与按钮。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ]
}

function linear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
}

function ratio(a: string, b: string): number {
  const la = luminance(parseHex(a))
  const lb = luminance(parseHex(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 从 tokens.css 抽取某套主题的变量值。
 *
 * 不手工抄色值：抄一份就会与实现漂移，而漂移的后果正是「测试过了但页面看不清」。
 */
function readTokens(): string {
  // 用工作目录而不是 import.meta.url：Vitest 转换后的模块 URL 不保证是 file:
  // 协议，`fileURLToPath` 会直接抛「The URL must be of scheme file」。
  return readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
}

function themeBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`找不到主题块：${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)

  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = /^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2]
  }
  return out
}

const css = readTokens()
const light = themeBlock(css, ':root {')
const dark = themeBlock(css, ":root[data-theme='dark']")

interface Case {
  label: string
  fg: string
  bg: string
  min: number
}

function cases(t: Record<string, string>, name: string): Case[] {
  const need = (key: string, bgKey: string, min: number, label: string): Case => {
    const fg = t[key]
    const bg = t[bgKey]
    if (fg === undefined || bg === undefined) throw new Error(`${name} 缺少令牌 ${key} / ${bgKey}`)
    return { label: `${name} · ${label}`, fg, bg, min }
  }

  return [
    need('--ink', '--paper', 4.5, '正文'),
    need('--ink-2', '--paper', 4.5, '次级正文'),
    need('--ink-3', '--paper', 4.5, '说明文字'),
    need('--ink-2', '--paper-raised', 4.5, '浮层正文'),
    need('--ink-3', '--paper-raised', 4.5, '浮层说明'),
    need('--ink-2', '--paper-sunken', 4.5, '凹陷区正文'),
    need('--ink-3', '--paper-sunken', 4.5, '凹陷区说明'),
    need('--accent', '--paper', 4.5, '强调色'),
    need('--danger', '--paper', 4.5, '错误色'),
    need('--warn', '--paper', 4.5, '警告色'),
    need('--ok', '--paper', 4.5, '成功色'),
  ]
}

describe('对比度（WCAG AA）', () => {
  for (const c of [...cases(light, '浅色'), ...cases(dark, '深色')]) {
    it(`${c.label} ≥ ${c.min}:1`, () => {
      const r = ratio(c.fg, c.bg)
      expect(r, `${c.fg} on ${c.bg} 实测 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(c.min)
    })
  }
})

describe('主题完整性', () => {
  it('深色主题覆盖浅色主题的全部语义令牌', () => {
    const missing = Object.keys(light).filter((k) => !(k in dark))
    expect(missing).toEqual([])
  })

  it('两套主题都定义了关键令牌', () => {
    const required = ['--paper', '--ink', '--ink-2', '--ink-3', '--accent', '--rule', '--danger']
    for (const key of required) {
      expect(light[key], `浅色缺少 ${key}`).toBeDefined()
      expect(dark[key], `深色缺少 ${key}`).toBeDefined()
    }
  })
})
