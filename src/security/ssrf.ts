/**
 * 自定义模型供应商的 URL 校验（SSRF 防护）。
 *
 * 与 LogShare 的 `HttpReranker::normalizeEndpoint` / `MCPClient` 同思路，但**更严**：
 * 那些是服务端配置（可信），而这里是**用户输入**（不可信）。
 *
 * 关键差异：
 *  1. 每次请求前重新校验（防 DNS Rebinding —— 保存时解析到公网，请求时重绑内网）
 *  2. 校验**解析后的实际 IP**，而非仅字面量
 *  3. 默认拒绝回环与私网；回环需显式开启（自建 Ollama 场景），私网永不放行
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** 私有 / 保留网段（IPv4） */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // CGNAT（运营商级 NAT）
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 中继
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
];

function ipv4ToInt(ip: string): number | null {
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

function inV4Range(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** 是否回环地址 */
export function isLoopback(ip: string): boolean {
  if (isIP(ip) === 4) return inV4Range(ip, '127.0.0.0', 8);
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '0:0:0:0:0:0:0:1';
}

/** 是否私网 / 保留地址 */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    return PRIVATE_V4.some(([base, bits]) => inV4Range(ip, base, bits));
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped：按 IPv4 判定
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivate(m[1]!);

    // fc00::/7 唯一本地地址
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    // fe80::/10 链路本地
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // ff00::/8 组播
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
    // ::/128 未指定
    if (lower === '::') return true;
    return false;
  }
  return false;
}

/** 是否链路本地（含云元数据端点） */
export function isLinkLocal(ip: string): boolean {
  if (isIP(ip) === 4) return inV4Range(ip, '169.254.0.0', 16);
  return /^fe[89ab][0-9a-f]:/i.test(ip);
}

export interface ProviderUrlOptions {
  /** 是否允许回环（自建 Ollama / TEI 场景）；私网永不放行 */
  allowLoopback?: boolean;
  /** 注入 DNS 解析器（测试用） */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface ValidatedProviderUrl {
  url: URL;
  /** 解析后的 IP（已全部通过校验） */
  resolvedIps: string[];
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * 校验用户提供的供应商 URL。
 *
 * **必须在每次发请求前调用**（不能只在保存时校验）——DNS Rebinding 的攻击窗口
 * 正是「保存时公网、请求时内网」。
 *
 * @throws {SsrfError} 协议非法、目标为私网/保留地址、或回环未获授权
 */
export async function validateProviderUrl(
  raw: string,
  options: ProviderUrlOptions = {},
): Promise<ValidatedProviderUrl> {
  const { allowLoopback = false, resolve = defaultResolve } = options;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('供应商地址不是合法的 URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('供应商地址仅支持 http / https 协议');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  if (hostname === '') {
    throw new SsrfError('供应商地址缺少主机名');
  }

  // 字面量 IP：直接校验，无需 DNS
  if (isIP(hostname) !== 0) {
    checkIp(hostname, allowLoopback, hostname);
    return { url, resolvedIps: [hostname] };
  }

  // 域名：解析后校验**每一个** IP（防止多 A 记录绕过）
  let ips: string[];
  try {
    ips = await resolve(hostname);
  } catch {
    throw new SsrfError(`无法解析主机名: ${hostname}`);
  }

  if (ips.length === 0) {
    throw new SsrfError(`主机名无解析结果: ${hostname}`);
  }

  for (const ip of ips) {
    checkIp(ip, allowLoopback, hostname);
  }

  return { url, resolvedIps: ips };
}

function checkIp(ip: string, allowLoopback: boolean, hostname: string): void {
  if (isLinkLocal(ip)) {
    // 云元数据端点（169.254.169.254）是最危险的 SSRF 目标
    throw new SsrfError(`目标解析到链路本地地址，已拒绝: ${hostname}`);
  }

  if (isLoopback(ip)) {
    if (!allowLoopback) {
      throw new SsrfError(
        `目标解析到回环地址，已拒绝: ${hostname}。若使用本机自建服务，请开启 ALLOW_LOOPBACK_PROVIDER`,
      );
    }
    return;
  }

  if (isPrivate(ip)) {
    // 私网永不放行（即使 allowLoopback 开启）——避免打穿内网
    throw new SsrfError(`目标解析到私网地址，已拒绝: ${hostname}`);
  }
}

/**
 * 规范化供应商 baseUrl：补全 /v1 后缀（OpenAI 兼容约定）。
 * 不改变语义，仅做格式整理。
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}
