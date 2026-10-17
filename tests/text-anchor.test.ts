/**
 * 锚点定位与日志窗口测试。
 *
 * ## 为什么必须有这个文件
 *
 * `anchor.ts` 的注释里写着「27 份真实日志实测：结构性标记优先把错过率从 14/17
 * 降到 0/19」，但**没有任何测试**。也就是说这套结论一旦被后续改动破坏，
 * 没有任何东西会响——而它的失败方式是静默且严重的：定位不到锚点 → 日志窗口
 * 退化成「概况 + 检索指引」→ 模型一行正文都看不到，却仍然输出一份看起来
 * 完整的结论。
 *
 * 2026-10-17 就发生过一次：Forge 的强制依赖不满足（`Missing or unsupported
 * mandatory dependencies`）没有任何堆栈与 crash-report，三个 Tier 全不命中，
 * 23KB 的日志被整份丢掉。本文件把这类「装载器中止」标记固定下来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STRUCTURAL_MARKERS,
  TIER1_PATTERNS,
  TIER2_PATTERNS,
  findErrorAnchor,
} from '../src/text/anchor.ts';
import { buildLogWindow } from '../src/text/window.ts';

test('每个结构性标记都有真实样本行（新增标记必须同时补样本）', () => {
  // 标记表与样本表必须同步扩充：只加正则不加样本，就等于加了一条没人验证的规则。
  const samples: Record<string, string> = {
    'mc-crash-report': '---- Minecraft Crash Report ----',
    'launcher-crash-report': 'ZalithLauncher Crash Report',
    'jvm-fatal': '# A fatal error has been detected by the Java Runtime Environment:',
    'mc-crashed': '[Render thread/FATAL]: Minecraft has crashed!',
    'native-lib-failure': '[LWJGL] Failed to load a library: lwjgl',
    'jvm-create-failure': 'Error: Could not create the Java Virtual Machine.',
    'jre-not-found': 'Error: Could not find Java SE Runtime Environment.',
    'forge-mandatory-deps': "[18:53:49] [main/ERROR]: Missing or unsupported mandatory dependencies:",
    'forge-duplicate-mods': '[main/ERROR]: Duplicate mods found',
    'fabric-incompatible-mods': 'Incompatible mods found!',
    'fabric-resolution-failed': 'net.fabricmc.loader.impl.FormattedException: Mod resolution failed',
    'fabric-loading-failed': 'Mod loading has failed',
    'fabric-entrypoint-failed':
      "Could not execute entrypoint stage 'main' due to errors, provided by 'shape-shifter-curse'",
    'fabric-mod-crashed': 'A mod crashed on startup!',
    'mod-load-failed': 'Mod xaeros_minimap has failed to load correctly',
  };

  for (const m of STRUCTURAL_MARKERS) {
    const sample = samples[m.name];
    assert.ok(sample !== undefined, `结构性标记 ${m.name} 没有配套样本行`);
    assert.ok(m.pattern.test(sample), `样本行未被 ${m.name} 命中：${sample}`);
  }
  assert.equal(
    STRUCTURAL_MARKERS.length,
    Object.keys(samples).length,
    '标记表与样本表数量不一致（有标记没有样本，或有样本没有标记）',
  );
});

test('结构性标记绝对优先于 Tier1/Tier2 噪音', () => {
  const lines = [
    '[12:00:00] [main/WARN]: FML appears to be missing any signature data',
    '[12:00:01] [Lightload] java.io.IOException: Cannot run program',
    '---- Minecraft Crash Report ----',
    'Description: Ticking block entity',
  ];
  const a = findErrorAnchor(lines);
  assert.equal(a.matchedBy, 'mc-crash-report', '结构性标记应压过启动期噪音');
  assert.equal(a.index, 2);
  assert.equal(a.structural, true);
});

test('装载器中止类：无堆栈也能定位（回归 gtNpaS6）', () => {
  const lines = [
    '[18:53:47] [main/WARN]: Mod file .minecraft\\libraries\\fmlcore-1.20.1-47.4.23.jar is missing mods.toml',
    '[18:53:48] [main/INFO]: Found mod file fabric-lifecycle-events-v1.jar of type MOD',
    "[18:53:49] [main/ERROR]: Missing or unsupported mandatory dependencies:",
    "\tMod ID: 'cloth_config', Requested by: 'spatial_gui', Expected range: '[11.0.0,)', Actual version: '[MISSING]'",
    '[18:53:51] [main/INFO]: Loaded 4 CustomSkinLoader bootstrap transformer(s)',
  ];
  const a = findErrorAnchor(lines);
  assert.equal(a.matchedBy, 'forge-mandatory-deps');
  assert.equal(a.index, 2, '锚点应落在装载器明确报错的那一行');
  assert.equal(a.structural, true);
});

test('启动期噪音不得被当成锚点（裸 ERROR 标签已刻意排除）', () => {
  const lines = [
    '[12:00:00] [main/ERROR]: FML appears to be missing any signature data',
    '[12:00:01] [main/ERROR]: [Lightload] Ignoring invalid file',
    '[12:00:02] [main/INFO]: Loading 182 mods:',
  ];
  assert.equal(
    findErrorAnchor(lines).index,
    null,
    '这些是无害告警；把它们当锚点会让窗口停在启动阶段，错过真正的崩溃',
  );
});

test('Caused by 与栈帧：无结构性标记时仍能定位', () => {
  const lines = [
    '[12:00:00] [main/INFO]: Loading mods',
    'java.lang.RuntimeException: boom',
    '    at com.example.Foo.bar(Foo.java:10)',
    'Caused by: java.lang.NoClassDefFoundError: org/spongepowered/asm/mixin/Mixin',
    '    at com.example.Baz.qux(Baz.java:20)',
  ];
  const a = findErrorAnchor(lines);
  assert.equal(a.matchedBy, 'caused-by');
  assert.equal(a.structural, false);
});

test('栈帧锚点向上回溯到声明行（栈帧本身不是错误起点）', () => {
  const lines = [
    'java.lang.IllegalStateException: Something failed',
    '    at com.example.A.a(A.java:1)',
    '    at com.example.B.b(B.java:2)',
  ];
  // 无 Caused by，故走 Tier2；应回溯到第 0 行的声明行
  const a = findErrorAnchor(lines);
  assert.equal(a.index, 0, '应回到异常声明行，而不是停在栈帧上');
});

test('完全无错误特征时返回 null（不猜）', () => {
  assert.equal(findErrorAnchor(['[12:00:00] [main/INFO]: Loading 1 mods']).index, null);
  assert.equal(findErrorAnchor([]).index, null);
});

test('Tier1/Tier2 模式表非空且都有样本（防止被清空）', () => {
  assert.ok(TIER1_PATTERNS.length > 0);
  assert.ok(TIER2_PATTERNS.length > 0);
  const t1: Record<string, string> = {
    'caused-by': 'Caused by: java.lang.NullPointerException',
    traceback: 'Traceback (most recent call last):',
    'exception-in-thread': 'Exception in thread "main" java.lang.RuntimeException',
    'fatal-level': '[Render thread/FATAL]: stopping',
    'affected-level': '-- Affected level --',
  };
  for (const p of TIER1_PATTERNS) {
    assert.ok(t1[p.name] !== undefined && p.pattern.test(t1[p.name]!), `Tier1 ${p.name} 样本不匹配`);
  }
});

// ── 日志窗口 ──────────────────────────────────────────────

test('窗口：短日志原样返回', () => {
  const content = 'line1\nline2\nline3';
  const w = buildLogWindow(content);
  assert.equal(w.hasWindow, true);
  assert.equal(w.body, content);
  assert.equal(w.anchorLine, null);
  assert.equal(w.totalLines, 3);
});

test('窗口：长日志以锚点为中心，且含锚点行', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `[12:00:00] [main/INFO]: filler ${i}`.padEnd(120, '.'));
  const lines = [...filler, '---- Minecraft Crash Report ----', 'Description: Ticking block entity', ...filler];
  const w = buildLogWindow(lines.join('\n'));

  assert.equal(w.hasWindow, true);
  assert.equal(w.matchedBy, 'mc-crash-report');
  assert.equal(w.anchorLine, 3001);
  assert.ok(w.body.includes('Minecraft Crash Report'), '窗口必须包含锚点行');
  assert.ok(
    Buffer.byteLength(w.body, 'utf8') <= 12000 + 4096,
    `窗口不应显著超过 maxBytes，实际 ${Buffer.byteLength(w.body, 'utf8')}`,
  );
  assert.ok(w.body.startsWith('[前文已省略') || w.body.includes('[前文已省略'), '应标出省略范围');
});

test('窗口：无锚点的长日志退化为概况（明示信息不足，绝不伪造正文）', () => {
  const content = Array.from({ length: 3000 }, (_, i) => `[12:00:00] [main/INFO]: nothing ${i}`.padEnd(120, '.')).join('\n');
  const w = buildLogWindow(content);

  assert.equal(w.hasWindow, false);
  assert.equal(w.anchorLine, null);
  assert.ok(w.body.includes('概况'), '应返回概况');
  assert.ok(
    w.body.includes('grep') || w.body.includes('检索'),
    '应给出检索指引，让模型知道可以自己去找',
  );
  // 关键：绝不能把开服前缀当正文发出去（那是误导）
  assert.ok(!w.body.includes('nothing 0'), '不得截取前缀日志伪装成"相关内容"');
});

test('窗口：多窗口模式附启动环境信息（仅当锚点在 200 行之后）', () => {
  const head = [
    'Launcher version: FCL 1.3.4.0',
    'Java: 21.0.1',
    'Device: Oppo PEQM00',
    '[12:00:00] [main/INFO]: noise',
  ];
  const filler = Array.from({ length: 500 }, (_, i) => `[12:00:00] [main/INFO]: n${i}`.padEnd(120, '.'));
  const lines = [...head, ...filler, '---- Minecraft Crash Report ----', ...filler];
  const w = buildLogWindow(lines.join('\n'));

  assert.ok(w.body.includes('[启动环境信息]'), '锚点靠后时应附环境信息');
  assert.ok(w.body.includes('Device: Oppo PEQM00'));
});

test('窗口：maxBytes 可收紧（调用方需能限制提示词体积）', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `[12:00:00] [main/INFO]: x${i}`.padEnd(120, '.'));
  const lines = [...filler, '---- Minecraft Crash Report ----', ...filler];
  const w = buildLogWindow(lines.join('\n'), { maxBytes: 4000, multiWindow: false });
  assert.ok(
    Buffer.byteLength(w.body, 'utf8') <= 4200,
    `收紧后应生效，实际 ${Buffer.byteLength(w.body, 'utf8')}`,
  );
});
