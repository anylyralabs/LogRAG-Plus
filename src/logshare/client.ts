/**
 * LogShare 客户端。
 *
 * ## 职责边界（关键）
 * LogShare 是**唯一数据拥有者**，本服务只做两件事：
 *  1. **读取日志**（只读 MariaDB，或经公开 API）
 *  2. **转发上传**（内容交 LogShare 做脱敏 + 反混淆 + 去重 + 安全审核）
 *
 * **绝不自行处理上传内容**——LogShare 的写入路径含五个不可绕过的机制
 * （12 个 Filter 脱敏链、SpinYarn 反混淆、xxh128 去重、EventQueue 审核、分区回收），
 * 本服务复现既成本高又会绕过安全边界。
 *
 * ## 未配置时的降级
 * `LOGSHARE_INTERNAL_URL` 为空 → 独立运行模式：
 *  - 不支持按 ID 读取日志
 *  - 上传改为存入本地 SQLite（功能受限，需在 UI 明确告知）
 */

import { logshare as cfg } from '../config.ts';
import { decodeLogId, isMariaDbLogId } from './id.ts';

export interface FetchLogResult {
  ok: boolean;
  /** 日志正文 */
  content?: string;
  /** 附加文件 */
  files?: Array<{ name: string; size: number; data?: string }>;
  /** 来源标识（如 fcl/1.3.0） */
  source?: string;
  /** 创建时间（秒级时间戳） */
  createdAt?: number;
  /** 反混淆是否可能未完成（供调用方决定是否重试） */
  maybeObfuscating?: boolean;
  error?: string;
}

export interface UploadResult {
  ok: boolean;
  /** LogShare 分配的日志 ID */
  id?: string;
  /** 删除令牌（仅上传时返回） */
  token?: string;
  /** LogShare 给出的 raw 全文地址 */
  raw?: string;
  error?: string;
}

/** 读取超时（大日志） */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * 上传超时。比读取短：上传失败重试的成本高（内容大），
 * 且用户会盯着看；卡 60s 的体验比「明确失败请重试」更差。
 */
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * 按 ID 读取日志。
 *
 * 两种来源：
 *  1. 内部 API（`LOGSHARE_INTERNAL_URL` 配置时）——优先
 *  2. 公开 raw API（兜底，无需内部凭证）
 */
export async function fetchLog(logId: string): Promise<FetchLogResult> {
  const decoded = decodeLogId(logId);
  if (decoded === null) {
    return { ok: false, error: `日志 ID 格式非法：${logId}` };
  }

  // 只有 MariaDB 后端的日志能经 API 读取（文件系统后端的日志在 LogShare 容器内）
  if (!isMariaDbLogId(logId)) {
    // 文件系统后端仍可尝试 API（LogShare 会自行路由到存储抽象）
    // 但独立运行时无此能力
  }

  if (!cfg.canRead) {
    return {
      ok: false,
      error:
        '未配置 LogShare 读日志能力（LOGSHARE_INTERNAL_URL 与 LOGSHARE_PUBLIC_API_URL 均为空）。' +
        '请直接上传或粘贴日志内容。',
    };
  }

  // ── 路径 1：内部 API（推荐，可直接读只读库） ──
  const internal = await tryInternalFetch(logId);
  if (internal.ok) return internal;

  // ── 路径 2：公开 raw API 兜底 ──
  const publicResult = await tryPublicFetch(logId);
  if (publicResult.ok) return publicResult;

  // 错误信息取「有意见的那一个」：未配置的路径返回空串而不是占位文案。
  // 实测缺陷（2026-10-17）：原先写成 `internal.error ?? publicResult.error`，
  // 而独立运行时内部 API 必未配置，于是**任何**取日志失败都报「未配置内部 API」——
  // 用户输错一个 ID 会以为是服务端没配好，排查方向从第一步就偏了。
  return {
    ok: false,
    error: internal.error || publicResult.error || '读取日志失败',
  };
}

