/**
 * 与服务端接口对齐的类型。
 *
 * 全部字段以 `src/server/index.ts` 的实现为准（而不是以文档为准）——本项目
 * 的教训是「文档写了但不生效」类缺陷最难发现，故类型定义处逐条标注来源。
 */

/** `GET /health` */
export interface Health {
  ok: boolean;
  version?: string;
  rag?: { chunks?: number; files?: number; enabled?: boolean };
  [key: string]: unknown;
}

/** `POST /v1/chat` 请求体（对齐 `ChatRequest`） */
export interface ChatRequest {
  message: string;
  /** 日志正文；与 `logId` 二选一，同时给出时以此为准 */
  logContent?: string;
  /** LogShare 日志 ID，只给 ID 时服务端自动取回正文 */
  logId?: string;
  /** 会话 ID；响应 `done` 帧会带回，客户端应保存并回传 */
  sessionId?: string;
  /** 自定义供应商（覆盖服务端默认） */
  provider?: { baseUrl: string; apiKey: string; model: string };
  /** 设备指纹（配额归属用；缺失时服务端回退 IP+UA） */
  fingerprint?: string;
}

/** `GET /v1/session/{id}` */
export interface SessionReplay {
  ok: boolean;
  session: { id: string; logId: string | null; createdAt: number; expiresAt: number };
  rounds: { allowed: boolean; used?: number; limit?: number; remaining?: number };
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    createdAt: number;
  }>;
}

/** `POST /v1/upload` 请求体（附加文件字段名是 `data`，不是 `content`） */
export interface UploadRequest {
  content: string;
  source?: string;
  files?: Array<{ name: string; data: string }>;
  fingerprint?: string;
}

/** `POST /v1/upload` 响应 */
export interface UploadResponse {
  ok: boolean;
  id?: string;
  /** 删除令牌，只下发一次 */
  token?: string;
  notes?: string[];
  remaining?: number;
  error?: string;
  retryAfterSeconds?: number;
}

/** `done` 帧里的自评（维度分是**分数**不是对象，与内部 ScoreResult 不同） */
export interface ScorePayload {
  overall: number;
  deliverable?: boolean;
  dimensions: {
    grounding: number;
    verification: number;
    actionability: number;
    economy: number;
  };
  deductions: Array<{ dimension?: string; points?: number; reason?: string }>;
  missingAnchors: string[];
  recordId?: string;
}

/**
 * 正文末尾结构化块（见 `prompts/output-spec.md`）。
 *
 * `confidence` 是 **0–1 的数**（不是「高/中/低」这类字符串，也不是百分数）。
 * 类型按规范写死为 number，渲染侧再处理「模型给了字符串」的容错——
 * 容错放在展示层，不放进数据契约，否则契约会慢慢退化成 any。
 */
export interface Conclusion {
  rootCause?: string;
  confidence?: number;
  evidence?: string[];
  steps?: string[];
  [key: string]: unknown;
}

/** `GET /v1/log/{id}` —— 日志面板的一份文档（主日志或某个附件） */
export interface LogDocDto {
  name: string;
  bytes: number;
  lines: number;
  content: string;
  /** 该份文档超过单份上限（2MB）被截断 */
  truncated: boolean;
}

/** `GET /v1/log/{id}` 响应 */
export interface LogDocsResponse {
  ok: boolean;
  logId: string;
  source: string;
  createdAt: number;
  maybeObfuscating: boolean;
  docs: LogDocDto[];
  /** 超出总量预算而完全未下发的文档名 */
  omitted: string[];
  error?: string;
}

/** `done` 帧载荷 */
export interface DonePayload {
  status: string;
  sessionId?: string;
  remaining?: number;
  nearLimit?: boolean;
  score?: ScorePayload;
}

/** 状态帧（`event: status`） */
export type StatusPayload =
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; arguments: unknown }
  | { type: 'tool_result'; name: string; summary: string; truncated?: boolean }
  | { type: 'limit'; rounds: number }
  | { type: 'queued'; message?: string; position?: number }
  | { type: 'reflection'; message: string }
  | { type: string; [key: string]: unknown };

/** 管理面：领域知识条目（对齐 `src/knowledge/domain.ts`） */
export interface DomainEntry {
  id: string;
  content: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  kind: 'fact' | 'method' | 'unclear';
  createdAt: number;
  updatedAt: number;
}

/** 管理面：性质判定结果 */
export interface EntryAnalysis {
  kind: 'fact' | 'method' | 'unclear';
  warnings: string[];
  [key: string]: unknown;
}

/** 管理面：分析记录（对齐 `src/eval/records.ts` 落库字段） */
export interface AnalysisRecord {
  id: string;
  sessionId: string;
  logId: string | null;
  provider: string;
  model: string;
  rounds: number;
  answerChars: number;
  overall: number;
  conclusion: Conclusion;
  createdAt: number;
  [key: string]: unknown;
}
