/**
 * 对话状态机。
 *
 * 把 SSE 帧映射成界面数据的所有逻辑收在这里，组件只读状态、只调动作。
 *
 * ## 几条与后端语义严格对齐的规则
 *
 * 1. **`done` 不等于成功**：还要看正文是否为空。后端对空正文有硬性约定
 *    （「空正文一律视为失败」），界面不能渲染成一张成功的结论卡。
 * 2. **`error` 之后保留已有正文**：用户已经看到的部分是资产，标「未完成」即可。
 * 3. **停止是用户的正常动作**，不是错误：`AbortController` 触发后标「已停止」。
 * 4. **会话 ID 必须保存**：下一轮靠它延续；刷新后靠它回放。
 */

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

import { ApiError, streamChat } from '@/lib/api'
import { fingerprint, listHistory, rememberSession, titleFromMessage, touchSession } from '@/lib/history'
import { createSmoother, type Smoother } from '@/lib/smoother'
import { splitConclusion } from '@/lib/structured'
import { useHistoryStore } from '@/stores/history'
import type {
  ChatMessage,
  Conclusion,
  DonePayload,
  ProviderConfig,
  ScorePayload,
  SessionReplay,
  StatusPayload,
  ToolCallItem,
} from '@/lib/types'

const STORAGE_KEY = 'lograg.session'

/** 内存中的日志草稿（粘贴分析用；绝不落盘） */
export interface PendingLog {
  content: string
  name: string
}

function emptyAssistant(): ChatMessage {
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
    notices: [],
    asks: [],
    createdAt: Date.now(),
  }
}

