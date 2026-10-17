/**
 * 客户端 IP 解析测试。
 *
 * 核心安全断言：不可信来源时绝不采信任何转发头（防伪造）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTrustedProxyMatcher, resolveClientIp } from '../src/security/clientIp.ts';

const TRUSTED = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

test('CIDR 匹配：私有网段与回环', () => {
  const m = buildTrustedProxyMatcher(TRUSTED);
  assert.equal(m('127.0.0.1'), true);
  assert.equal(m('10.1.2.3'), true);
  assert.equal(m('172.16.0.1'), true);
  assert.equal(m('172.31.255.254'), true);
  assert.equal(m('192.168.1.1'), true);
  // 边界：172.32 不在 172.16/12 内
  assert.equal(m('172.32.0.1'), false);
  assert.equal(m('8.8.8.8'), false);
  assert.equal(m('1.1.1.1'), false);
});

test('CIDR 边界精确性', () => {
  const m = buildTrustedProxyMatcher(['10.0.0.0/8']);
  assert.equal(m('10.0.0.0'), true);
  assert.equal(m('10.255.255.255'), true);
  assert.equal(m('11.0.0.0'), false);
  assert.equal(m('9.255.255.255'), false);
});

test('不可信来源：转发头一律忽略（防伪造）', () => {
  const ip = resolveClientIp({
    remoteAddress: '203.0.113.9', // 公网来源
    headers: {
      'x-real-ip': '1.2.3.4', // 伪造
      'x-forwarded-for': '9.9.9.9, 8.8.8.8', // 伪造
    },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '203.0.113.9', '不可信来源必须使用 socket 对端地址');
});

test('可信代理：优先 X-Real-IP', () => {
  const ip = resolveClientIp({
    remoteAddress: '172.18.0.1', // Docker 网关（可信）
    headers: {
      'x-real-ip': '198.51.100.7',
      'x-forwarded-for': '198.51.100.7',
    },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '198.51.100.7');
});

test('可信代理：XFF 从右向左剥离可信代理，取最外层不可信 IP', () => {
  const ip = resolveClientIp({
    remoteAddress: '172.18.0.1',
    headers: {
      // 客户端伪造了 1.1.1.1，真实来源是 198.51.100.7
      'x-forwarded-for': '1.1.1.1, 198.51.100.7, 172.18.0.1',
    },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '198.51.100.7', '应剥离右侧可信代理后取最外层不可信 IP');
});

test('XFF 全为可信代理：回退到最左侧', () => {
  const ip = resolveClientIp({
    remoteAddress: '172.18.0.1',
    headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '10.0.0.1');
});

test('IPv4-mapped IPv6 规范化', () => {
  const ip = resolveClientIp({
    remoteAddress: '::ffff:203.0.113.5',
    headers: {},
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '203.0.113.5');
});

test('无 remoteAddress 时按「不可信」处理，忽略转发头（防伪造）', () => {
  const ip = resolveClientIp({
    remoteAddress: undefined,
    headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
    trustedProxies: TRUSTED,
  });
  // 关键：不能回退到 127.0.0.1（回环在可信列表内，会导致伪造头被采信）
  assert.equal(ip, '0.0.0.0', '对端未知时必须按不可信处理，而非回环');
});

test('XFF 含非法项时跳过，不中断解析', () => {
  const ip = resolveClientIp({
    remoteAddress: '172.18.0.1',
    headers: { 'x-forwarded-for': 'not-an-ip, 198.51.100.9, 172.18.0.1' },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '198.51.100.9');
});

test('空 XFF 头：回退到 remote', () => {
  const ip = resolveClientIp({
    remoteAddress: '172.18.0.1',
    headers: { 'x-forwarded-for': '' },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '172.18.0.1');
});

test('IPv6 可信代理（::1）', () => {
  const ip = resolveClientIp({
    remoteAddress: '::1',
    headers: { 'x-real-ip': '2001:db8::1' },
    trustedProxies: TRUSTED,
  });
  assert.equal(ip, '2001:db8::1');
});
