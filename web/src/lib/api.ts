/**
 * 后端 API 客户端。
 *
 * 所有请求走同源相对路径：页面与 `/v1` 由同一个 Node 进程托管，不需要 CORS，
 * 也不会因为换域名而把接口地址写死在构建产物里。
 */

import { consumeSse, type SseHandlers } from './sse'
import { fingerprint } from './history'
import type {
  AnalysisRecord,
  AnalysisStats,
  AppendResponse,
  AuditRecord,
  ChatRequest,
  DomainKnowledge,
  DomainKnowledgeList,
  DonePayload,
  EntryAnalysis,
  EntryKind,
  HealthResponse,
  InjectionPreview,
  LogDocsResponse,
  MutationResult,
  SessionReplay,
  UploadResponse,
} from './types'

/** 请求失败：带 HTTP 状态与后端**原文**，界面直接展示，不自行编造文案。 */
export class ApiError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, message: string, payload?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

/** 解析响应体：优先用后端 `error` 字段，其次截断文本 */
async function readError(res: Response): Promise<ApiError> {
  const text = await res.text()
  let payload: unknown = null
  let message = `请求失败（HTTP ${res.status}）`

  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = null
  }

  if (payload !== null && typeof payload === 'object' && 'error' in payload) {
    const err = (payload as { error: unknown }).error
    if (typeof err === 'string' && err.trim() !== '') message = err
  } else if (text.trim() !== '') {
    message = text.slice(0, 300)
  }

  return new ApiError(res.status, message, payload)
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (text === '') return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(res.status, '服务返回了无法解析的响应', text.slice(0, 300))
  }
}

async function getJson<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, { headers })
  if (!res.ok) throw await readError(res)
  return parseJson<T>(res)
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res)
  return parseJson<T>(res)
}

async function requestJson<T>(
  path: string,
  method: 'PUT' | 'DELETE',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw await readError(res)
  return parseJson<T>(res)
}

