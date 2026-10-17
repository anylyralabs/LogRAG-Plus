/**
 * 管理接口鉴权。
 *
 * ## 为什么是「fail-closed」
 *
 * 本服务不设登录、不收费（面向 CGNAT 后的普通玩家）。但**管理接口**完全不同：
 * 已知领域知识会原文注入每一次分析的系统提示词，等于间接改写所有用户的结论。
 * 一旦可匿名写入，任何人都能向全体用户的诊断结论里注入内容。
 *
 * 因此采取与 LogShare 边缘 WAF 一致的策略：
 *
 * | 配置状态 | 行为 |
 * |---|---|
 * | `ADMIN_ENABLED` 未开（默认） | 路由**返回 404**，不暴露存在性 |
 * | 已开且 `ADMIN_TOKEN` 为空 | **仍然 404**（宁可不可用，不可无保护可用） |
 * | 已开且 Token 非空 | 校验请求头，不匹配返回 401 |
 *
 * 「已开但没配 Token 就放行」是最常见的错误默认值——它让一次漏配直接变成
 * 公网可写。这里刻意让漏配表现为「功能不可用」，故障方向安全。
 *
 * ## 为什么比较要防时序侧信道
 *
 * `===` 在首个不同字符处短路返回，攻击者可据响应时间逐字节爆破 Token。
 * 用 `crypto.timingSafeEqual` 是标准做法；长度不同时先补齐再比，避免
 * 「长度不同即早退」本身泄漏长度信息。
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { admin as adminCfg } from '../config.ts';

/** 管理接口是否对外可用（开关打开**且** Token 已配置） */
export function adminApiEnabled(): boolean {
  return adminCfg.enabled && adminCfg.token !== '';
}

/**
 * 常量时间字符串比较。
 *
 * 长度不等时不做早退——先按较长者补齐再比，返回 false。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    // 仍然执行一次比较：让「长度不同」与「内容不同」在耗时上不可区分
    const padded = Buffer.alloc(bufA.length, 0);
    bufB.copy(padded, 0, 0, Math.min(bufA.length, bufB.length));
    timingSafeEqual(bufA, padded);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * 从请求头取管理员令牌。
 *
 * 同时接受 `Authorization: Bearer <token>`（标准形态）与 `X-Admin-Token`
 * （便于 curl/脚本）。两者都试，任一匹配即通过。
 */
function extractTokens(req: IncomingMessage): string[] {
  const out: string[] = [];

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    out.push(auth.slice(7).trim());
  }

  const xt = req.headers['x-admin-token'];
  if (typeof xt === 'string' && xt !== '') out.push(xt.trim());
  if (Array.isArray(xt)) out.push(...xt.map((v) => v.trim()).filter((v) => v !== ''));

  return out;
}

export type AdminCheck = 'ok' | 'not-found' | 'unauthorized';

/**
 * 校验管理请求。
 *
 * 返回 `'not-found'` 表示应把路由当作**不存在**处理（与普通 404 同形），
 * 这样未启用管理接口的部署不会因为「401 说明存在管理接口」而暴露攻击面。
 */
export function checkAdmin(req: IncomingMessage): AdminCheck {
  if (!adminApiEnabled()) return 'not-found';

  const provided = extractTokens(req);
  if (provided.length === 0) return 'unauthorized';

  for (const t of provided) {
    if (timingSafeEqualString(t, adminCfg.token)) return 'ok';
  }
  return 'unauthorized';
}

/** 操作者标识（写审计用）——优先取显式声明，否则记 `admin` */
export function adminActor(req: IncomingMessage): string {
  const raw = req.headers['x-admin-actor'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return 'admin';
  // 截断防止审计表被超长头部撑大
  return value.trim().slice(0, 64);
}