/** 从工具参数里取一个可读的摘要（界面显示，不参与分析） */
export function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args.slice(0, 120)
  if (typeof args !== 'object') return String(args)
  const rec = args as Record<string, unknown>
  const preferred = ['query', 'line_start', 'line_end', 'topic', 'q', 'repo', 'path']
  for (const key of preferred) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 120)
    if (typeof v === 'number') return `${key}: ${v}`
  }
  try {
    return JSON.stringify(args).slice(0, 120)
  } catch {
    return ''
  }
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const sessionId = ref('')
  const logId = ref('')
  const busy = ref(false)
  const remaining = ref<number | null>(null)
  const roundsRemaining = ref<number | null>(null)
  /** 流式过程中的阶段文案（思维链折叠时也能看到在干什么） */
  const phase = ref('')
  const error = ref('')
  /** 粘贴/上传后的日志正文：只在内存里，随下一次请求发送 */
  const pendingLog = ref<PendingLog | null>(null)
  /**
   * 本轮是否以「向你提问」结束。
   *
   * 后端在 `ask_user` 之后不再继续检索，直接收尾；前端据此把流式状态
   * 显示成「等你补充」而不是继续转圈，并在结束后保持追问面板可见。
   */
  const awaitingAnswer = ref(false)

  const hasLog = computed(() => logId.value !== '' || pendingLog.value !== null)

  let controller: AbortController | null = null

  function rememberSessionId(id: string): void {
    sessionId.value = id
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }

  function restoreSessionId(): string {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  }

  function reset(): void {
    controller?.abort()
    controller = null
    messages.value = []
    sessionId.value = ''
    error.value = ''
    phase.value = ''
    busy.value = false
    pendingLog.value = null
    awaitingAnswer.value = false
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  function setPendingLog(log: PendingLog): void {
    pendingLog.value = { ...log }
  }

  function clearPendingLog(): void {
    pendingLog.value = null
  }

  /** 切到某个日志：清空当前线程，绑定新日志 */
  function bindLog(id: string): void {
    if (logId.value === id) return
    reset()
    logId.value = id
  }

  /**
   * 绑定日志但不重置对话。
   *
   * 用于「往纯对话里追加材料」：追加成功后正文归属会话本身，案卷面板
   * 需要出现，但刚发生的对话不能丢。
   */
  function attachLog(id: string): void {
    logId.value = id
  }

  function unbindLog(): void {
    reset()
    logId.value = ''
  }

  /**
   * 回放「某份日志最近的会话」。
   *
   * 后端没有「按 logId 列会话」的接口，但会话 ID 由本地历史提供。
   * 若本地没有记录，就不回放——服务端 `findOrCreateSession` 会在首次发言时
   * 复用该日志未过期的会话，行为仍然正确。
   */
  async function replayByLog(id: string): Promise<boolean> {
    const candidates = listHistory()
      .filter((e) => e.logId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const entry of candidates) {
      const ok = await replay(entry.sessionId, (sid) => apiReplay(sid))
      if (ok) return true
    }
    return false
  }

  /**
   * 回放历史会话。
   *
   * 404（过期）是常态——48 小时或日志 TTL 到期。静默忽略，不弹错误。
   */
  async function replay(id: string, loader: (sessionId: string) => Promise<SessionReplay>): Promise<boolean> {
    try {
      const r = await loader(id)
      rememberSessionId(r.session.id)
      // native 会话的正文归属就是会话 ID（`logId` 为 null）；
      // 纯对话会话 hasLog=false，不能把它当日志去读——否则每次打开都 404。
      logId.value = r.session.logId ?? (r.session.hasLog ? r.session.id : '')
      roundsRemaining.value = r.rounds.remaining

      messages.value = r.messages.map((m) => {
        if (m.role === 'user') {
          return {
            role: 'user' as const,
            content: m.content,
            reasoning: '',
            thinkingTotal: 0,
            tools: [],
            conclusion: null,
            score: null,
            status: 'completed' as const,
            error: null,
            notices: [],
            asks: [],
            createdAt: m.createdAt,
          }
        }

        // 历史回答里仍然带着结尾 JSON 块：拆出来交给专门组件
        const split = splitConclusion(m.content)
        return {
          role: 'assistant' as const,
          content: split.body,
          reasoning: m.reasoning ?? '',
          thinkingTotal: (m.reasoning ?? '').length,
          tools: [],
          conclusion: split.conclusion,
          score: (m.score as ScorePayload | undefined) ?? null,
          status: split.body.trim() === '' && split.conclusion === null ? ('empty' as const) : ('completed' as const),
          error: null,
          notices: [],
          // 追问随消息落库：刷新后仍能作答
          asks: m.meta?.asks ?? [],
          createdAt: m.createdAt,
        }
      })

      // 空会话不写历史：上传后的会话在首条提问前没有标题，
      // 写进去只会得到一条「历史会话」的噪声。
      if (messages.value.length > 0) {
        rememberSession({
          sessionId: r.session.id,
          logId: r.session.logId,
          title: titleFromMessage(messages.value[0]?.content ?? '') || '历史会话',
          updatedAt: Date.now(),
          expiresAt: r.session.expiresAt,
        })
        useHistoryStore().refresh()
      }
      return true
    } catch (e) {
      // 会话过期：清掉本地指针，让用户回到入口
      if (e instanceof ApiError && e.status === 404) {
        try {
          localStorage.removeItem(STORAGE_KEY)
        } catch {
          /* ignore */
        }
      }
      return false
    }
  }

  /**
   * 发一轮分析。
   *
   * @param text 用户输入
   * @param options.quote 引用的日志片段（已含 `引用日志 …：` 与围栏）
   * @param options.logContent 直接正文（粘贴分析；不传则用 logId 让服务端取）
   */
  async function send(
    text: string,
    options: {
      provider?: ProviderConfig
      quote?: string
      logContent?: string
    } = {},
  ): Promise<void> {
    const body = text.trim()
    const payload = options.quote === undefined || options.quote === '' ? body : `${body}\n\n${options.quote}`
    if (payload.trim() === '' || busy.value) return

    // 粘贴/上传后带进来的正文：每一轮都要重新带上——服务端只把 `body.message`
    // 写进历史，不带正文时后续轮次就失去了日志工具。正文只在本页内存里。
    const effectiveLogContent = options.logContent ?? pendingLog.value?.content

    error.value = ''
    busy.value = true
    awaitingAnswer.value = false
    phase.value = effectiveLogContent === undefined && logId.value === '' ? '正在准备…' : '正在读取日志…'

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
      notices: [],
      asks: [],
      createdAt: Date.now(),
    })

    const assistant = reactive<ChatMessage>(emptyAssistant())
    messages.value.push(assistant)

    const ac = new AbortController()
    controller = ac

    /** 工具调用按「宣告顺序」配对：同名工具并发时只靠名字会错配 */
    const toolQueue: ToolCallItem[] = []

    /*
     * 平滑输出。
     *
     * SSE 的到达是突发的：代理会把几十个 token 攒成一包，网络抖动又会一次
     * 送来几百字。直接追加到响应式字符串上，Vue 每来一包就重渲染整段 Markdown，
     * 长回答时主线程被打满——观感就是「一顿一顿，还卡」。
     *
     * 现在收到的文本先入队，由 rAF 按帧放出（积压越多放得越快），
     * 流结束时 drain 一次放完。见 `lib/smoother.ts`。
     */
    const contentSmoother = createSmoother({
      onFlush: (text) => {
        assistant.content += text
      },
    })
    const reasoningSmoother = createSmoother({
      minPerFrame: 4,
      maxPerFrame: 60,
      onFlush: (text) => {
        assistant.reasoning += text
        assistant.thinkingTotal += text.length
      },
    })

    try {
      const result = await streamChat(
        {
          message: payload,
          ...(sessionId.value !== '' ? { sessionId: sessionId.value } : {}),
          ...(logId.value !== '' ? { logId: logId.value } : {}),
          ...(effectiveLogContent !== undefined ? { logContent: effectiveLogContent } : {}),
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          fingerprint: fingerprint(),
        },
        {
          onThinking: (delta) => {
            reasoningSmoother.push(delta)
            if (assistant.content === '' && phase.value !== '正在推导结论…') {
              phase.value = '正在推理…'
            }
          },
          onContent: (delta) => {
            contentSmoother.push(delta)
            if (phase.value !== '') phase.value = ''
          },
          onStatus: (status: StatusPayload) => handleStatus(status, assistant, toolQueue),
          onDone: (done: DonePayload) => {
            rememberSessionId(done.sessionId)
            remaining.value = done.remaining
            if (done.score !== undefined) assistant.score = done.score
            // done 里的 asks 是兜底：status 帧若因代理缓冲被合并/丢弃，
            // 追问仍能出现在界面上。
            if (done.asks !== undefined && assistant.asks.length === 0) {
              assistant.asks = done.asks
            }
          },
          onError: (message) => {
            assistant.status = 'error'
            assistant.error = message
          },
        },
        ac.signal,
      )

      /*
       * 把平滑器里剩余的文本放完，再收敛终态。
       *
       * 顺序很重要：若先 finalize 再 drain，结论 JSON 块会在 drain 之后才
       * 进入正文，于是「正文里残留一段 JSON」——正是我们要消除的观感缺陷。
       */
      await flushSmoothers(contentSmoother, reasoningSmoother)

      // done 之后的终态判定：done 不等于有结论
      if (!result.gotError && assistant.status === 'streaming') {
        assistant.status = 'completed'
      }
      finalizeAssistant(assistant)

      if (result.gotDone) {
        rememberSession({
          sessionId: sessionId.value,
          logId: logId.value === '' ? null : logId.value,
          title: titleFromMessage(payload) || '未命名会话',
          updatedAt: Date.now(),
          // 后端未在 done 帧下发 expiresAt；native 会话（s 开头，正文归属自身）
          // 按 48h 估，LogShare 导入的日志跟随 7 天。读取时后端仍是权威。
          expiresAt:
            Math.floor(Date.now() / 1000) +
            (logId.value === '' || logId.value.startsWith('s') ? 48 * 3600 : 7 * 86400),
        })
      } else if (sessionId.value !== '') {
        touchSession(sessionId.value)
      }
      useHistoryStore().refresh()
    } catch (e) {
      // 出错或用户中止：把已经排队的文本放完，不要丢掉用户已经看到的部分
      await flushSmoothers(contentSmoother, reasoningSmoother)

      if (e instanceof DOMException && e.name === 'AbortError') {
        assistant.status = 'aborted'
        assistant.error = null
        finalizeAssistant(assistant)
      } else {
        assistant.status = 'error'
        assistant.error =
          e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
        error.value = assistant.error
        finalizeAssistant(assistant)
      }
    } finally {
      contentSmoother.stop()
      reasoningSmoother.stop()
      busy.value = false
      phase.value = ''
      controller = null
    }
  }

  function handleStatus(
    status: StatusPayload,
    assistant: ChatMessage,
    toolQueue: ToolCallItem[],
  ): void {
    switch (status.type) {
      case 'thinking': {
        // thinking 帧由 onThinking 处理；这里只更新阶段提示
        if (assistant.content === '') phase.value = '正在推理…'
        break
      }
      case 'tool': {
        const item: ToolCallItem = {
          index: assistant.tools.length + 1,
          name: status.name,
          args: status.arguments,
          done: false,
          failed: false,
        }
        assistant.tools.push(item)
        toolQueue.push(item)
        phase.value = `正在检索：${status.name}`
        break
      }
      case 'tool_result': {
        // 按同名 FIFO 配对；找不到（未宣告）就补一条，保证「有结果必有调用」
        const idx = toolQueue.findIndex((t) => t.name === status.name && !t.done)
        const target =
          idx >= 0 ? toolQueue[idx] : (() => {
            const item: ToolCallItem = {
              index: assistant.tools.length + 1,
              name: status.name,
              done: false,
              failed: false,
            }
            assistant.tools.push(item)
            toolQueue.push(item)
            return item
          })()

        if (target !== undefined) {
          target.summary = status.summary
          target.truncated = status.truncated === true
          target.done = true
          target.failed = looksFailed(status.summary)
        }
        phase.value = ''
        break
      }
      case 'limit':
        assistant.notices.push({
          kind: 'limit',
          text: `工具调用已达 ${status.rounds} 次上限，正在基于已有信息收尾。`,
        })
        break
      case 'reflection':
        assistant.notices.push({ kind: 'reflection', text: status.message })
        phase.value = status.message
        break
      case 'queued':
        assistant.notices.push({ kind: 'queued', text: status.message })
        phase.value = status.message
        break
      case 'ask': {
        // 同一问题可能被模型重复提出（工具层有去重，但不保证跨轮），这里再收敛一次
        const existing = assistant.asks.flatMap((a) => a.questions)
        const fresh = status.questions.filter((q) => !existing.includes(q))
        if (fresh.length > 0) {
          assistant.asks.push({
            questions: fresh,
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
          })
        }
        // 后端在 ask_user 之后会**停止自检**、直接收尾（见 runner.ts 的 awaitingUser）。
        // 因此这里不再显示「正在检索」，而是明确进入「等你回答」——
        // 否则界面会一直转圈，用户以为它还在查。
        phase.value = '已向你提问，等你补充'
        awaitingAnswer.value = true
        break
      }
    }
  }

  /** 收尾：拆分结论 JSON、判定空正文 */
  function finalizeAssistant(assistant: ChatMessage): void {
    const split = splitConclusion(assistant.content)
    assistant.content = split.body
    if (assistant.conclusion === null) assistant.conclusion = split.conclusion

    // 以提问结束的轮次不算「无结论」：它交付的是问题，不是答案。
    // 后端会用问题清单兜底成正文，所以这里通常也非空；这条是双保险。
    const endedWithAsk = assistant.asks.length > 0

    // 正文为空且没有结论 → 这是「伪装成功」的形态，必须显式标出
    if (
      !endedWithAsk &&
      (assistant.status === 'completed' || assistant.status === 'streaming') &&
      assistant.content.trim() === '' &&
      assistant.conclusion === null
    ) {
      assistant.status = 'empty'
      assistant.error = '本次没有产出结论。可以缩短问题、补充崩溃行，或重新分析。'
    }
  }

  function abort(): void {
    controller?.abort()
  }

  /** 重试最后一条失败的回答（把它之前的用户消息再发一次） */
  async function retryLast(provider?: ProviderConfig): Promise<void> {
    if (busy.value) return
    let lastUser = ''
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m !== undefined && m.role === 'user') {
        lastUser = m.content
        break
      }
    }
    if (lastUser === '') return

    // 去掉失败的助手消息与对应的用户消息，避免线程里出现重复的一问一答
    while (messages.value.length > 0) {
      const last = messages.value[messages.value.length - 1]
      if (last === undefined) break
      messages.value.pop()
      if (last.role === 'user') break
    }

    await send(lastUser, provider === undefined ? {} : { provider })
  }

  return {
    messages,
    sessionId,
    logId,
    busy,
    awaitingAnswer,
    remaining,
    roundsRemaining,
    phase,
    error,
    hasLog,
    pendingLog,
    send,
    abort,
    reset,
    bindLog,
    attachLog,
    unbindLog,
    replay,
    replayByLog,
    restoreSessionId,
    retryLast,
    setPendingLog,
    clearPendingLog,
  }
})

/** 工具结果是否算失败（与后端记录口径保持一致的粗判） */
function looksFailed(summary: string | undefined): boolean {
  if (summary === undefined) return false
  return /^工具调用失败|^检索失败/.test(summary.trim())
}

/**
 * 等平滑器把队列放完，再做最终解析。
 *
 * 超时兜底 2 秒：后台标签页的 rAF 会被浏览器节流到 1fps，
 * 没有兜底会让整轮分析挂在那里（用户看到「分析中」永不结束）。
 */
function flushSmoothers(...smoothers: Smoother[]): Promise<void> {
  return Promise.all(
    smoothers.map((smoother) => {
      smoother.drain()
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
      return Promise.race([smoother.drained(), timeout])
    }),
  ).then(() => undefined)
}

/** 仅供 store 内部回放使用（避免循环依赖，动态取 api） */
async function apiReplay(sessionId: string) {
  const { api } = await import('@/lib/api')
  return api.replaySession(sessionId)
}

export type { Conclusion }
