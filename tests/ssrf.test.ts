/**
 * SSRF 防护测试。
 *
 * 这是自定义模型供应商的**核心安全边界**——用户输入 URL，攻击面直接暴露在公网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SsrfError,
  isLinkLocal,
  isLoopback,
  isPrivate,
  normalizeBaseUrl,
  validateProviderUrl,
} from '../src/security/ssrf.ts';

/** 测试用解析器：把域名映射到指定 IP */
const resolver = (map: Record<string, string[]>) => async (hostname: string) => {
  const ips = map[hostname];
  if (!ips) throw new Error(`ENOTFOUND ${hostname}`);
  return ips;
};

test('IP 分类：回环', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.255.255.254'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('8.8.8.8'), false);
});

test('IP 分类：私网与保留段', () => {
  for (const ip of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '169.254.1.1', // 链路本地
    '0.0.0.0',
    '224.0.0.1', // 组播
  ]) {
    assert.equal(isPrivate(ip), true, `${ip} 应判为私网/保留`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.1']) {
    // 注意 203.0.113.0/24 是 TEST-NET-3，按保留处理
    const expected = ip === '203.0.113.1';
    assert.equal(isPrivate(ip), expected, `${ip} 分类错误`);
  }
});

test('IP 分类：IPv6 私网', () => {
  assert.equal(isPrivate('fc00::1'), true);
  assert.equal(isPrivate('fd12:3456::1'), true);
  assert.equal(isPrivate('fe80::1'), true);
  assert.equal(isPrivate('::'), true);
  assert.equal(isPrivate('2001:db8::1'), false);
});

test('链路本地：云元数据端点必须被识别', () => {
  assert.equal(isLinkLocal('169.254.169.254'), true, 'AWS/GCP 元数据端点');
  assert.equal(isLinkLocal('fe80::1'), true);
  assert.equal(isLinkLocal('8.8.8.8'), false);
});

test('拒绝非 HTTP(S) 协议', async () => {
  for (const url of [
    'file:///etc/passwd',
    'gopher://evil.com',
    'ftp://evil.com',
    'javascript:alert(1)',
    'data:text/plain,hi',
  ]) {
    await assert.rejects(
      () => validateProviderUrl(url),
      (e: unknown) => e instanceof SsrfError,
      `${url} 应被拒绝`,
    );
  }
});

test('拒绝字面量私网 IP', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1']) {
    await assert.rejects(
      () => validateProviderUrl(`http://${ip}/v1`),
      (e: unknown) => e instanceof SsrfError,
      `${ip} 应被拒绝`,
    );
  }
});

test('拒绝云元数据端点（SSRF 最危险目标）', async () => {
  await assert.rejects(
    () => validateProviderUrl('http://169.254.169.254/latest/meta-data/'),
    (e: unknown) => e instanceof SsrfError,
  );
});

test('拒绝解析到私网的域名（DNS Rebinding 场景）', async () => {
  await assert.rejects(
    () =>
      validateProviderUrl('http://evil.example.com/v1', {
        resolve: resolver({ 'evil.example.com': ['192.168.1.100'] }),
      }),
    (e: unknown) => e instanceof SsrfError,
  );
});

test('拒绝解析到回环的域名（默认）', async () => {
  await assert.rejects(
    () =>
      validateProviderUrl('http://local.example.com/v1', {
        resolve: resolver({ 'local.example.com': ['127.0.0.1'] }),
      }),
    (e: unknown) => e instanceof SsrfError,
  );
});

test('多 A 记录：任一为私网即拒绝（防部分绕过）', async () => {
  await assert.rejects(
    () =>
      validateProviderUrl('http://mixed.example.com/v1', {
        resolve: resolver({ 'mixed.example.com': ['8.8.8.8', '10.0.0.1'] }),
      }),
    (e: unknown) => e instanceof SsrfError,
    '存在私网 IP 时必须整体拒绝',
  );
});

test('allowLoopback 仅放行回环，私网仍拒绝', async () => {
  // 回环放行
  const ok = await validateProviderUrl('http://127.0.0.1:11434/v1', {
    allowLoopback: true,
  });
  assert.equal(ok.url.port, '11434');

  // 私网仍拒绝（即使开了 allowLoopback）
  await assert.rejects(
    () => validateProviderUrl('http://192.168.1.1/v1', { allowLoopback: true }),
    (e: unknown) => e instanceof SsrfError,
    'allowLoopback 不得放行私网',
  );
});

test('正常公网地址通过', async () => {
  const r = await validateProviderUrl('https://api.openai.com/v1', {
    resolve: resolver({ 'api.openai.com': ['104.18.6.192'] }),
  });
  assert.equal(r.url.hostname, 'api.openai.com');
  assert.deepEqual(r.resolvedIps, ['104.18.6.192']);
});

test('DNS 解析失败时拒绝（不静默放行）', async () => {
  await assert.rejects(
    () =>
      validateProviderUrl('http://nonexistent.example.com/v1', {
        resolve: resolver({}),
      }),
    (e: unknown) => e instanceof SsrfError,
  );
});

test('normalizeBaseUrl 去除尾部斜杠', () => {
  assert.equal(normalizeBaseUrl('https://api.x.com/v1/'), 'https://api.x.com/v1');
  assert.equal(normalizeBaseUrl('  https://api.x.com/v1  '), 'https://api.x.com/v1');
});
