/**
 * 配额测试 —— 重点验证 CGNAT 场景下的行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonymousId,
  checkSessionRounds,
  consume,
  dayKey,
  limitFor,
  resetCounter,
  secondsUntilTomorrow,
} from '../src/quota/limiter.ts';

test('匿名标识：指纹优先于 IP', () => {
  const a = anonymousId('1.2.3.4', 'UA1', 'device-fingerprint-abc');
  const b = anonymousId('9.9.9.9', 'UA2', 'device-fingerprint-abc');
  assert.equal(a, b, '同一指纹在不同 IP 下应视为同一用户（CGNAT 关键）');
});

test('匿名标识：无指纹时用 IP+UA', () => {
  const a = anonymousId('1.2.3.4', 'UA1');
  const b = anonymousId('1.2.3.4', 'UA1');
  const c = anonymousId('1.2.3.4', 'UA2');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('匿名标识：指纹被哈希（不作为注入载体）', () => {
  const a = anonymousId('1.2.3.4', 'UA', "'; DROP TABLE--");
  assert.ok(a.startsWith('fp:'));
  assert.ok(!a.includes('DROP'), '原始指纹不应出现在标识中');
  assert.equal(a.length, 3 + 24);
});

test('匿名标识：IP 维度与指纹维度不冲突', () => {
  const fp = anonymousId('1.2.3.4', 'UA', 'abc');
  const ip = anonymousId('1.2.3.4', 'UA');
  assert.notEqual(fp, ip);
});

test('CGNAT 场景：同一 IP 下不同设备互不挤占', async () => {
  resetCounter();
  const sharedIp = '10.0.0.1'; // 运营商出口

  // 10 台不同设备（不同指纹），同一出口 IP
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await consume('chat', anonymousId(sharedIp, 'UA', `device-${i}`), sharedIp));
  }

  assert.ok(
    results.every((r) => r.allowed),
    'CGNAT 下不同设备不应被互相挤占',
  );
});

test('配额上限：达到上限后 allowed=false 但给出降级说明', async () => {
  resetCounter();
  const ip = '203.0.113.7';
  const id = anonymousId(ip, 'UA', 'dev-x');
  const limit = limitFor('chat');

  for (let i = 0; i < limit; i++) {
    const r = await consume('chat', id, ip);
    assert.equal(r.allowed, true, `第 ${i + 1} 次应允许`);
  }

  const over = await consume('chat', id, ip);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
  assert.ok(over.reason?.includes('快速模式'), '应说明降级而非硬拒');
});

test('接近上限时 nearLimit 为真', async () => {
  resetCounter();
  const ip = '203.0.113.8';
  const id = anonymousId(ip, 'UA', 'dev-y');
  const limit = limitFor('chat');

  // 消费到剩余 20% 以内
  for (let i = 0; i < limit - 1; i++) {
    await consume('chat', id, ip);
  }
  const r = await consume('chat', id, ip);
  assert.equal(r.allowed, true);
  assert.equal(r.nearLimit, true, '剩余 1 次应提示接近上限');
});

test('IP 兜底：清除指纹后仍受 IP 维度约束', async () => {
  resetCounter();
  const ip = '198.51.100.9';
  const limit = limitFor('logId');
  const ipLimit = limit * 4; // ipFallbackMultiplier 默认 4

  // 每次都换指纹（模拟绕过），同一个 IP
  let denied = false;
  for (let i = 0; i < ipLimit + 2; i++) {
    const r = await consume('logId', anonymousId(ip, 'UA', `fresh-${i}`), ip);
    if (!r.allowed) {
      denied = true;
      break;
    }
  }
  assert.ok(denied, '即使反复换指纹，IP 兜底应最终拦住');
});

test('按成本分级：上传配额低于直接提问', () => {
  assert.ok(limitFor('upload') < limitFor('chat'), '上传成本更高，配额应更低');
  assert.ok(limitFor('logId') <= limitFor('chat'));
});

test('会话轮次上限', () => {
  assert.equal(checkSessionRounds(0).allowed, true);
  assert.equal(checkSessionRounds(9).allowed, true);
  assert.equal(checkSessionRounds(10).allowed, false);
  assert.equal(checkSessionRounds(10).remaining, 0);
  assert.equal(checkSessionRounds(7).remaining, 3);
});

test('自然日键与跨天 TTL', () => {
  const d = new Date(2026, 9, 15, 12, 0, 0); // 2026-10-15 12:00
  assert.equal(dayKey(d), '20261015');

  const ttl = secondsUntilTomorrow(d);
  assert.equal(ttl, 12 * 3600, '中午 12 点应剩 12 小时');

  // 跨天边界
  const late = new Date(2026, 9, 15, 23, 59, 59);
  assert.ok(secondsUntilTomorrow(late) >= 60, 'TTL 下限 60s');
});

test('计数失败时 fail-open（不因缓存抖动中断服务）', async () => {
  resetCounter();
  // 注入一个总是抛错的计数器
  const { setCounter, resetCounter: reset } = await import('../src/quota/limiter.ts');
  setCounter(async () => {
    throw new Error('redis down');
  });

  const r = await consume('chat', 'x', '1.2.3.4');
  assert.equal(r.allowed, true, '计数失败应放行（fail-open）');

  reset(); // 恢复默认
});
