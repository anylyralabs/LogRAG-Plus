/** 与后端 `/v1/*` 的类型契约。字段名必须与 src/server/index.ts 的输出一致。 */

export interface HealthResponse {
  ok: boolean
  service: string
  version: string
  rag: { chunks: number; files: number }
  config: Record<string, unknown>
}

/** `done` 帧里的四维自评 */
export interface ScorePayload {
  overall: number
  deliverable: boolean
  dimensions: { grounding: number; verification: number; actionability: number; economy: number }
  deductions: string[]
  missingAnchors: string[]
  recordId?: string
}

/** 结尾结构化结论块（模型按 output-spec 输出） */
export interface Conclusion {
  rootCause?: string
  confidence?: number | string
  steps?: Array<string | { action?: string; reason?: string }>
  evidence?: Array<string | { quote?: string; source?: string }>
  [key: string]: unknown
}

/** 一次工具调用（附录用） */
export interface ToolCallItem {
  name: string
  round: number
}

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
  status: 'streaming' | 'completed' | 'error' | 'aborted'
  error: string | null
  createdAt: number
}

/** `GET /v1/log/{id}` */
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
  maybeObfuscating: boolean
  docs: LogDoc[]
  omitted: string[]
  error?: string
}

/** `POST /v1/upload` */
export interface UploadResponse {
  ok: boolean
  logId: string
  remaining: number
  maybeObfuscating?: boolean
}

/** `GET /v1/session/{id}` 的会话回放 */
export interface SessionReplay {
  ok: boolean
  sessionId: string
  logId: string | null
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    createdAt: number
    score?: ScorePayload
    conclusion?: Conclusion
  }>
}
