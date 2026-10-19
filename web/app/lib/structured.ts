/**
 * 结尾结构化结论块的拆分。
 *
 * 模型按 output-spec 在正文末尾附一段 JSON。这里把它摘出来交给专门组件渲染，
 * 避免用户在一堆花括号里找结论。
 */

import type { Conclusion } from './types'

export interface SplitResult {
  /** 正文（已去掉 JSON 块） */
  body: string
  conclusion: Conclusion | null
  /** 原始 JSON 文本（复制用） */
  raw: string | null
}

/** 从尾部找结构化结论块，且必须能解析成含预期字段的对象 */
export function splitConclusion(text: string): SplitResult {
  const trimmed = text.trimEnd()
  if (trimmed === '') return { body: '', conclusion: null, raw: null }

  /** 候选块与其在原文中的**起始位置**（截正文必须按起点，不能按长度猜） */
  const candidates: Array<{ json: string; start: number }> = []

  // ① 围栏代码块（```json ... ```）
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i
  const fence = fenceRe.exec(trimmed)
  if (fence?.[1] !== undefined) {
    // 起点 = 整个围栏（含 ```）的起始，而不是 JSON 内容的起始
    candidates.push({ json: fence[1], start: fence.index })
  }

  // ② 裸 JSON 对象（从最后一个行首 `{` 开始）
  const bareStart = trimmed.lastIndexOf('\n{')
  if (bareStart >= 0) {
    candidates.push({ json: trimmed.slice(bareStart + 1), start: bareStart + 1 })
  }
  // 整段就是一个 JSON（没有正文）的情况
  if (trimmed.startsWith('{')) {
    candidates.push({ json: trimmed, start: 0 })
  }

  for (const { json, start } of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const obj = parsed as Conclusion
    // 至少要像结论：有根因或步骤，否则可能是正文里的普通数据
    if (obj.rootCause === undefined && obj.steps === undefined) continue

    const body = trimmed.slice(0, start).trimEnd()
    return { body, conclusion: obj, raw: json }
  }

  return { body: trimmed, conclusion: null, raw: null }
}
