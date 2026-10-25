/**
 * 日志解析 Worker。
 *
 * 5 万行日志在主线程做正则逐行分类会明显卡顿（后端实测 10MB 扫描 1.4 秒，
 * 前端还要同时维持流式渲染）。这里把「分节 + 严重度 + 错误行索引」整段搬到
 * Worker，主线程只接收结果。
 *
 * 注意：Worker 里不能 import 依赖 DOM 的模块；`logdoc.ts` 是纯函数，可复用。
 */

import { parseLog, type ParsedLog } from '../lib/logdoc'

export interface ParseRequest {
  id: number
  content: string
}

export interface ParseResponse {
  id: number
  ok: boolean
  parsed?: ParsedLog
  error?: string
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, content } = event.data
  try {
    const parsed = parseLog(content)
    const response: ParseResponse = { id, ok: true, parsed }
    self.postMessage(response)
  } catch (e) {
    const response: ParseResponse = {
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
    self.postMessage(response)
  }
}
