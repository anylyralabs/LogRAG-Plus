/**
 * 结尾结构化结论块的拆分。
 *
 * 模型按 `prompts/output-spec.md` 在正文末尾附一段 JSON。这里把它摘出来交给
 * 专门组件渲染，避免用户在一堆花括号里找结论。
 *
 * 与后端 `src/agent/structured.ts` 的多策略提取保持**同一取向**：
 * 从后往前找、允许围栏与裸 JSON、解析失败就当没有（正文原样保留）。
 */

import type { Conclusion } from './types'

export interface SplitResult {
  /** 正文（已去掉 JSON 块） */
  body: string
  conclusion: Conclusion | null
  /** 原始 JSON 文本（复制用） */
  raw: string | null
}

/** 解析成对象且「像结论」（有根因或步骤）才采纳 */
function accept(json: string): Conclusion | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Conclusion
  if (obj.rootCause === undefined && obj.steps === undefined) return null
  return obj
}

/**
 * 找出文本里**所有**末尾结论块的起始位置（从后往前）。
 *
 * 为什么不能只拆最后一块：实测（假数据复现）模型偶尔会输出两段 JSON 块——
 * 第一段是中间态、第二段才是最终结论。只剥掉最后一段，前一段会原样留在正文里，
 * 用户看到一段裸露的 `{"rootCause":…}` 代码块，既难读也像是渲染失败。
 *
 * 因此：从末尾往前，连续剥离**所有**能解析成结论的块；遇到不能解析的立即停止
 * （不能因为中间有一块坏数据就把正文也吃掉）。
 */
function trailingConclusionStarts(text: string): Array<{ start: number; json: string }> {
  const out: Array<{ start: number; json: string }> = []
  let rest = text

  for (let guard = 0; guard < 4; guard++) {
    const block = takeTrailingFence(rest)
    if (block !== null) {
      out.push(block)
      rest = rest.slice(0, block.start).trimEnd()
      continue
    }

    const bare = takeTrailingBareJson(rest)
    if (bare !== null) {
      out.push(bare)
      rest = rest.slice(0, bare.start).trimEnd()
      continue
    }

    break
  }

  return out
}

/**
 * 剥掉末尾的围栏代码块。
 *
 * 不能用 `/```(?:json)?[\s\S]*?```\s*$/` 这类正则：正则取**最左**匹配，
 * 两段相邻的块会被一次性吞成一个（内部还含 ``` 的）无效块，于是什么都剥不掉。
 * 这里从字符串末尾倒着定位闭合围栏，再往前找最近的开启围栏。
 */
function takeTrailingFence(text: string): { start: number; json: string } | null {
  const close = text.lastIndexOf('```')
  if (close < 0) return null
  // 闭合围栏之后必须没有实质内容（允许空白）
  if (text.slice(close + 3).trim() !== '') return null

  const open = text.lastIndexOf('```', close - 1)
  if (open < 0) return null

  const inner = text.slice(open + 3, close)
  // 去掉语言标记（```json / ```JSON）与紧随的换行
  const body = inner.replace(/^[ \t]*(?:json|JSON)?[ \t]*\r?\n?/, '').trim()
  if (accept(body) === null) return null

  return { start: open, json: body }
}

/** 剥掉末尾的裸 JSON 对象（模型有时不加围栏） */
function takeTrailingBareJson(text: string): { start: number; json: string } | null {
  if (!text.endsWith('}')) return null
  const start = text.lastIndexOf('\n{')
  if (start < 0) return null

  const json = text.slice(start + 1)
  if (accept(json) === null) return null
  return { start: start + 1, json }
}

/** 从尾部找结构化结论块，且必须能解析成含预期字段的对象 */
export function splitConclusion(text: string): SplitResult {
  const trimmed = text.trimEnd()
  if (trimmed === '') return { body: '', conclusion: null, raw: null }

  // 整段就是一个 JSON（没有正文）
  if (trimmed.startsWith('{')) {
    const conclusion = accept(trimmed)
    if (conclusion !== null) return { body: '', conclusion, raw: trimmed }
  }

  const blocks = trailingConclusionStarts(trimmed)
  if (blocks.length === 0) {
    return { body: trimmed, conclusion: null, raw: null }
  }

  /*
   * blocks 从后往前。最后一段（blocks[0]）是交付用的结论，
   * 正文从**最早**那一块的起点截断——否则前面几段仍会留在正文里。
   */
  const last = blocks[0]!
  const earliest = blocks[blocks.length - 1]!
  const body = trimmed.slice(0, earliest.start).trimEnd()
  return { body, conclusion: accept(last.json), raw: last.json }
}

/**
 * 把 evidence / steps 归一成字符串数组。
 *
 * 模型偶尔会给对象形态（`{ quote, source }` / `{ action, reason }`），
 * 直接 `String(obj)` 会得到 `[object Object]`——这正是要避免的「看似有内容」。
 */
export function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const t = item.trim()
      if (t !== '') out.push(t)
      continue
    }
    if (item !== null && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const quote = typeof rec['quote'] === 'string' ? rec['quote'].trim() : ''
      const source = typeof rec['source'] === 'string' ? rec['source'].trim() : ''
      const action = typeof rec['action'] === 'string' ? rec['action'].trim() : ''
      const reason = typeof rec['reason'] === 'string' ? rec['reason'].trim() : ''

      if (quote !== '') {
        out.push(source === '' ? quote : `${quote}  ${source}`)
        continue
      }
      if (action !== '') {
        out.push(reason === '' ? action : `${action}（${reason}）`)
      }
    }
  }
  return out
}

/**
 * 置信度归一化。
 *
 * 规范是 0–1，但模型偶尔给「75」或「高」。统一成 0–1 或 null，
 * 界面据此显示「把握较大 / 一般 / 不大」而不是裸露一个数字。
 */
export function normalizeConfidence(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 0) return null
    return raw > 1.5 ? Math.min(1, raw / 100) : Math.min(1, raw)
  }
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (/^(高|high)/i.test(t)) return 0.85
    if (/^(中|medium|moderate)/i.test(t)) return 0.6
    if (/^(低|low)/i.test(t)) return 0.3
    const n = Number.parseFloat(t.replace('%', ''))
    if (Number.isFinite(n)) return n > 1.5 ? Math.min(1, n / 100) : Math.min(1, n)
  }
  return null
}

export function confidenceLabel(value: number | null): string | null {
  if (value === null) return null
  if (value >= 0.75) return '把握较大'
  if (value >= 0.5) return '把握一般'
  return '把握不大'
}
