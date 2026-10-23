/**
 * 日志正文解析：本地优先，LogShare 兜底。
 *
 * ## 为什么需要这一层
 *
 * 架构改革后正文有两个来源：
 *
 * | 来源 | 存哪 | 何时用 |
 * |---|---|---|
 * | native（本服务上传） | 本库 `log_bodies` | ID 就是会话 ID |
 * | logshare（导入） | LogShare（7 天） | 基础正文现取，追加段在本库 |
 *
 * 调用方（`GET /v1/log` 与 `/v1/chat`）不该各自拼装这套判断——
 * 两处逻辑一旦分叉，会出现「面板能看到、模型看不到」这类割裂。
 */

import { fetchLog } from '../logshare/client.ts';
import { getBase, listAppends, mergeSegments } from '../store/logbody.ts';
import { getSession } from '../store/session.ts';

export interface ResolvedLog {
  ok: boolean;
  /** 合并后的正文（含追加段） */
  content: string;
  /** 基础正文来源 */
  origin: 'local' | 'logshare' | 'none';
  /** 追加段数量 */
  appended: number;
  /** 基础日志已过期但仍有追加段 */
  baseExpired: boolean;
  /** 面向用户的提示（如「原日志已过期」） */
  note?: string;
  error?: string;
  files?: Array<{ name: string; data: string }>;
  source?: string;
}

/**
 * 按 ID 取合并正文。
 *
 * @param id 会话 ID（native）或 LogShare ID（导入）
 */
export async function resolveLogContent(id: string): Promise<ResolvedLog> {
  const base = await getBase(id);
  const appends = await listAppends(id);

  // 本地有主日志：直接合并（native 会话）
  if (base !== null && base.content !== '') {
    return {
      ok: true,
      content: mergeSegments(base.content, appends),
      origin: 'local',
      appended: appends.length,
      baseExpired: false,
      ...(base.files !== null && base.files.length > 0 ? { files: base.files } : {}),
      ...(base.source !== null ? { source: base.source } : {}),
    };
  }

  // 本地没有主日志：可能是 LogShare 导入的会话，也可能是纯追加
  const session = await getSession(id);
  const logshareId =
    session !== null && session.logKind === 'logshare' && session.logId !== null
      ? session.logId
      : // 会话查不到时，把 ID 本身当作 LogShare ID 试一次（兼容旧链接）
        (await getSession(id)) === null
        ? id
        : null;

  if (logshareId !== null && logshareId !== '') {
    const fetched = await fetchLog(logshareId);
    if (fetched.ok && fetched.content !== undefined && fetched.content !== '') {
      return {
        ok: true,
        content: mergeSegments(fetched.content, appends),
        origin: 'logshare',
        appended: appends.length,
        baseExpired: false,
        ...(fetched.source !== undefined ? { source: fetched.source } : {}),
      };
    }

    // 基础日志过期/不可读，但有追加段：仍可分析追加部分，并如实说明
    if (appends.length > 0) {
      return {
        ok: true,
        content: mergeSegments(null, appends),
        origin: 'logshare',
        appended: appends.length,
        baseExpired: true,
        note: '原日志已过期或不可读，当前只能分析后来追加的部分。',
      };
    }

    return {
      ok: false,
      content: '',
      origin: 'none',
      appended: 0,
      baseExpired: false,
      error: fetched.error ?? '未能读取该日志（可能已过期）',
    };
  }

  // 纯追加（LogShare 会话且基础正文从未成功取过）
  if (appends.length > 0) {
    return {
      ok: true,
      content: mergeSegments(null, appends),
      origin: 'none',
      appended: appends.length,
      baseExpired: true,
      note: '原日志不可读，当前只能分析后来追加的部分。',
    };
  }

  return {
    ok: false,
    content: '',
    origin: 'none',
    appended: 0,
    baseExpired: false,
    error: '没有可用的日志正文',
  };
}