async function tryInternalFetch(logId: string): Promise<FetchLogResult> {
  // 空串表示「本路径没有意见」，而不是一条错误文案（见 fetchLog 末尾）
  if (cfg.internalUrl === '') return { ok: false, error: '' };

  const url = `${cfg.internalUrl.replace(/\/+$/, '')}/v1/internal/log/${encodeURIComponent(logId)}`;

  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(cfg.internalToken !== '' ? { 'x-internal-token': cfg.internalToken } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return { ok: false, error: '日志不存在或已过期' };
    }
    if (!res.ok) {
      return { ok: false, error: `内部 API 返回 HTTP ${res.status}` };
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        content?: string;
        files?: Array<{ name: string; size: number; data?: string }>;
        source?: string;
        created?: number;
      };
      message?: string;
    };

    if (body.success !== true || body.data === undefined) {
      return { ok: false, error: body.message ?? '内部 API 返回异常结构' };
    }

    return {
      ok: true,
      content: body.data.content ?? '',
      files: body.data.files ?? [],
      source: body.data.source,
      createdAt: body.data.created,
      // 创建后 60s 内可能仍在异步反混淆
      maybeObfuscating:
        body.data.created !== undefined &&
        Math.floor(Date.now() / 1000) - body.data.created < 60,
    };
  } catch (e) {
    return { ok: false, error: `内部 API 请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 公开 raw 兜底路径。
 *
 * ## URL 形态（实测校正，勿改回）
 * 线上实测（2026-10-17）：
 *
 * | 路径 | 结果 |
 * |---|---|
 * | `/v1/raw/{id}/main.log` | **HTTP 404** |
 * | `/v1/raw/{id}` | **HTTP 200，合并全文** |
 * | `/v1/raw/{id}/{真实文件名}` | HTTP 200，单文件 |
 *
 * 关键点：**日志里没有名为 `main.log` 的文件**，所以 `/main.log` 必然 404——
 * 但它并不是「接口不存在」，`/v1/raw/{id}/{filename}` 是有效的（已用
 * `launcher_log.txt` 97332 字节、`latest.log` 83190 字节验证通过）。
 *
 * 本函数取的是**不带文件名**的形式，因为它返回的是 LogShare 存储的
 * `content`——即**所有文件按 `===== 文件名 =====` 分节合并后的全文**
 * （实测 181304 字节，含 launcher_log.txt / latest.log / authlib-injector.log
 * 三节）。这正是分析所需的完整输入，无需再逐个拼接附加文件。
 *
 * 历史缺陷：此处曾写作 `/v1/raw/{id}/main.log`，导致公开兜底路径**永远 404**，
 * 于是「按 ID 取日志」在未配置内部 API 时彻底不可用。
 */
async function tryPublicFetch(logId: string): Promise<FetchLogResult> {
  if (cfg.publicApiUrl === '') return { ok: false, error: '未配置公开 API' };

  const url = `${cfg.publicApiUrl.replace(/\/+$/, '')}/v1/raw/${encodeURIComponent(logId)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { ok: false, error: '日志不存在或已过期' };
    if (!res.ok) return { ok: false, error: `公开 API 返回 HTTP ${res.status}` };

    return { ok: true, content: await res.text() };
  } catch (e) {
    return { ok: false, error: `公开 API 请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 转发上传到 LogShare。
 *
 * 内容必须经 LogShare 完整写入路径（脱敏 → 反混淆 → 去重 → 审核 → 分区落库），
 * 本服务不得自行处理。
 *
 * ## 两条路径为什么都能用
 *
 * 公网 `POST /v1/log` 是**真实客户端在用的那条**，它同样走完整流水线
 * （`LogController::create`：IP 黑名单 → 内容校验 → `Log::put` 落库 →
 * 派发 `EVENT_LOG_UPLOADED` 由异步队列做反混淆与安全审核）。
 * 因此「必须走 LogShare 脱敏与反混淆」这一约束在两条路径下都成立。
 *
 * 差别只在于：内部路径凭 `x-internal-token` 免边缘限流，公网路径要过 WAF。
 * 故**内部优先、公网兜底**——与本文件读取路径的策略保持一致。
 */
export async function uploadLog(
  content: string,
  options: { source?: string; files?: Array<{ name: string; data: string }> } = {},
): Promise<UploadResult> {
  if (!cfg.canUpload) {
    return {
      ok: false,
      error:
        '未配置 LogShare 上传能力（LOGSHARE_INTERNAL_URL 与 LOGSHARE_PUBLIC_API_URL 均为空）。' +
        '日志必须经 LogShare 完整写入流水线处理，本服务不自行落盘。',
    };
  }

  const payload: Record<string, unknown> = { content };
  if (options.source !== undefined) payload['source'] = options.source;
  if (options.files !== undefined && options.files.length > 0) payload['files'] = options.files;

  // ── 路径 1：内部 API（免边缘限流）──
  let internalError: string | undefined;
  if (cfg.internalUrl !== '') {
    const internal = await postUpload(
      `${cfg.internalUrl.replace(/\/+$/, '')}/v1/log`,
      payload,
      cfg.internalToken,
    );
    if (internal.ok) return internal;
    // 内部路径失败时不立刻回头报错：可能只是本机 Hyperf 未启动，
    // 而公网入口是活的。继续走兜底。
    internalError = internal.error;
  }

  // ── 路径 2：公网 API ──
  if (cfg.publicApiUrl !== '') {
    const pub = await postUpload(`${cfg.publicApiUrl.replace(/\/+$/, '')}/v1/log`, payload, '');
    if (pub.ok) return pub;
    return { ok: false, error: pub.error ?? internalError ?? '上传失败' };
  }

  return { ok: false, error: internalError ?? '上传失败' };
}

/** 发起一次上传请求并解析 LogShare 的响应结构 */
async function postUpload(
  url: string,
  payload: Record<string, unknown>,
  token: string,
): Promise<UploadResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== '' ? { 'x-internal-token': token } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    const body = (await res.json()) as {
      success?: boolean;
      data?: { id?: string; token?: string; raw?: string; url?: string };
      message?: string;
      error?: string;
    };

    if (!res.ok || body.success !== true) {
      return {
        ok: false,
        error: body.message ?? body.error ?? `上传失败（HTTP ${res.status}）`,
      };
    }

    if (body.data?.id === undefined) {
      return { ok: false, error: '上传响应缺少日志 ID' };
    }

    return {
      ok: true,
      id: body.data.id,
      ...(body.data.token !== undefined ? { token: body.data.token } : {}),
      ...(body.data.raw !== undefined ? { raw: body.data.raw } : {}),
    };
  } catch (e) {
    return { ok: false, error: `上传请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** LogShare 联动是否可用 */
export function isLinked(): boolean {
  return cfg.enabled;
}
