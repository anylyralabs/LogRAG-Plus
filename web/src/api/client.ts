/**
 * 接口客户端。
 *
 * 两个必须自己写、不能用库的部分：
 *
 * 1. **SSE 增量解析**。服务端帧格式与 LogShare 一致（见 `src/server/sse.ts`）：
 *    `event: status` + `data: {...}`，正文增量则是**没有 event 行**的
 *    `data: {"choices":[{"delta":{"content":"…"}}]}`。一个块可能被 TCP 切成两半，
 *    因此必须带缓冲按 `\n\n` 切分，不能按「一次 read = 一个事件」处理。
 * 2. **非流式错误的识别**。`/v1/chat` 在开始推流前若遇到 400/404/429，
 *    返回的是普通 JSON。不先看 `content-type` 就去读流，会把 JSON 当作 SSE
 *    解析成一堆无意义的空事件——用户看到的是「转了圈然后什么都没有」。
 */

import type {
  ChatRequest,
  DonePayload,
  Health,
  LogDocsResponse,
  SessionReplay,
  StatusPayload,
  UploadRequest,
  UploadResponse,
} from './types.ts';

/** 接口基地址；默认同源（生产由反向代理把 /v1 转到 Node 服务） */
export function apiBase(): string {
  const override = localStorage.getItem('lograg.apiBase');
  return override !== null && override.trim() !== '' ? override.trim().replace(/\/$/, '') : '';
}

export function setApiBase(value: string): void {
  if (value.trim() === '') localStorage.removeItem('lograg.apiBase');
  else localStorage.setItem('lograg.apiBase', value.trim());
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let payload: unknown = null;
  let message = `请求失败（HTTP ${res.status}）`;
  try {
    payload = await res.json();
    const err = (payload as { error?: unknown }).error;
    if (typeof err === 'string' && err !== '') message = err;
  } catch {
    // 非 JSON 响应（网关 502 页面等）：保留状态码信息即可
  }
  return new ApiError(res.status, message, payload);
}

export async function getJson<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { headers });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function postJson<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export function health(): Promise<Health> {
  return getJson<Health>('/health');
}

export function replay(sessionId: string): Promise<SessionReplay> {
  return getJson<SessionReplay>(`/v1/session/${encodeURIComponent(sessionId)}`);
}

export function upload(body: UploadRequest): Promise<UploadResponse> {
  return postJson<UploadResponse>('/v1/upload', body);
}

/**
 * 取日志正文与附件（日志面板用）。
 *
 * 只读、不消耗分析配额：看一眼日志不等于分析一次。失败时抛 `ApiError`，
 * 面板据此显示原因（「日志不存在或已过期」这类文案由服务端给出）。
 */
export function logDocs(logId: string): Promise<LogDocsResponse> {
  return getJson<LogDocsResponse>(`/v1/log/${encodeURIComponent(logId)}`);
}

/** 流式回调 */
export interface StreamHandlers {
  /** 状态帧 */
  onStatus?: (payload: StatusPayload) => void;
  /** 正文增量 */
  onContent?: (delta: string) => void;
  /** 正常结束 */
  onDone?: (payload: DonePayload) => void;
  /** 服务端明确报错（`event: error`） */
  onError?: (message: string) => void;
}

/**
 * 发起对话并消费 SSE 流。
 *
 * 正常结束与异常结束都会 resolve（`onDone` / `onError` 已告知调用方），
 * 只有网络层失败与主动中止才 reject——调用方据此区分「服务端说不行」与
 * 「连不上」两种完全不同的处置方式。
 */
export async function streamChat(
  body: ChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    // 还没开始推流就失败了：此时是普通 JSON 错误
    throw await parseError(res);
  }
  if (res.body === null) throw new ApiError(0, '响应没有可读的流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  /** 处理一个完整事件块 */
  const handleBlock = (block: string): void => {
    let eventName = '';
    const dataLines: string[] = [];

    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      // 注释行（心跳）：服务端用 `:` 开头的心跳保活
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }

    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');

    try {
      if (eventName === 'done') {
        handlers.onDone?.(JSON.parse(data) as DonePayload);
        return;
      }
      if (eventName === 'error') {
        const payload = JSON.parse(data) as { error?: string };
        handlers.onError?.(payload.error ?? '分析过程中出错');
        return;
      }
      if (eventName === 'status') {
        handlers.onStatus?.(JSON.parse(data) as StatusPayload);
        return;
      }
      // 无 event 行 = 正文增量（OpenAI 兼容格式）
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta !== '') handlers.onContent?.(delta);
    } catch {
      // 单个块解析失败不应中断整条流（例如服务端将来新增了帧类型）
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件。这里对 `\n\n` 与 `\r\n\r\n` 都成立——
      // 统一在切分时按「块内可能残留 \r」处理（见 handleBlock）。
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim() !== '') handleBlock(block);
      }
    }
    // 收尾：服务端可能在最后一块后没有补空行
    if (buffer.trim() !== '') handleBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}
