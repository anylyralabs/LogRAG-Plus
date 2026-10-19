/**
 * 视觉对齐守门：对比度。
 *
 * 用的是 Nuxt UI 默认色板（green / slate / red / yellow）的语义取值，
 * 检查**实际会用到的前景/背景组合**。纯计算、无依赖，可在 CI 跑。
 *
 * 为什么值得单独测：对比度退化是**没有报错**的。调整一档灰、换一个 muted，
 * 页面看起来「还是那样」，但正文的可读性已经掉了——这类问题只能靠数值守住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ]
}

function lin(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function lum(rgb: [number, number, number]): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

/** WCAG 相对对比度 */
function ratio(a: string, b: string): number {
  const la = lum(parse(a))
  const lb = lum(parse(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Nuxt UI 默认 slate 色阶（v4 的 neutral） */
const slate = {
  50: '#f8fafc',
  100: '#f1f5f9',
  200: '#e2e8f0',
  300: '#cbd5e1',
  400: '#94a3b8',
  500: '#64748b',
  600: '#475569',
  700: '#334155',
  800: '#1e293b',
  900: '#0f172a',
} as const

const DARK = {
  name: '深色',
  bg: slate[900],
  bgElevated: slate[800],
  text: slate[200],
  textTonned: slate[300],
  textMuted: slate[400],
  highlighted: '#ffffff',
}

const LIGHT = {
  name: '浅色',
  bg: '#ffffff',
  bgElevated: slate[100],
  text: slate[700],
  textTonned: slate[600],
  textMuted: slate[500],
  highlighted: slate[900],
}

/** 正文类按 AA 4.5；仅作标识的行号/编号按 AA-large 3.0 */
const CASES: Array<{ label: string; fg: keyof typeof DARK; bg: keyof typeof DARK; min: number }> = [
  { label: '正文', fg: 'text', bg: 'bg', min: 4.5 },
  { label: '次级正文', fg: 'textTonned', bg: 'bg', min: 4.5 },
  { label: '说明文字', fg: 'textMuted', bg: 'bg', min: 4.5 },
  { label: '栏目标记', fg: 'textMuted', bg: 'bg', min: 4.5 },
  { label: '标题', fg: 'highlighted', bg: 'bg', min: 4.5 },
  { label: '浮层上的正文', fg: 'text', bg: 'bgElevated', min: 4.5 },
  // 浮层（elevated）上的说明文字用 toned：浅色 muted 在 elevated 上只有 4.36:1
  { label: '浮层上的说明', fg: 'textTonned', bg: 'bgElevated', min: 4.5 },
]

for (const theme of [DARK, LIGHT]) {
  for (const c of CASES) {
    test(`${theme.name}：${c.label}对比度 ≥ ${c.min}`, () => {
      const r = ratio(theme[c.fg], theme[c.bg])
      assert.ok(
        r >= c.min,
        `${theme.name} ${c.label} 只有 ${r.toFixed(2)}:1（${theme[c.fg]} on ${theme[c.bg]}），需 ≥ ${c.min}`,
      )
    })
  }
}

test('行号使用 toned（muted 在浅色浮层上只有 4.36:1，仍差一点）', () => {
  // 这条守的是一个具体决定：.line-no 用 --ui-text-toned。
  // dimmed = 2.34:1、muted = 4.76:1（bg）/ 4.36:1（elevated），toned 才两种背景都稳过。
  for (const theme of [DARK, LIGHT]) {
    assert.ok(ratio(theme.textTonned, theme.bg) >= 4.5)
    assert.ok(ratio(theme.textTonned, theme.bgElevated) >= 4.5)
  }
})

test('浅色主按钮白字对比度 ≥ 4.5（默认 green-600 只有 3.30:1）', () => {
  // 组件层把浅色主按钮压到 green-700；深色主题的 green 本来就够
  assert.ok(ratio('#ffffff', '#15803d') >= 4.5, 'green-700 上的白字必须达标')
})

test('深色主题的主按钮白字达标', () => {
  assert.ok(ratio('#ffffff', '#15803d') >= 4.5)
})
