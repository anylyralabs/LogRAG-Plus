/**
 * 客户端真实 IP 解析 —— 与 LogShare `SecurityService::resolveClientIp()` 严格对齐。
 *
 * 为什么必须严格：配额与限流都以 IP 为维度之一。
 *  - 直接用 X-Forwarded-For 的最后一跳 → 可被客户端伪造，配额形同虚设
 *  - 直接用 remote_addr → Nginx 反代后全是内网 IP，所有用户共享一个配额
 *
 * 算法（与 PHP 一致）：
 *  1. remote_addr 不可信 → 直接返回 remote_addr
 *  2. remote_addr 可信 → 优先取 X-Real-IP（反代强制覆盖，最可信）
 *  3. 否则从 X-Forwarded-For **从右向左**剥离可信代理，返回最外层不可信 IP
 */

import { isIP } from 'node:net';

/** 解析 CIDR 或单 IP 为判定函数 */
interface CidrMatcher {
  matches(ip: string): boolean;
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number.parseInt(p, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function parseIPv6(ip: string): bigint | null {
  // 处理 IPv4-mapped（::ffff:1.2.3.4）
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) {
    const v4 = parseIPv4(v4mapped[1]!);
    if (v4 === null) return null;
    return (0xffff00000000n | BigInt(v4)) as bigint;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const expand = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;

  const full = [...head, ...Array(missing).fill('0'), ...tail];
  if (full.length !== 8) return null;

  let n = 0n;
  for (const group of full) {
    const v = Number.parseInt(group === '' ? '0' : group, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

function ipToNumber(ip: string): { kind: 4 | 6; value: number | bigint } | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return { kind: 4, value: v4 };
  const v6 = parseIPv6(ip);
  if (v6 !== null) return { kind: 6, value: v6 };
  return null;
}

function makeMatcher(entry: string): CidrMatcher | null {
  const [addr, prefixStr] = entry.split('/');
  if (!addr) return null;

  const target = ipToNumber(addr);
  if (target === null) return null;

  const bits = target.kind === 4 ? 32 : 128;
  const prefix = prefixStr === undefined ? bits : Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > bits) return null;

  const fullMask = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (fullMask << BigInt(bits - prefix)) & fullMask;
  const targetValue = BigInt(target.value) & mask;

  return {
    matches(ip: string): boolean {
      const candidate = ipToNumber(ip);
      if (candidate === null || candidate.kind !== target.kind) return false;
      return (BigInt(candidate.value) & mask) === targetValue;
    },
  };
}

/** 构建可信代理判定器（CIDR 支持，与 PHP isIpTrusted 一致） */
export function buildTrustedProxyMatcher(entries: string[]): (ip: string) => boolean {
  const matchers = entries
    .map((e) => makeMatcher(e.trim()))
    .filter((m): m is CidrMatcher => m !== null);

  return (ip: string): boolean => {
    if (isIP(ip) === 0) return false;
    return matchers.some((m) => m.matches(ip));
  };
}

export interface ClientIpInput {
  /** socket 层对端地址（Node 的 socket.remoteAddress） */
  remoteAddress: string | undefined;
  /** 请求头（小写键） */
  headers: Record<string, string | string[] | undefined>;
  trustedProxies: string[];
}

/** 规范化 Node 返回的 IPv4-mapped IPv6（::ffff:127.0.0.1 → 127.0.0.1） */
function normalizeRemote(remote: string | undefined): string {
  if (!remote) return '127.0.0.1';
  const m = remote.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1]! : remote;
}

/**
 * 安全哨兵：当 socket 对端地址缺失时使用。
 *
 * 不能回退到 127.0.0.1 —— 回环在 trustedProxies 内，会导致「对端未知」被误判为
 * 「可信代理」，进而采信客户端伪造的 X-Real-IP / X-Forwarded-For。
 * 使用一个永不匹配任何可信网段的保留地址，确保转发头被忽略。
 */
const UNKNOWN_REMOTE = '0.0.0.0';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const v = headers[name];
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

/**
 * 解析真实客户端 IP。
 *
 * 不可信来源时**绝不**采信任何转发头——这是防伪造的关键。
 */
export function resolveClientIp(input: ClientIpInput): string {
  const remote = input.remoteAddress
    ? normalizeRemote(input.remoteAddress)
    : UNKNOWN_REMOTE;
  const isTrusted = buildTrustedProxyMatcher(input.trustedProxies)(remote);

  if (!isTrusted) {
    // 对端不可信：转发头一律忽略
    return remote;
  }

  // 1. X-Real-IP 优先（反代强制覆盖，最可信）
  const realIp = headerValue(input.headers, 'x-real-ip').trim();
  if (realIp !== '' && isIP(realIp) !== 0) {
    return realIp;
  }

  // 2. X-Forwarded-For：从右向左剥离可信代理，取最外层不可信 IP
  const xff = headerValue(input.headers, 'x-forwarded-for');
  if (xff !== '') {
    const chain = xff
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const matcher = buildTrustedProxyMatcher(input.trustedProxies);
    for (let i = chain.length - 1; i >= 0; i--) {
      const candidate = chain[i]!;
      if (isIP(candidate) === 0) continue; // 跳过非法项
      if (!matcher(candidate)) {
        return candidate;
      }
    }
  }

  // 3. 全部可信：返回最左侧（若有）或对端
  const first = headerValue(input.headers, 'x-forwarded-for').split(',')[0]?.trim();
  if (first && isIP(first) !== 0) return first;

  return remote;
}