export const api = {
  health(): Promise<HealthResponse> {
    return getJson<HealthResponse>('/health')
  },

  topics(): Promise<{ ok: boolean; topics: string }> {
    return getJson('/v1/topics')
  },

  logDocs(logId: string, options: { refresh?: boolean } = {}): Promise<LogDocsResponse> {
    const suffix = options.refresh === true ? '?refresh=1' : ''
    return getJson(`/v1/log/${encodeURIComponent(logId)}${suffix}`)
  },

  replaySession(sessionId: string): Promise<SessionReplay> {
    return getJson(`/v1/session/${encodeURIComponent(sessionId)}`)
  },

  upload(body: {
    content?: string
    files?: Array<{ name: string; data: string }>
    source?: string
  }): Promise<UploadResponse> {
    // 指纹与服务端配额归属一致：聊天已带，上传也必须带。
    // 不带的话同一台设备在「聊天」与「上传」上会被算成两个匿名主体，
    // 表现为「今天还剩 5 次上传」但实际是按 IP 池共享的。
    return postJson('/v1/upload', { ...body, fingerprint: fingerprint() })
  },

  /**
   * 追加一段材料到既有会话。
   *
   * 与上传共用请求体与配额，但**不新建会话**：会话 ID 与 URL 都不变，
   * 后续对话自动读到合并后的正文。
   */
  append(
    sessionId: string,
    body: {
      content?: string
      files?: Array<{ name: string; data: string }>
      source?: string
    },
  ): Promise<AppendResponse> {
    return postJson(`/v1/session/${encodeURIComponent(sessionId)}/append`, {
      ...body,
      fingerprint: fingerprint(),
    })
  },

  createDomainKnowledge(
    body: { content: string; enabled?: boolean; priority?: number; tags?: string[]; kindOverride?: EntryKind },
    token: string,
  ): Promise<MutationResult> {
    return postJson('/v1/admin/domain-knowledge', body, adminHeaders(token))
  },

  domainKnowledge(
    options: { enabledOnly?: boolean; tag?: string; keyword?: string; limit?: number },
    token: string,
  ): Promise<DomainKnowledgeList> {
    const q = new URLSearchParams()
    if (options.enabledOnly === true) q.set('enabledOnly', '1')
    if (options.tag !== undefined && options.tag !== '') q.set('tag', options.tag)
    if (options.keyword !== undefined && options.keyword !== '') q.set('keyword', options.keyword)
    if (options.limit !== undefined) q.set('limit', String(options.limit))
    const suffix = q.toString() === '' ? '' : `?${q.toString()}`
    return getJson(`/v1/admin/domain-knowledge${suffix}`, adminHeaders(token))
  },

  analyzeDomainKnowledge(content: string, token: string): Promise<EntryAnalysis> {
    return postJson('/v1/admin/domain-knowledge/analyze', { content }, adminHeaders(token))
  },

  domainKnowledgeAudit(token: string, limit = 100): Promise<{ ok: boolean; records: AuditRecord[] }> {
    return getJson(`/v1/admin/domain-knowledge/audit?limit=${limit}`, adminHeaders(token))
  },

  injectionPreview(token: string): Promise<InjectionPreview> {
    return getJson('/v1/admin/domain-knowledge/injection', adminHeaders(token))
  },

  searchDomainKnowledge(
    query: string,
    token: string,
  ): Promise<{ ok: boolean; query: string; hits: DomainKnowledge[] }> {
    return getJson(
      `/v1/admin/domain-knowledge/search?q=${encodeURIComponent(query)}`,
      adminHeaders(token),
    )
  },

  updateDomainKnowledge(
    id: string,
    body: { content?: string; enabled?: boolean; priority?: number; tags?: string[]; kindOverride?: EntryKind },
    token: string,
  ): Promise<MutationResult> {
    return requestJson(`/v1/admin/domain-knowledge/${encodeURIComponent(id)}`, 'PUT', body, adminHeaders(token))
  },

  removeDomainKnowledge(id: string, token: string): Promise<MutationResult> {
    return requestJson(`/v1/admin/domain-knowledge/${encodeURIComponent(id)}`, 'DELETE', undefined, adminHeaders(token))
  },

  records(
    options: {
      limit?: number
      offset?: number
      minScore?: number
      maxScore?: number
      deliverable?: boolean
      logId?: string
      model?: string
      orderBy?: 'created' | 'overall' | 'rounds' | 'tool_calls'
      ascending?: boolean
    },
    token: string,
  ): Promise<{ ok: boolean; records: AnalysisRecord[]; total: number }> {
    const q = new URLSearchParams()
    if (options.limit !== undefined) q.set('limit', String(options.limit))
    if (options.offset !== undefined) q.set('offset', String(options.offset))
    if (options.minScore !== undefined) q.set('minScore', String(options.minScore))
    if (options.maxScore !== undefined) q.set('maxScore', String(options.maxScore))
    if (options.deliverable === true) q.set('deliverable', '1')
    if (options.deliverable === false) q.set('deliverable', '0')
    if (options.logId !== undefined && options.logId !== '') q.set('logId', options.logId)
    if (options.model !== undefined && options.model !== '') q.set('model', options.model)
    if (options.orderBy !== undefined) q.set('orderBy', options.orderBy)
    if (options.ascending === true) q.set('ascending', '1')
    return getJson(`/v1/admin/records?${q.toString()}`, adminHeaders(token))
  },

  recordsStats(token: string, days?: number): Promise<{ ok: boolean; stats: AnalysisStats }> {
    const suffix = days === undefined ? '' : `?days=${days}`
    return getJson(`/v1/admin/records/stats${suffix}`, adminHeaders(token))
  },

  record(id: string, token: string): Promise<{ ok: boolean; record: AnalysisRecord }> {
    return getJson(`/v1/admin/records/${encodeURIComponent(id)}`, adminHeaders(token))
  },

  deleteRecord(id: string, token: string): Promise<{ ok: boolean; deleted: string }> {
    return requestJson(`/v1/admin/records/${encodeURIComponent(id)}`, 'DELETE', undefined, adminHeaders(token))
  },

  purgeRecords(token: string): Promise<{ ok: boolean; deleted: number }> {
    return postJson('/v1/admin/records/purge', {}, adminHeaders(token))
  },
}

/** 管理接口统一用 `x-admin-token`；也接受 Bearer，但这里只需一种。 */
export function adminHeaders(token: string): Record<string, string> {
  return { 'x-admin-token': token }
}

/**
 * 管理接口失败的三态。
 *
 * 后端刻意把两种情况都返回 404（未开启 / 已开启但未配 Token），
 * 因此前端**无法**区分它们——只能提示「检查哪两个配置项」。
 * 401 才是「令牌不正确」，必须单独说。
 */
export type AdminGateState = 'idle' | 'ok' | 'disabled' | 'unauthorized' | 'error'

export function classifyAdminError(e: unknown): AdminGateState {
  if (!(e instanceof ApiError)) return 'error'
  if (e.status === 401) return 'unauthorized'
  if (e.status === 404) return 'disabled'
  return 'error'
}

/* ── 对话流 ─────────────────────────────────────────────── */

export interface StreamResult {
  /** 收到 done 帧（不代表一定有正文） */
  gotDone: boolean
  done: DonePayload | null
  /** 收到 error 帧 */
  gotError: boolean
  error: string | null
}

/**
 * 发一轮对话。
 *
 * 推流前失败会返回**普通 JSON**（参数非法 / 配额 / 供应商未配置），
 * 因此必须先看 content-type；直接当流解析会得到「空回答」这种误导结果。
 */
export async function streamChat(
  request: ChatRequest,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch('/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  })

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    throw await readError(res)
  }

  if (!res.ok || res.body === null) {
    throw await readError(res)
  }

  const state: StreamResult = { gotDone: false, done: null, gotError: false, error: null }

  await consumeSse(res.body, {
    ...handlers,
    onDone: (payload) => {
      state.gotDone = true
      state.done = payload
      handlers.onDone?.(payload)
    },
    onError: (message) => {
      state.gotError = true
      state.error = message
      handlers.onError?.(message)
    },
  })

  return state
}
