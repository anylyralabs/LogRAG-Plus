/**
 * 配额与限流。
 *
 * ## 设计依据（实测教训）
 * 项目自身已有 CGNAT 教训记录：「CC 不是攻击证据，对 CGNAT/校园网出口不该把整个
 * 出口封 10 分钟」。而实测的 27 份日志**全部来自手机端**，移动网络正是 CGNAT
 * 最普遍的场景——一个出口 IP 可能对应数千用户。
 *
 * 因此本实现：
 *  1. **双维度标识**：设备指纹优先，IP 兜底（避免 CGNAT 下真实用户互相挤占）
 *  2. **降级而非硬拒**：超配额时降级为快速模式，而非 429（避免误伤真实用户）
 *  3. **按成本分级**：直接提问 > 携带日志 ID > 上传日志（成本递增，配额递减）
 *  4. **Redis 可选**：未配置时降级为进程内计数（多副本不准但保证可用）
 */

import { createHash } from 'node:crypto';

import { quota as cfg, redis as redisCfg } from '../config.ts';

export type QuotaKind = 'chat' | 'logId' | 'upload';

export interface QuotaResult {
  /** 是否允许完整分析 */
  allowed: boolean;
  /** 剩余次数 */
  remaining: number;
  /** 配额上限 */
  limit: number;
  /** 是否接近上限（前端提示用） */
  nearLimit: boolean;
  /** 超限时的说明（面向用户） */
  reason?: string;
}

/** 递增器：返回递增后的计数。由调用方注入（内存或 Redis 实现） */
export type Counter = (key: string, ttlSeconds: number) => Promise<number>;

/**
 * 生成匿名用户标识。
 *
 * 优先级：
 *  1. 前端生成的设备指纹（localStorage 持久化）——跨 IP 稳定，规避 CGNAT
 *  2. IP + User-Agent 哈希——指纹缺失时的兜底
 *
 * 诚实说明：指纹可被清除 localStorage 绕过。因此另有 IP 维度兜底限额
 * （阈值更高，见 `ipFallbackMultiplier`）。
 */
export function anonymousId(clientIp: string, userAgent: string, fingerprint?: string): string {
  if (fingerprint !== undefined && fingerprint.trim() !== '') {
    // 指纹来自客户端，哈希后再用（避免作为注入载体）
    return `fp:${sha256(fingerprint.trim()).slice(0, 24)}`;
  }
  return `ipua:${sha256(`${clientIp}|${userAgent}`).slice(0, 24)}`;
}

/** IP 维度的兜底键（显式区分维度，避免与指纹键冲突） */
function ipDimensionId(clientIp: string): string {
  return `ip:${sha256(clientIp).slice(0, 24)}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 当日键（自然日，本地时区） */
export function dayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 距次日 0 点的秒数（TTL 用；下限 60s 避免边界抖动） */
export function secondsUntilTomorrow(now = new Date()): number {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return Math.max(60, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));
}

/** 配额上限（按成本分级） */
export function limitFor(kind: QuotaKind): number {
  switch (kind) {
    case 'chat':
      return cfg.chat;
    case 'logId':
      return cfg.logId;
    case 'upload':
      return cfg.upload;
  }
}

/**
 * 内存计数器。
 *
 * 多副本部署时各进程独立计数（不准），但保证服务可用——与 LogShare 把 Redis
 * 当可选依赖的设计保持一致。
 */
export function createMemoryCounter(): Counter {
  const store = new Map<string, { count: number; expires: number }>();

  return async (key: string, ttlSeconds: number): Promise<number> => {
    const now = Date.now();

    // 容量保护：超过阈值时清理过期项
    if (store.size > 10_000) {
      for (const [k, v] of store) {
        if (v.expires < now) store.delete(k);
      }
    }

    const entry = store.get(key);
    if (entry === undefined || entry.expires < now) {
      store.set(key, { count: 1, expires: now + ttlSeconds * 1000 });
      return 1;
    }
    entry.count++;
    return entry.count;
  };
}

/** 默认计数器（进程内） */
let counter: Counter = createMemoryCounter();

/** 注入计数器实现（生产环境可换成 Redis 版） */
export function setCounter(fn: Counter): void {
  counter = fn;
}

/** 配额键 */
function keysFor(kind: QuotaKind, anonId: string, clientIp: string): { main: string; ip: string } {
  const day = dayKey();
  const p = redisCfg.prefix;
  return {
    main: `${p}quota:${kind}:${anonId}:${day}`,
    ip: `${p}quota:${kind}:${ipDimensionId(clientIp)}:${day}`,
  };
}

/**
 * 检查并消费一次配额。
 *
 * 双维度同时计数：
 *  - 主维度（指纹或 IP+UA）：常规配额
 *  - IP 维度：兜底配额（阈值更高），防止清除 localStorage 绕过指纹后无限使用
 */
export async function consume(
  kind: QuotaKind,
  anonId: string,
  clientIp: string,
): Promise<QuotaResult> {
  const limit = limitFor(kind);
  const ipLimit = limit * cfg.ipFallbackMultiplier;
  const ttl = secondsUntilTomorrow();
  const { main, ip } = keysFor(kind, anonId, clientIp);
  const warnAt = Math.ceil(limit * cfg.warnThreshold);

  try {
    const mainCount = await counter(main, ttl);
    const ipCount = await counter(ip, ttl);

    if (mainCount > limit || ipCount > ipLimit) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        nearLimit: true,
        reason:
          '今日的完整分析次数已用完。你仍可以继续提问，但回答会采用「快速模式」（不进行多轮检索与验证）。',
      };
    }

    const remaining = Math.max(0, limit - mainCount);
    return {
      allowed: true,
      remaining,
      limit,
      // 剩余低于 20% 时提示
      nearLimit: remaining <= limit - warnAt,
    };
  } catch {
    // 计数失败：fail-open（避免缓存抖动放大为服务不可用）
    return { allowed: true, remaining: limit, limit, nearLimit: false };
  }
}

/** 会话轮次检查（每会话上限） */
export function checkSessionRounds(rounds: number): { allowed: boolean; remaining: number } {
  const limit = cfg.roundsPerSession;
  return {
    allowed: rounds < limit,
    remaining: Math.max(0, limit - rounds),
  };
}

/** 供测试重置默认计数器 */
export function resetCounter(): void {
  counter = createMemoryCounter();
}
