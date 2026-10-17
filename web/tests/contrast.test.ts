/**
 * 配色对比度守门（WCAG 2.1 相对亮度）。
 *
 * ## 为什么用「算」而不是「看」
 *
 * 上一版的设计令牌里写着「正文对比度 ≥ 4.5:1」，但那是**声明**，没有任何东西
 * 保证它成立——改一个色值就能悄悄破掉，而肉眼在 OLED 手机上分辨不出 4.2 与 4.6。
 * 这套配色是重做的核心，因此把地板的量化交给测试：令牌文件一改，比值就重算。
 *
 * ## 门槛是怎么定的
 *
 * - 正文与一级文字压 7:1（AAA），因为产品的主场景是「夜里、手机上、读长文」；
 * - 二级文字压 4.5:1（AA），它承载元信息与单行说明；
 * - **三级文字（`--text-3`）只压 3:1**：它只用于行号、字节数这类不承载语义的
 *   坐标信息，且刻意要「退到背景里」。若把它抬到 4.5，日志的层次就没了。
 *   这是一条有意的例外，写在这里以免日后被当成漏检。
 * - 严重度色（error/warn/info/ok）用于 3px 竖条与 6px 圆点，**不是文字**，
 *   按 WCAG 的非文本对比度下限压 3:1；其中 error/warn 还会作为 `.pill` 的
 *   前景色，故对面板底压 4.5:1。
 *
 * 另外校验一条结构性不变量：浅色主题必须把**每一个**语义令牌都重映射一遍。
 * 漏掉一个不会报错，只会在浅色下静默沿用暗色的值——那正是最难发现的一类缺陷。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CSS_PATH = new URL('../src/styles/tokens.css', import.meta.url);

function readBlock(css: string, header: string): Record<string, string> {
  const at = css.indexOf(header);
  assert.ok(at >= 0, `令牌文件里找不到区块 ${header}`);
  const start = css.indexOf('{', at) + 1;
  const end = css.indexOf('}', start);
  const out: Record<string, string> = {};
  for (const line of css.slice(start, end).split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i.exec(line);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const css = readFileSync(CSS_PATH, 'utf8');
const dark = readBlock(css, ':root {');
const lightBlock = readBlock(css, ":root[data-theme='light']");
const light: Record<string, string> = { ...dark, ...lightBlock };

/** 递归解析 `var(--x)` 引用；循环引用直接失败，避免「看起来有值但解析不到」 */
function resolve(map: Record<string, string>, value: string, seen: string[] = []): string {
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
  if (m === null) return value.trim();
  const key = m[1] ?? '';
  assert.ok(!seen.includes(key), `令牌循环引用：${[...seen, key].join(' → ')}`);
  return resolve(map, map[key] ?? '', [...seen, key]);
}

function luminance(hex: string): number {
  const raw = hex.replace('#', '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  const channels = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(map: Record<string, string>, fg: string, bg: string): number {
  const a = luminance(resolve(map, map[`--${fg}`] ?? ''));
  const b = luminance(resolve(map, map[`--${bg}`] ?? ''));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 门槛：3 = 非文本/坐标，4.5 = AA，7 = AAA */
const FLOORS: Array<[string, string, number]> = [
  ['text', 'bg', 7],
  ['text', 'surface', 7],
  ['text', 'surface-2', 7],
  ['text-2', 'bg', 4.5],
  ['text-2', 'surface', 4.5],
  ['text-2', 'surface-2', 4.5],
  ['text-3', 'bg', 3],
  ['text-3', 'surface', 3],
  ['accent', 'bg', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'surface-2', 4.5],
  ['on-accent', 'accent', 4.5],
  ['sev-error', 'surface', 4.5],
  ['sev-warn', 'surface', 4.5],
  ['sev-info', 'surface', 3],
  ['sev-ok', 'surface', 3],
  ['sev-error', 'bg', 4.5],
  ['sev-warn', 'bg', 4.5],
  ['sev-info', 'bg', 3],
  ['sev-ok', 'bg', 3],
];

for (const [themeName, map] of [
  ['暗色', dark],
  ['浅色', light],
] as Array<[string, Record<string, string>]>) {
  test(`${themeName}主题：全部语义配色对达到对比度地板`, () => {
    const failures: string[] = [];
    for (const [fg, bg, floor] of FLOORS) {
      const r = ratio(map, fg, bg);
      if (!(r >= floor)) failures.push(`${fg} on ${bg} = ${r.toFixed(2)} < ${floor}`);
    }
    assert.deepEqual(failures, [], `${themeName}主题对比度不足：\n${failures.join('\n')}`);
  });
}

test('浅色主题重映射了全部语义令牌（漏一个就会静默沿用暗色值）', () => {
  const semantic = [
    'bg',
    'bg-deep',
    'surface',
    'surface-2',
    'surface-3',
    'line',
    'line-2',
    'line-3',
    'text',
    'text-2',
    'text-3',
    'accent',
    'accent-strong',
    'accent-quiet',
    'on-accent',
    'sev-error',
    'sev-warn',
    'sev-info',
    'sev-ok',
    'sev-error-wash',
    'sev-warn-wash',
    'sev-info-wash',
    'sev-ok-wash',
    'focus',
    'shadow-pop',
  ];
  const missing = semantic.filter((k) => lightBlock[`--${k}`] === undefined);
  assert.deepEqual(missing, [], `浅色主题缺少重映射：${missing.join('、')}`);
});
