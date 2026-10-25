/**
 * 日志案卷状态。
 *
 * 一份日志的展示状态分三层：
 *   - 远端文档（`/v1/log/{id}`）：正文、来源、截断信息；
 *   - 解析结果（Worker）：分节、严重度、错误行索引；
 *   - 界面状态：当前节、搜索、选行、跳转目标。
 *
 * 切换日志时用递增 token 丢弃旧请求/旧解析结果——移动端网络慢，
 * 上一次的响应晚到会覆盖当前日志，这是最难复现的一类错乱。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api } from '@/lib/api'
import { findAnchor, nextError, prevError, searchLines, sliceLines, type LogSection, type ParsedLog } from '@/lib/logdoc'
import { cancelParse, parseLogAsync } from '@/lib/logparse'
import type { LogDoc, LogDocsResponse } from '@/lib/types'

export interface QuoteRange {
  from: number
  to: number
}

export interface EvidenceHit {
  text: string
  line: number | null
}

export const useLogStore = defineStore('log', () => {
  const logId = ref('')
  const loading = ref(false)
  const error = ref('')
  const doc = ref<LogDoc | null>(null)
  const meta = ref<
    Pick<LogDocsResponse, 'source' | 'createdAt' | 'maybeObfuscating' | 'omitted' | 'appended' | 'note'> | null
  >(null)
  const parsed = ref<ParsedLog | null>(null)
  const parsePending = ref(false)

  /** 当前节（section.start）；null 表示“全部” */
  const activeSection = ref<number | null>(null)
  /** 跳转目标行（1 基）；渲染层滚动到该行并短暂高亮 */
  const focusLine = ref<number | null>(null)
  /** 选行（起止） */
  const pickStart = ref<number | null>(null)
  const pickEnd = ref<number | null>(null)
  /** 日志内搜索 */
  const searchQuery = ref('')
  const searchHits = ref<number[]>([])
  const searchIndex = ref(0)
  /** 证据锚点回跳结果 */
  const evidenceHits = ref<EvidenceHit[]>([])

  let loadToken = 0
  let parseToken = 0

  const totalLines = computed(() => parsed.value?.lines.length ?? 0)

  const sections = computed<LogSection[]>(() => parsed.value?.sections ?? [])

  const activeRange = computed<{ from: number; to: number } | null>(() => {
    const p = parsed.value
    if (p === null) return null
    if (activeSection.value === null) return { from: 1, to: p.lines.length }
    const s = p.sections.find((x) => x.start === activeSection.value)
    return s === undefined ? { from: 1, to: p.lines.length } : { from: s.start, to: s.end }
  })

  const quoteRange = computed<QuoteRange | null>(() => {
    const a = pickStart.value
    if (a === null) return null
    const b = pickEnd.value ?? a
    return { from: Math.min(a, b), to: Math.max(a, b) }
  })

  /** 加载日志并解析 */
  async function load(id: string, options: { force?: boolean } = {}): Promise<void> {
    if (id === '') return
    if (!options.force && id === logId.value && doc.value !== null) return

    const token = ++loadToken
    logId.value = id
    loading.value = true
    error.value = ''
    doc.value = null
    parsed.value = null
    meta.value = null
    activeSection.value = null
    pickStart.value = null
    pickEnd.value = null
    searchQuery.value = ''
    searchHits.value = []
    evidenceHits.value = []

    try {
      const r = await api.logDocs(id, { refresh: options.force === true })
      if (token !== loadToken) return

      // 公网路径返回合并全文（docs 长度 1）；内部路径可能多份。
      // 面板只展示第一份主文档，分节信息由正文里的 `===== 名称 =====` 还原。
      const first = r.docs[0] ?? null
      if (first === null) {
        error.value = '这份日志里没有可显示的正文。'
        return
      }

      doc.value = first
      meta.value = {
        source: r.source,
        createdAt: r.createdAt,
        maybeObfuscating: r.maybeObfuscating,
        omitted: r.omitted,
        appended: r.appended ?? 0,
        ...(r.note !== undefined ? { note: r.note } : {}),
      }

      await parse(first.content, token)
    } catch (e) {
      if (token !== loadToken) return
      error.value = e instanceof Error ? e.message : '读取日志失败'
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  /**
   * 加载本地草稿（粘贴的日志）。
   *
   * 粘贴的正文不经过服务端，因此没有 `/v1/log/{id}` 可读；但「选行引用」与
   * 「错误行跳转」同样需要，所以复用同一套解析与渲染，只是不设 logId。
   * 正文只在内存里，刷新即丢——这是刻意的（避免多一条未脱敏的落盘路径）。
   */
  async function loadLocal(name: string, content: string): Promise<void> {
    const token = ++loadToken
    logId.value = ''
    loading.value = false
    error.value = ''
    meta.value = {
      source: '本次粘贴',
      createdAt: Math.floor(Date.now() / 1000),
      maybeObfuscating: false,
      omitted: [],
      appended: 0,
    }
    pickStart.value = null
    pickEnd.value = null
    searchQuery.value = ''
    searchHits.value = []
    evidenceHits.value = []
    activeSection.value = null

    doc.value = {
      name,
      bytes: new TextEncoder().encode(content).byteLength,
      lines: content.split('\n').length,
      content,
      truncated: false,
    }

    await parse(content, token)
  }

  async function parse(content: string, token: number): Promise<void> {
    const parseId = ++parseToken
    parsePending.value = true
    const { id: workerId, promise } = parseLogAsync(content)
    try {
      const result = await promise
      if (token !== loadToken || parseId !== parseToken) {
        cancelParse(workerId)
        return
      }
      parsed.value = result
      // 打开就跳到最该看的位置：崩溃现场 > 第一处错误 > 开头
      jumpToBestSpot()
    } catch (e) {
      if (token !== loadToken) return
      error.value = e instanceof Error ? e.message : '日志解析失败'
    } finally {
      if (token === loadToken) parsePending.value = false
    }
  }

  function jumpToBestSpot(): void {
    const p = parsed.value
    if (p === null) return
    const crash = p.sections.find((s) => s.role === '崩溃现场')
    if (crash !== undefined) {
      focusLine.value = crash.start
      return
    }
    const first = p.errors[0]
    focusLine.value = first === undefined ? 1 : Math.max(1, first - 8)
  }

  function selectSection(start: number | null): void {
    activeSection.value = start
    if (start !== null) focusLine.value = start
  }

  function jump(to: number): void {
    const p = parsed.value
    if (p === null) return
    focusLine.value = Math.max(1, Math.min(p.lines.length, to))
    // 若目标在别的分节里，自动切到该节
    const section = p.sections.find((s) => to >= s.start && to <= s.end)
    if (section !== undefined) activeSection.value = section.start
  }

  function goError(dir: 1 | -1): void {
    const p = parsed.value
    if (p === null) return
    const current = focusLine.value ?? activeRange.value?.from ?? 1
    const target = dir === 1 ? nextError(p.errors, current) : prevError(p.errors, current - 1)
    if (target !== null) jump(target)
  }

  /** 选行：第一次点起点，第二次点终点，第三次重新开始 */
  function pickLine(line: number): void {
    if (pickStart.value === null || pickEnd.value !== null) {
      pickStart.value = line
      pickEnd.value = null
      return
    }
    pickEnd.value = line
  }

  function clearPick(): void {
    pickStart.value = null
    pickEnd.value = null
  }

  /** 生成引用块（行号由前端加，模型拿不到原始行号） */
  function buildQuote(): { label: string; text: string } | null {
    const p = parsed.value
    const range = quoteRange.value
    if (p === null || range === null) return null
    return {
      label: `${doc.value?.name ?? 'main.log'}:${range.from}-${range.to}`,
      text: sliceLines(p, range.from, range.to),
    }
  }

  function runSearch(): void {
    const p = parsed.value
    if (p === null) return
    searchHits.value = searchLines(p.lines, searchQuery.value)
    searchIndex.value = 0
    const first = searchHits.value[0]
    if (first !== undefined) jump(first)
  }

  function nextSearchHit(dir: 1 | -1): void {
    if (searchHits.value.length === 0) return
    const n = searchHits.value.length
    searchIndex.value = (searchIndex.value + dir + n) % n
    const line = searchHits.value[searchIndex.value]
    if (line !== undefined) jump(line)
  }

  /**
   * 证据回跳：在日志中定位每条 evidence。
   *
   * 找不到时**明确记录 null**，界面显示「未在日志中核对到」——
   * 这与后端 `score.missingAnchors` 是同一套诚实口径。
   */
  function locateEvidence(items: string[]): void {
    const p = parsed.value
    if (p === null) {
      evidenceHits.value = items.map((text) => ({ text, line: null }))
      return
    }
    evidenceHits.value = items.map((text) => ({ text, line: findAnchor(p.lines, text) }))
  }

  function focusEvidence(index: number): void {
    const hit = evidenceHits.value[index]
    if (hit === undefined || hit.line === null) return
    jump(hit.line)
  }

  function reset(): void {
    loadToken++
    parseToken++
    logId.value = ''
    doc.value = null
    parsed.value = null
    meta.value = null
    error.value = ''
    loading.value = false
    activeSection.value = null
    focusLine.value = null
    pickStart.value = null
    pickEnd.value = null
    searchQuery.value = ''
    searchHits.value = []
    evidenceHits.value = []
  }

  return {
    logId,
    loading,
    error,
    doc,
    meta,
    parsed,
    parsePending,
    activeSection,
    focusLine,
    pickStart,
    pickEnd,
    searchQuery,
    searchHits,
    searchIndex,
    evidenceHits,
    totalLines,
    sections,
    activeRange,
    quoteRange,
    load,
    loadLocal,
    reset,
    selectSection,
    jump,
    goError,
    pickLine,
    clearPick,
    buildQuote,
    runSearch,
    nextSearchHit,
    locateEvidence,
    focusEvidence,
  }
})
