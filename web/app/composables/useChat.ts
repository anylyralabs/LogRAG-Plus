/**
 * 对话状态机。
 *
 * 把 SSE 帧映射成界面数据的所有逻辑收在这里，组件只读状态、只调动作。
 */

import { ApiError, emptyAssistant, replaySession, streamChat } from '../lib/api'
import type { ChatMessage, ScorePayload } from '../lib/types'
import { splitConclusion } from '../lib/structured'

const STORAGE_KEY = 'lograg.session'
const SETTINGS_KEY = 'lograg.provider'

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
}

function loadProvider(): ProviderConfig {
  if (import.meta.server) return { baseUrl: '', apiKey: '', model: '' }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw === null) return { baseUrl: '', apiKey: '', model: '' }
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    }
  } catch {
    return { baseUrl: '', apiKey: '', model: '' }
  }
}

export function useChat() {
  const messages = ref<ChatMessage[]>([])
  const sessionId = ref<string>('')
  const logId = ref<string>('')
  const busy = ref(false)
  const remaining = ref<number | null>(null)
  /** 流式过程中的阶段文案（思维链折叠时也能看到在干什么） */
  const phase = ref<string>('')
  const error = ref<string>('')

  const provider = ref<ProviderConfig>(loadProvider())

  function saveProvider(p: ProviderConfig): void {
    provider.value = p
    if (import.meta.client) localStorage.setItem(SETTINGS_KEY, JSON.stringify(p))
  }

  function rememberSession(id: string): void {
    sessionId.value = id
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, id)
  }

  function restoreSessionId(): string {
    if (!import.meta.client) return ''
    return localStorage.getItem(STORAGE_KEY) ?? ''
  }

  /** 回放历史会话（刷新后恢复对话） */
  async function replay(id: string): Promise<void> {
    try {
      const r = await replaySession(id)
      if (!r.ok) return
      rememberSession(r.sessionId)
      if (r.logId !== null) logId.value = r.logId
      messages.value = r.messages.map((m) => {
        const split = m.role === 'assistant' ? splitConclusion(m.content) : { body: m.content, conclusion: null }
        return {
          role: m.role,
          content: split.body,
          reasoning: '',
          thinkingTotal: 0,
          tools: [],
          conclusion: m.conclusion ?? split.conclusion,
          score: m.score ?? null,
          status: 'completed' as const,
          error: null,
          createdAt: m.createdAt,
        }
      })
    } catch {
      // 会话过期是常态（48h），静默忽略即可
    }
  }

  let controller: AbortController | null = null

  async function send(text: string, quoteBlock = ''): Promise<void> {
    const body = text.trim()
    const payload = quoteBlock === '' ? body : `${body}\n\n${quoteBlock}`
    if (payload.trim() === '' || busy.value) return

    error.value = ''
    busy.value = true
    phase.value = '正在读取日志…'

    messages.value.push({
      role: 'user',
      content: payload,
      reasoning: '',
      thinkingTotal: 0,
      tools: [],
      conclusion: null,
      score: null,
      status: 'completed',
      error: null,
      createdAt: Date.now(),
    })

    const assistant = reactive<ChatMessage>(emptyAssistant())
    messages.value.push(assistant)

    controller = new AbortController()

    try {
      await streamChat(
        {
          message: payload,
          ...(sessionId.value !== '' ? { sessionId: sessionId.value } : {}),
          ...(logId.value !== '' ? { logId: logId.value } : {}),
          ...(provider.value.baseUrl !== '' ? { provider: provider.value } : {}),
        },
        {
          onThinking: (d) => {
            assistant.reasoning += d
            assistant.thinkingTotal += d.length
          },
          onContent: (d) => {
            assistant.content += d
            phase.value = ''
          },
          onTool: (name) => {
            assistant.tools.push({ name, round: assistant.tools.length + 1 })
            phase.value = `正在检索：${name}`
          },
          onStatus: (m) => {
            phase.value = m
          },
          onDone: (d) => {
            rememberSession(d.sessionId)
            remaining.value = d.remaining
            assistant.status = 'completed'
            if (d.score !== undefined) assistant.score = d.score as ScorePayload
            if (d.conclusion !== undefined) assistant.conclusion = d.conclusion

            // 正文里可能仍带 JSON 块：拆出来交给专门组件，正文保持干净
            const split = splitConclusion(assistant.content)
            assistant.content = split.body
            if (assistant.conclusion === null) assistant.conclusion = split.conclusion
          },
          onError: (m) => {
            assistant.status = 'error'
            assistant.error = m
          },
        },
        controller.signal,
      )

      if (assistant.status === 'streaming') assistant.status = 'completed'
      if (assistant.content.trim() === '' && assistant.error === null) {
        assistant.status = 'error'
        assistant.error = '本次没有产出结论，请重试。'
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        assistant.status = 'aborted'
      } else {
        assistant.status = 'error'
        assistant.error = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      }
    } finally {
      busy.value = false
      phase.value = ''
      controller = null
    }
  }

  function abort(): void {
    controller?.abort()
  }

  function reset(): void {
    messages.value = []
    sessionId.value = ''
    logId.value = ''
    remaining.value = null
    error.value = ''
    if (import.meta.client) localStorage.removeItem(STORAGE_KEY)
  }

  return {
    messages,
    sessionId,
    logId,
    busy,
    remaining,
    phase,
    error,
    provider,
    saveProvider,
    send,
    abort,
    reset,
    replay,
    restoreSessionId,
    rememberSession,
  }
}
