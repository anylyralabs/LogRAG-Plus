/**
 * 管理接口客户端。
 *
 * 鉴权形态（对齐 `src/security/adminAuth.ts`）：
 *
 * | 服务端状态 | 响应 | 界面必须怎么解释 |
 * |---|---|---|
 * | 未开启管理接口 | **404** | 「管理接口未开启」，**不是**「令牌错了」 |
 * | 已开启但未配置令牌 | **404** | 同上（宁可不可用，不可无保护可用） |
 * | 令牌不匹配 | **401** | 「令牌不对」 |
 *
 * 这三条不能合并成一句「访问被拒绝」：服务端刻意用 404 隐藏管理面的存在，
 * 如果界面把 404 说成「令牌错误」，运维会去反复换令牌而不是去开配置项。
 */

import { ApiError, getJson, postJson } from './client.ts';
import type { AnalysisRecord, DomainEntry, EntryAnalysis } from './types.ts';

export interface AdminError {
  fatal: boolean;
  message: string;
}

/** 把异常翻译成运维看得懂的话；`fatal` 表示「再试也没用，得改服务端配置」 */
export function explainAdminError(e: unknown): AdminError {
  if (e instanceof ApiError) {
    if (e.status === 404) {
      return {
        fatal: true,
        message: '服务端未开启管理接口（Admin 路由按不存在处理）。需要在服务端启用并配置访问令牌。',
      };
    }
    if (e.status === 401) {
      return { fatal: false, message: '访问令牌不正确。' };
    }
    return { fatal: e.status >= 500, message: e.message };
  }
  return { fatal: false, message: e instanceof Error ? e.message : '请求失败' };
}

function auth(token: string): Record<string, string> {
  return { 'x-admin-token': token };
}

// ── 领域知识 ────────────────────────────────────────────

export interface DomainListResult {
  ok: boolean;
  entries: DomainEntry[];
  stats: Record<string, unknown>;
}

export function listDomain(token: string, params: Record<string, string> = {}): Promise<DomainListResult> {
  const qs = new URLSearchParams(params).toString();
  return getJson<DomainListResult>(`/v1/admin/domain-knowledge${qs === '' ? '' : `?${qs}`}`, auth(token));
}

export interface MutationResult {
  ok: boolean;
  entry?: DomainEntry;
  error?: string;
  warnings?: string[];
}

export function createDomain(token: string, body: Record<string, unknown>): Promise<MutationResult> {
  return postJson<MutationResult>('/v1/admin/domain-knowledge', body, auth(token));
}

export function analyzeText(token: string, content: string): Promise<EntryAnalysis & { ok: boolean; chars?: number }> {
  return postJson<EntryAnalysis & { ok: boolean; chars?: number }>(
    '/v1/admin/domain-knowledge/analyze',
    { content },
    auth(token),
  );
}

export interface InjectionPreview {
  ok: boolean;
  chars: number;
  injected: Array<{ id: string; content: string; priority: number }>;
  skipped: Array<{ id: string; content: string; priority: number }>;
  text: string;
}

export function injectionPreview(token: string): Promise<InjectionPreview> {
  return getJson<InjectionPreview>('/v1/admin/domain-knowledge/injection', auth(token));
}

export interface AuditRecord {
  id: string;
  action: string;
  entryId?: string;
  content?: string;
  actor?: string;
  createdAt: number;
  [key: string]: unknown;
}

export function auditList(token: string, limit = 50): Promise<{ ok: boolean; records: AuditRecord[] }> {
  return getJson<{ ok: boolean; records: AuditRecord[] }>(
    `/v1/admin/domain-knowledge/audit?limit=${String(limit)}`,
    auth(token),
  );
}

export async function updateDomain(
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<MutationResult> {
  const res = await fetch(`${apiPrefix()}/v1/admin/domain-knowledge/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth(token) },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as MutationResult;
  if (!res.ok) throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`, payload);
  return payload;
}

export async function removeDomain(token: string, id: string): Promise<MutationResult> {
  const res = await fetch(`${apiPrefix()}/v1/admin/domain-knowledge/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  const payload = (await res.json()) as MutationResult;
  if (!res.ok) throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`, payload);
  return payload;
}

// ── 分析记录 ────────────────────────────────────────────

export interface RecordsResult {
  ok: boolean;
  records: AnalysisRecord[];
  total: number;
}

export function listRecords(token: string, params: Record<string, string> = {}): Promise<RecordsResult> {
  const qs = new URLSearchParams(params).toString();
  return getJson<RecordsResult>(`/v1/admin/records${qs === '' ? '' : `?${qs}`}`, auth(token));
}

export interface RecordsStats {
  total?: number;
  averageOverall?: number;
  deliverableRate?: number;
  days?: number;
  [key: string]: unknown;
}

export function recordsStats(token: string, days?: number): Promise<{ ok: boolean; stats: RecordsStats }> {
  const qs = days === undefined ? '' : `?days=${String(days)}`;
  return getJson<{ ok: boolean; stats: RecordsStats }>(`/v1/admin/records/stats${qs}`, auth(token));
}

export function getRecord(token: string, id: string): Promise<{ ok: boolean; record: AnalysisRecord }> {
  return getJson<{ ok: boolean; record: AnalysisRecord }>(
    `/v1/admin/records/${encodeURIComponent(id)}`,
    auth(token),
  );
}

export async function removeRecord(token: string, id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${apiPrefix()}/v1/admin/records/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: auth(token),
  });
  const payload = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok) throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`, payload);
  return payload;
}

export function purgeRecords(token: string): Promise<{ ok: boolean; deleted: number }> {
  return postJson<{ ok: boolean; deleted: number }>('/v1/admin/records/purge', {}, auth(token));
}

/** 与 `api/client.ts` 保持同一套基地址逻辑（含 localStorage 覆盖） */
function apiPrefix(): string {
  const override = localStorage.getItem('lograg.apiBase');
  return override !== null && override.trim() !== '' ? override.trim().replace(/\/$/, '') : '';
}
