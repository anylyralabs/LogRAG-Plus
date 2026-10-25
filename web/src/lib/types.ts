/**
 * 与后端 `/v1/*` 的类型契约。
 *
 * 字段名必须与 `src/server/index.ts` 的实际输出一致——`API.md` 与
 * `tests/api-contract.test.ts` 是这份类型的依据。尤其注意几个**曾经漂移过**的点：
 *
 *  - 会话回放是 `session.id`，不是顶层 `sessionId`；
 *  - 上传响应是 `logId`，不是 `id`；
 *  - 领域知识新增字段是 `content`，不是 `text`。
 */

/** `GET /health` */
export interface HealthResponse {
  ok: boolean
  service: string
  version: string
  /** 索引不可用时后端返回 `{ available: false }` */
  rag: { chunks?: number; files?: number; available?: boolean }
  config: Record<string, unknown>
}

/** 自评四维。`grounding` 在「没有可核实语料」时为 null。 */
export interface ScoreDimensions {
  grounding: number | null
  verification: number
  actionability: number
  economy: number
}

/** `done` 帧与 `messages[].score` 的共同形状（后者无 recordId） */
export interface ScorePayload {
  overall: number
  deliverable: boolean
  dimensions: ScoreDimensions
  deductions: string[]
  missingAnchors: string[]
  recordId?: string
}

/** 结尾结构化结论块（模型按 `prompts/output-spec.md` 输出） */
export interface Conclusion {
  rootCause?: string
  confidence?: number | string | null
  steps?: Array<string | { action?: string; reason?: string }>
  evidence?: Array<string | { quote?: string; source?: string }>
  [key: string]: unknown
}

/** 一次工具调用（界面附录用） */
export interface ToolCallItem {
  /** 在整轮分析里的序号（1 基） */
  index: number
  name: string
  args?: unknown
  /** 工具返回摘要（服务端已截断） */
  summary?: string
  truncated?: boolean
  /** 是否到达结果帧 */
  done: boolean
  /** 已判定失败 */
  failed: boolean
}

/** 流内提示：轮次上限、中止原因、排队 */
export interface StreamNotice {
  kind: 'limit' | 'reflection' | 'queued'
  text: string
}

/**
 * 模型向用户提出的问题（`ask_user`）。
 *
 * 单独建模而不是塞进正文：追问需要**可作答**，正文里的问句无法稳定解析。
 */
export interface AskPayload {
  questions: string[]
  reason?: string
}

export type MessageStatus = 'streaming' | 'completed' | 'error' | 'aborted' | 'empty'

/** 对话中的一条消息 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  /** 思维链累计字数（折叠时显示体量，让「查了多少」可见） */
  thinkingTotal: number
  tools: ToolCallItem[]
  conclusion: Conclusion | null
  score: ScorePayload | null
  status: MessageStatus
  error: string | null
  /** 流内提示（轮次上限 / 重复检索 / 排队） */
  notices: StreamNotice[]
  /** 本轮模型提出的追问（刷新后可恢复） */
  asks: AskPayload[]
  createdAt: number
}

/** `GET /v1/log/{id}` 的一份文档 */
export interface LogDoc {
  name: string
  bytes: number
  lines: number
  content: string
  truncated: boolean
}

export interface LogDocsResponse {
  ok: boolean
  logId: string
  source: string
  createdAt: number
  /** 兼容字段：正文已改为同步读取，恒为 false */
  maybeObfuscating: boolean
  docs: LogDoc[]
  omitted: string[]
  /** 追加段数量（主日志为 0） */
  appended?: number
  /** 面向用户的提示，如「原日志已过期，只能分析追加部分」 */
  note?: string
}

/** `POST /v1/upload` */
export interface UploadResponse {
  ok: boolean
  /** 新会话 ID（`s` 开头）。native 上传的正文归属就是会话本身 */
  logId: string
  /** 正文是否被反混淆改写过 */
  deobfuscated?: boolean
  /** 反混淆失败原因（fail-open，已存原文） */
  deobfuscateError?: string
  token?: string
  notes?: string[]
  remaining: number
  error?: string
}

/** `POST /v1/session/{sessionId}/append` */
export interface AppendResponse {
  ok: boolean
  sessionId: string
  /** 本段序号（主日志是 0，追加从 1 开始） */
  seq: number
  /** 追加后的总段数 */
  total: number
  deobfuscated: boolean
  deobfuscateError?: string
  remaining: number
}

