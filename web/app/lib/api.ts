/**
 * 后端客户端。SSE 解析在这里收口，组件只面对回调。
 *
 * SSE 用 `ReadableStream` 手工解析而不是 `EventSource`：EventSource 只能 GET，
 * 而对话是 POST 带 JSON body 的。
 */

import type {
  ChatMessage,
  Conclusion,
  HealthResponse,
  LogDocsResponse,
  ScorePayload,
  SessionReplay,
  UploadResponse,
} from './types'

/** 请求失败（带 HTTP 状态与后端文案） */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface StreamHandlers {
  onThinking?: (delta: string) => void
  onContent?: (delta: string) => void
  onTool?: (name: string, args: unknown) => void
  onStatus?: (message: string) => void
  onDone?: (payload: {
    status: string
    sessionId: string
    remaining: number
    score?: ScorePayload
    conclusion?: Conclusion
  }) => void
  onError?: (message: string) => void
}

export interface ChatRequest {
  message: string
  sessionId?: string
  logId?: string
  provider?: { baseUrl: string; apiKey: string; model: string }
  fingerprint?: string
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const msg =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : text.slice(0, 200) || `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status, msg)
  }
  return parsed as T
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const msg =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status, msg)
  }
  return parsed as T
}

export function health(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/health')
}

export function logDocs(logId: string): Promise<LogDocsResponse> {
  return getJson<LogDocsResponse>(`/v1/log/${encodeURIComponent(logId)}`)
}

export function replaySession(sessionId: string): Promise<SessionReplay> {
  return getJson<SessionReplay>(`/v1/session/${encodeURIComponent(sessionId)}`)
}

export function upload(body: {
  content?: string
  files?: Array<{ name: string; data: string }>
  source?: string
}): Promise<UploadResponse> {
  return postJson<UploadResponse>('/v1/upload', body)
}

/**
 * 发一轮对话（SSE 流式）。
 *
 * 解析要点：
 * - 按 `\n\n` 切帧，但**必须保留跨块的残余**（一个帧常被切成多块）；
 * - `data:` 可能是多行，按规范以换行拼接；
 * - 心跳注释行（`:` 开头）直接忽略；
 * - 用 `TextDecoder` 的 `stream: true`，否则多字节汉字被切在块边界会产生乱码。
 */
export async function streamChat(
  req: ChatRequest,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(req),
    signal,
  })

  if (!res.ok) {
    const text = await res.text()
    let msg = `请求失败（HTTP ${res.status}）`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (typeof parsed.error === 'string') msg = parsed.error
    } catch {
      if (text !== '') msg = text.slice(0, 300)
    }
    // 429 带剩余额度，界面要能区分「额度用尽」与「服务出错」
    throw new ApiError(res.status, msg)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    // 推流前失败会返回 JSON（如供应商未配置）
    const text = await res.text()
    let msg = '服务返回了非流式响应'
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (typeof parsed.error === 'string') msg = parsed.error
    } catch {
      if (text !== '') msg = text.slice(0, 300)
    }
    throw new ApiError(res.status, msg)
  }

  const reader = res.body?.getReader()
  if (reader === undefined) throw new ApiError(500, '响应没有可读流')

  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx = buffer.indexOf('\n\n')
    while (idx >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      handleFrame(frame, handlers)
      idx = buffer.indexOf('\n\n')
    }
  }

  // 末尾可能没有空行分隔
  if (buffer.trim() !== '') handleFrame(buffer, handlers)
}

function handleFrame(raw: string, handlers: StreamHandlers): void {
  let event = ''
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return
  const data = dataLines.join('\n')

  if (event === 'error') {
    handlers.onError?.(data)
    return
  }
  if (event === 'done') {
    try {
      handlers.onDone?.(JSON.parse(data))
    } catch {
      /* 损坏的 done 帧不应让整个流崩掉 */
    }
    return
  }

  // status 帧承载 thinking / tool / 状态文案
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(data) as Record<string, unknown>
  } catch {
    return
  }

  switch (payload['type']) {
    case 'thinking': {
      const delta = payload['delta']
      if (typeof delta === 'string' && delta !== '') handlers.onThinking?.(delta)
      break
    }
    case 'content': {
      const delta = payload['delta']
      if (typeof delta === 'string' && delta !== '') handlers.onContent?.(delta)
      break
    }
    case 'tool': {
      const name = payload['name']
      if (typeof name === 'string') handlers.onTool?.(name, payload['arguments'])
      break
    }
    case 'tool_result':
      // 结果摘要由 done 帧统一回填，这里不重复上报
      break
    default: {
      const message = payload['message']
      if (typeof message === 'string' && message !== '') handlers.onStatus?.(message)
    }
  }
}

export function emptyAssistant(): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    reasoning: '',
    thinkingTotal: 0,
    tools: [],
    conclusion: null,
    score: null,
    status: 'streaming',
    error: null,
    createdAt: Date.now(),
  }
}
