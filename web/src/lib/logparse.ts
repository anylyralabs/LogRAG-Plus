/**
 * 日志解析的 Worker 封装。
 *
 * 只在浏览器里创建 Worker；SSR/测试环境退回同步解析（逻辑同一份）。
 * 每次解析分配递增 id，只有最新一次的结果会被采纳——切换日志时旧结果
 * 晚到会把新日志覆盖掉，这个竞态在移动端尤其常见。
 */

import { parseLog, type ParsedLog } from './logdoc'
import type { ParseRequest, ParseResponse } from '../workers/log.worker'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (p: ParsedLog) => void; reject: (e: Error) => void }>()

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (worker !== null) return worker

  try {
    worker = new Worker(new URL('../workers/log.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const { id, ok, parsed, error } = event.data
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      if (ok && parsed !== undefined) entry.resolve(parsed)
      else entry.reject(new Error(error ?? '日志解析失败'))
    }
    worker.onerror = (event) => {
      // Worker 起不来（CSP / 浏览器限制）时退回主线程
      console.warn('[log] Worker 异常，改用主线程解析:', event.message)
      worker = null
      for (const [, entry] of pending) entry.reject(new Error('Worker 不可用'))
      pending.clear()
    }
    return worker
  } catch {
    worker = null
    return null
  }
}

/** 解析日志（异步；有 Worker 时在 Worker 中执行） */
export function parseLogAsync(content: string): { id: number; promise: Promise<ParsedLog> } {
  const id = nextId++
  const w = ensureWorker()

  if (w === null) {
    // 同步解析包成 Promise，保持调用方行为一致
    return { id, promise: Promise.resolve().then(() => parseLog(content)) }
  }

  const promise = new Promise<ParsedLog>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const request: ParseRequest = { id, content }
    w.postMessage(request)
  })

  return { id, promise }
}

/** 丢弃已过期的解析请求（切换日志时调用） */
export function cancelParse(id: number): void {
  pending.delete(id)
}
