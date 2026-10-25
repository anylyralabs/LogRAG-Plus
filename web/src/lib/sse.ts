/**
 * SSE 解析。
 *
 * ## 为什么单独成模块
 * `API.md` 列的五个客户端坑（跨块残余、流式解码、多行 data、不能用
 * EventSource、先检查 content-type）每一个都会以**看起来像后端故障**的方式失败。
 * 把它们收进一个纯函数模块，才能用构造出来的字节流做回归测试。
 *
 * 这里不依赖 DOM 的 EventSource：对话是 `POST` 带 JSON body，EventSource 只能 GET。
 */

import type { DonePayload, StatusPayload } from './types'

export interface SseHandlers {
  /** 思维链增量（status 帧里 type=thinking 的便捷回调） */
  onThinking?: (delta: string) => void
  /** status 帧：thinking / tool / tool_result / limit / reflection / queued */
  onStatus?: (payload: StatusPayload) => void
  /** 正文增量 */
  onContent?: (delta: string) => void
  /** done 帧（可能带 score / remaining） */
  onDone?: (payload: DonePayload) => void
  /** error 帧。之后流即结束，不会再有 done */
  onError?: (message: string) => void
  /**
   * 无法归类的帧。
   *
   * 不静默丢弃：协议演进时旧客户端至少能在开发面板里看到「有东西没被处理」，
   * 而不是表现为「模型没说话」。
   */
  onUnknown?: (frame: { event: string; data: string }) => void
}

/** 一个已切分但尚未解释的 SSE 帧 */
export interface RawFrame {
  event: string
  data: string
}

/**
 * 从累积缓冲中切出完整帧。
 *
 * SSE 以空行分隔帧；行尾可能是 `\n` 或 `\r\n`（规范两者都接受）。
 * 返回完整帧与**必须保留的残余**——残余是跨块帧的尾部，丢掉它就会丢字。
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let rest = buffer

  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest)
    if (match === null) break
    frames.push(rest.slice(0, match.index))
    rest = rest.slice(match.index + match[0].length)
  }

  return { frames, rest }
}

/**
 * 解析单个帧。
 *
 * 规范要点：
 *  - 以 `:` 开头的行是注释（心跳），忽略；
 *  - `data:` 可以出现多次，按出现顺序以 `\n` 拼接；
 *  - `event:` 缺省表示 message（本服务用它承载正文增量）。
 */
export function parseFrame(raw: string): RawFrame {
  let event = ''
  const data: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      // 去掉冒号后的**一个**可选空格；其余空格属于数据
      data.push(line.slice(5).replace(/^ /, ''))
      continue
    }
    // `id:` / `retry:` 本服务不用；未知字段按规范忽略
  }

  return { event, data: data.join('\n') }
}

/** 把一帧交给业务回调。JSON 损坏时走 onUnknown，不让整个流崩掉。 */
export function dispatchFrame(frame: RawFrame, handlers: SseHandlers): void {
  if (frame.data === '' && frame.event === '') return

  if (frame.event === 'error') {
    handlers.onError?.(extractError(frame.data))
    return
  }

  if (frame.event === 'done') {
    try {
      const parsed = JSON.parse(frame.data) as DonePayload
      if (typeof parsed.sessionId !== 'string') {
        handlers.onUnknown?.(frame)
        return
      }
      handlers.onDone?.(parsed)
    } catch {
      handlers.onUnknown?.(frame)
    }
    return
  }

  if (frame.event === 'status') {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      handlers.onUnknown?.(frame)
      return
    }
    if (parsed === null || typeof parsed !== 'object') {
      handlers.onUnknown?.(frame)
      return
    }
    const payload = parsed as StatusPayload & { type?: unknown }
    if (typeof payload.type !== 'string') {
      handlers.onUnknown?.(frame)
      return
    }
    if (payload.type === 'thinking') {
      const delta = (payload as { delta?: unknown }).delta
      if (typeof delta === 'string' && delta !== '') handlers.onThinking?.(delta)
    }
    handlers.onStatus?.(payload)
    return
  }

  if (frame.event === '') {
    // 正文帧：OpenAI 兼容形状 `{"choices":[{"delta":{"content":"…"}}]}`
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      handlers.onUnknown?.(frame)
      return
    }
    const delta = readContentDelta(parsed)
    if (delta !== null) {
      if (delta !== '') handlers.onContent?.(delta)
      return
    }
    handlers.onUnknown?.(frame)
    return
  }

  handlers.onUnknown?.(frame)
}

/** 从 OpenAI 兼容的正文帧里取增量 */
export function readContentDelta(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return null
  const first = choices[0]
  if (first === null || typeof first !== 'object') return null
  const delta = (first as { delta?: unknown }).delta
  if (delta === null || typeof delta !== 'object') return null
  const content = (delta as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

/** error 帧的 data 可能是 `{"error":"…"}`，也可能直接是文本 */
function extractError(data: string): string {
  try {
    const parsed = JSON.parse(data) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim() !== '') return parsed.error
  } catch {
    /* 落到原样文本 */
  }
  return data.trim() === '' ? '分析失败' : data
}

/**
 * 消费一个 SSE 字节流。
 *
 * 关键实现点（每一条都对应一个会静默出错的写法）：
 *  - `TextDecoder(..., { stream: true })`：汉字被切在块边界时不会出现乱码方块；
 *  - 残余必须保留：一个帧经常被 TCP 切成两块；
 *  - 结束时再冲刷一次 decoder，并处理末尾没有空行的最后一帧。
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const flush = (text: string): void => {
    buffer += text
    const { frames, rest } = splitFrames(buffer)
    buffer = rest
    for (const frame of frames) dispatchFrame(parseFrame(frame), handlers)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    flush(decoder.decode(value, { stream: true }))
  }

  flush(decoder.decode())
  if (buffer.trim() !== '') {
    dispatchFrame(parseFrame(buffer), handlers)
  }
}
