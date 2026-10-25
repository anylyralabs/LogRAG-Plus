/**
 * 浏览器端设备指纹与本地历史。
 *
 * ## 指纹
 * 后端配额按「指纹优先、IP 兜底」。这里生成一个**稳定但不追踪**的随机 ID：
 * 不采集 Canvas/字体/硬件特征——那属于跨站追踪，本产品不需要，也不该做。
 *
 * ## 会话历史
 * 后端没有「列出我的会话」的接口，且无登录，服务端也无法安全地把会话归属到
 * 某个人。因此历史只存在**本机**：
 *  - 只存 sessionId、logId、标题、时间，不存日志正文与回答；
 *  - 最多 50 条，过期（48h / 7d）由前端在读取时过滤——后端仍是权威；
 *  - 用户可一键清空。
 */

const FINGERPRINT_KEY = 'lograg.fp'
const HISTORY_KEY = 'lograg.history.v1'
const HISTORY_LIMIT = 50

/** 取（或生成）本机指纹 */
export function fingerprint(): string {
  try {
    const existing = localStorage.getItem(FINGERPRINT_KEY)
    if (existing !== null && existing.length >= 8) return existing
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    const id = `fp_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    localStorage.setItem(FINGERPRINT_KEY, id)
    return id
  } catch {
    // 隐私模式 / 禁用存储：退化为内存随机值（配额会回落到 IP + UA）
    return `fp_mem_${Math.random().toString(36).slice(2, 12)}`
  }
}

export interface HistoryEntry {
  sessionId: string
  /** 绑定的日志 ID（可空） */
  logId: string | null
  /** 首条用户消息的截断，作为标题；绝不含日志正文 */
  title: string
  /** 最近活跃时间（毫秒） */
  updatedAt: number
  /** 会话过期时间（秒级，来自后端；未知时按 48h 估） */
  expiresAt: number
}

function readAll(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const now = Math.floor(Date.now() / 1000)
    const out: HistoryEntry[] = []
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if (typeof rec['sessionId'] !== 'string' || typeof rec['title'] !== 'string') continue
      const expiresAt = typeof rec['expiresAt'] === 'number' ? rec['expiresAt'] : 0
      if (expiresAt > 0 && expiresAt <= now) continue
      out.push({
        sessionId: rec['sessionId'],
        logId: typeof rec['logId'] === 'string' ? rec['logId'] : null,
        title: rec['title'].slice(0, 80),
        updatedAt: typeof rec['updatedAt'] === 'number' ? rec['updatedAt'] : 0,
        expiresAt,
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function writeAll(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)))
  } catch {
    /* 配额满或隐私模式：历史功能降级，不影响对话 */
  }
}

export function listHistory(): HistoryEntry[] {
  return readAll()
}

/** 记录/更新一条历史（同一 session 只保留一条） */
export function rememberSession(entry: HistoryEntry): void {
  const rest = readAll().filter((e) => e.sessionId !== entry.sessionId)
  writeAll([{ ...entry, title: entry.title.trim().slice(0, 80) || '未命名会话' }, ...rest])
}

/** 只更新时间戳（多轮对话时） */
export function touchSession(sessionId: string): void {
  const all = readAll()
  const target = all.find((e) => e.sessionId === sessionId)
  if (target === undefined) return
  target.updatedAt = Date.now()
  writeAll(all)
}

export function forgetSession(sessionId: string): void {
  writeAll(readAll().filter((e) => e.sessionId !== sessionId))
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    /* ignore */
  }
}

/** 从用户发言生成标题：去掉引用块与多余空白，截断 */
export function titleFromMessage(message: string): string {
  const withoutQuote = message.split(/引用日志[\s\S]*?```/)[0] ?? message
  const firstLine =
    withoutQuote
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  return firstLine.slice(0, 60)
}