/** `GET /v1/session/{id}` */
export interface SessionReplay {
  ok: boolean
  session: {
    id: string
    logId: string | null
    /**
     * 会话是否有可读正文。
     *
     * native 上传的会话 `logId` 为 null（正文归属就是会话 ID），
     * 纯对话会话也是 null——只能靠这个字段区分，不能只看 `logId`。
     */
    hasLog: boolean
    createdAt: number
    expiresAt: number
  }
  rounds: { allowed: boolean; remaining: number }
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    reasoning?: string
    score?: ScorePayload
    /** 结构化附加信息（目前承载 ask_user 的追问） */
    meta?: { asks?: AskPayload[] }
    createdAt: number
  }>
}

/** 自定义供应商。API Key 只存浏览器（默认 localStorage），随请求带上 */
export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ChatRequest {
  message: string
  logId?: string
  sessionId?: string
  fingerprint?: string
  provider?: ProviderConfig
  /** 直接传日志正文（粘贴 / 上传后本地已有正文时） */
  logContent?: string
}

/** `done` 帧 */
export interface DonePayload {
  status: string
  sessionId: string
  remaining: number
  nearLimit?: boolean
  score?: ScorePayload
  /** 本轮提出的追问（与 status 帧的 ask 同源，便于前端只处理一次） */
  asks?: AskPayload[]
}

/** SSE 状态帧的载荷 */
export type StatusPayload =
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; arguments?: unknown }
  | { type: 'tool_result'; name: string; summary: string; truncated?: boolean }
  | { type: 'limit'; rounds: number }
  | { type: 'reflection'; message: string }
  | { type: 'queued'; message: string }
  | { type: 'ask'; questions: string[]; reason?: string }

/* ── 管理接口 ───────────────────────────────────────────── */

export type EntryKind = 'fact' | 'method' | 'unclear'

export interface DomainKnowledge {
  id: string
  content: string
  enabled: boolean
  priority: number
  tags: string[]
  kind: EntryKind
  createdAt: number
  updatedAt: number
}

export interface DomainKnowledgeStats {
  total: number
  enabled: number
  methodLike: number
  unclear: number
  byTag: Record<string, number>
  injectedChars: number
  injectedCount: number
  skippedCount: number
}

export interface DomainKnowledgeList {
  ok: boolean
  entries: DomainKnowledge[]
  stats: DomainKnowledgeStats
}

export interface MutationResult {
  ok: boolean
  entry?: DomainKnowledge
  error?: string
  warnings?: string[]
}

export interface EntryAnalysis {
  ok: boolean
  content: string
  chars: number
  kind: EntryKind
  warnings: string[]
}

export interface AuditRecord {
  id: number
  entryId: string
  action: string
  beforeContent: string | null
  afterContent: string | null
  actor: string
  at: number
}

export interface InjectionPreview {
  ok: boolean
  chars: number
  injected: Array<{ id: string; content: string; priority: number }>
  skipped: Array<{ id: string; content: string; priority: number }>
  text: string
}

export interface AnalysisRecord {
  id: string
  created: number
  sessionId: string
  logId: string | null
  provider: string
  model: string
  overall: number
  deliverable: boolean
  grounding: number | null
  verification: number
  actionability: number
  economy: number
  rounds: number
  toolCalls: number
  emptyCalls: number
  failedCalls: number
  toolNames: string[]
  rootCause: string
  confidence: number | null
  evidenceCount: number
  stepsCount: number
  groundingRecall: number | null
  deductions: string[]
  missingAnchors: string[]
  answerChars: number
}

export interface AnalysisStats {
  total: number
  sampled: number
  /** 样本量超过聚合上限，统计只覆盖最近 `sampled` 条 */
  truncated: boolean
  avgOverall: number | null
  dimensions: {
    grounding: number | null
    verification: number | null
    actionability: number | null
    economy: number | null
  }
  deliverableRate: number | null
  avgRounds: number | null
  avgToolCalls: number | null
  scoreBuckets: Record<string, number>
  topDeductions: Array<{ text: string; count: number }>
  byModel: Record<string, { count: number; avgOverall: number }>
  lowScoreCount: number
}
