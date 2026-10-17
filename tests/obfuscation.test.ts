/**
 * 反混淆检测与就绪判定测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkReadiness, detectObfuscation } from '../src/text/obfuscation.ts';

/** 构造含恰好 N 个 intermediary 命中的日志（每行 1 个） */
function withIntermediary(n: number): string {
  const lines: string[] = ['[12:00:00] [main/INFO]: Loading Minecraft'];
  for (let i = 0; i < n; i++) {
    lines.push(`  at net.minecraft.class_${1000 + i}.foo(x.java:42)`);
  }
  return lines.join('\n');
}

test('正常（已反混淆）日志不误判', () => {
  const content = [
    '[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
    '[12:00:01] [main/ERROR]: java.lang.NoSuchMethodError: net.minecraft.client.Minecraft.resize(int, int)',
    '  at com.example.coolmod.CoolMod.onInit(CoolMod.java:42)',
  ].join('\n');

  const r = detectObfuscation(content);
  assert.equal(r.obfuscated, false);
  assert.equal(r.matches, 0);
});

test('少量 intermediary 命中不误判（阈值容忍）', () => {
  const r = detectObfuscation(withIntermediary(5));
  assert.equal(r.obfuscated, false, '5 次命中不应触发');
  assert.equal(r.matches, 5);
});

test('大量 intermediary 命中判定为未反混淆', () => {
  const r = detectObfuscation(withIntermediary(50));
  assert.equal(r.obfuscated, true);
  assert.ok(r.matches >= 50);
  assert.ok(r.samples.length > 0);
  assert.match(r.samples[0]!, /^(class|method|field)_\d+$/);
});

test('阈值边界：20 不触发，21 触发', () => {
  assert.equal(detectObfuscation(withIntermediary(20)).obfuscated, false);
  assert.equal(detectObfuscation(withIntermediary(21)).obfuscated, true);
});

test('就绪判定：未检出混淆直接通过', () => {
  const v = checkReadiness({
    content: 'normal log without intermediary names',
    createdAt: 1000,
    now: 2000,
  });
  assert.equal(v.ready, true);
  assert.equal(v.action, 'proceed');
});

test('就绪判定：检出混淆且在宽限期内 → 重试', () => {
  const v = checkReadiness({
    content: withIntermediary(50),
    createdAt: 1000,
    now: 1030, // 30s < 60s 宽限
    graceSeconds: 60,
  });
  assert.equal(v.ready, false);
  assert.equal(v.action, 'retry');
  assert.ok(v.message.includes('预处理'));
});

test('就绪判定：检出混淆且超出宽限期 → 警告但继续', () => {
  const v = checkReadiness({
    content: withIntermediary(50),
    createdAt: 1000,
    now: 1200, // 200s > 60s 宽限
    graceSeconds: 60,
  });
  assert.equal(v.ready, true, '超期后允许继续（但明确告知限制）');
  assert.equal(v.action, 'warn');
  assert.ok(v.message.includes('未反混淆'));
  assert.ok(v.message.includes('能力将受限'));
});

test('真实混淆栈（启动器自身）不触发此检测', () => {
  // Zalith 的混淆栈是 R8 产物（z06/i8b），不是 Yarn intermediary
  const content = [
    '================ ZalithLauncher Crash Report ================',
    'java.lang.ClassCastException: z06 cannot be cast to i8b',
    '\tat j8b.a(Unknown Source:23)',
    '\tat q8b.g(Unknown Source:112)',
  ].join('\n');

  const r = detectObfuscation(content);
  assert.equal(r.obfuscated, false, 'R8 混淆栈不含 class_NNNN，应由此检测之外的手段处理');
});

test('samples 去重且限量', () => {
  const content = Array.from({ length: 100 }, () => 'class_1000 method_2000').join('\n');
  const r = detectObfuscation(content);
  assert.ok(r.samples.length <= 5);
  assert.equal(new Set(r.samples).size, r.samples.length, 'samples 应去重');
});
