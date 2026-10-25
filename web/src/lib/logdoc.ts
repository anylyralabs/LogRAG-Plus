/**
 * 日志文档解析：分节、严重度、错误行导航、行窗口。
 *
 * LogShare 的 raw 把多份文件拼成一份，用 `===== 文件名 =====` 分节。
 * 实测一份 2604 行的移动端日志是四份拼起来的（launcher / hs_err / latest / authlib），
 * 节名就是文件名——把它还给用户，等于把「哪一节是崩溃现场」这个结构还回去。
 *
 * 这个模块是纯函数，跑在 Web Worker 里；主线程只拿结果渲染。
 */

export type Severity = 'error' | 'warn' | 'dim' | 'plain'

export interface LogSection {
  name: string
  /** 中文角色，如「崩溃现场」 */
  role: string
  /** 1 基，含 */
  start: number
  /** 1 基，含 */
  end: number
}

export interface ParsedLog {
  lines: string[]
  sections: LogSection[]
  severity: Severity[]
  errors: number[]
  counts: { error: number; warn: number }
}

const SECTION_RE = /^={3,}\s*(.+?)\s*={3,}$/

const ROLE_BY_NAME: Array<{ test: RegExp; role: string }> = [
  { test: /hs_err|crash|crash-report|fatal/i, role: '崩溃现场' },
  { test: /launcher|launcher_log|fcl|zl2|axolotl/i, role: '启动器日志' },
  { test: /authlib|injector/i, role: '登录注入器' },
  { test: /latest|\.log$/i, role: '游戏日志' },
]

function roleOf(name: string): string {
  for (const r of ROLE_BY_NAME) if (r.test.test(name)) return r.role
  return '其它'
}

/**
 * 行级别粗筛。
 *
 * 只把 ERROR / WARN 上色：INFO 占绝大多数，**上色的行一多，上色就等于没有**。
 * 堆栈帧压暗，形成暗底上的少数亮线。
 */
export function classify(line: string): Severity {
  const t = line.trim()
  if (t === '') return 'plain'

  if (/^at\s+[\w$.<>/]+\s*\(/.test(t)) return 'dim'
  if (/^\.\.\.\s+\d+\s+more$/.test(t)) return 'dim'
  if (/^#[ \t]+[A-Z]\w*\s+\[/.test(t)) return 'dim'
  if (/^#\s*$/.test(t)) return 'dim'

  if (/^#[ \t]*(EXCEPTION_|SIGSEGV|SIGBUS|SIGILL|SIGFPE)/i.test(t)) return 'error'
  if (/^#[ \t]*Problematic frame:/i.test(t)) return 'error'
  if (/^#[ \t]*(Internal Error|Out of Memory Error)/i.test(t)) return 'error'

  if (/^(Caused by|Suppressed):/.test(t)) return 'error'
  if (/^E\/[\w.$-]+.*(FATAL EXCEPTION|Exception|Error)/.test(t)) return 'error'
  if (/^(FATAL|ERROR|SEVERE)\b/.test(t)) return 'error'
  if (/^W\/[\w.$-]/.test(t)) return 'warn'
  if (/^(WARN|WARNING)\b/.test(t)) return 'warn'

  const level = /\[(?:[^\]/]*\/)?(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE|NOTICE)\]/i.exec(
    t.slice(0, 80),
  )
  if (level !== null) {
    const lv = (level[1] ?? '').toUpperCase()
    if (lv === 'FATAL' || lv === 'ERROR' || lv === 'SEVERE') return 'error'
    if (lv === 'WARN' || lv === 'WARNING') return 'warn'
    if (lv === 'DEBUG' || lv === 'TRACE') return 'dim'
    return 'plain'
  }

  if (/^(Failed|Could not|Unable to|Missing|No |Cannot)\b/.test(t)) return 'warn'
  return 'plain'
}

export function parseLog(content: string): ParsedLog {
  const lines = content.split('\n')
  const severity: Severity[] = new Array(lines.length)
  const errors: number[] = []
  let errCount = 0
  let warnCount = 0

  for (let i = 0; i < lines.length; i++) {
    const s = classify(lines[i] ?? '')
    severity[i] = s
    if (s === 'error') {
      errCount++
      errors.push(i + 1)
    } else if (s === 'warn') {
      warnCount++
    }
  }

  const sections: LogSection[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec((lines[i] ?? '').trim())
    if (m === null || m[1] === undefined) continue
    const prev = sections[sections.length - 1]
    if (prev !== undefined) prev.end = i
    sections.push({ name: m[1], role: roleOf(m[1]), start: i + 1, end: lines.length })
  }

  return { lines, sections, severity, errors, counts: { error: errCount, warn: warnCount } }
}

/** 取行区间原文（1 基，闭区间）。不带行号——行号是界面坐标，模型不需要 */
export function sliceLines(parsed: ParsedLog, from: number, to: number): string {
  const a = Math.max(1, Math.min(from, to))
  const b = Math.min(parsed.lines.length, Math.max(from, to))
  return parsed.lines.slice(a - 1, b).join('\n')
}

export function nextError(errors: number[], from: number): number | null {
  if (errors.length === 0) return null
  for (const n of errors) if (n > from) return n
  return errors[0] ?? null
}

export function prevError(errors: number[], from: number): number | null {
  if (errors.length === 0) return null
  for (let i = errors.length - 1; i >= 0; i--) {
    const n = errors[i]
    if (n !== undefined && n < from) return n
  }
  return errors[errors.length - 1] ?? null
}

/**
 * 找一个锚点在日志中的行号。
 *
 * 证据回跳用。只接受**足够长**的锚点（太短的字符串会到处命中，跳过去毫无意义），
 * 优先整行匹配，其次子串匹配。返回 1 基线号或 null。
 */
export function findAnchor(lines: string[], anchor: string): number | null {
  const needle = anchor.trim()
  if (needle.length < 6) return null

  const lower = needle.toLowerCase()
  // 先找包含关系（证据常是「main.log:342 UnsatisfiedLinkError…」这样的片段）
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(lower)) return i + 1
  }

  // 再按空白切分，取最长的 token 重试（模型可能把两行拼成一条证据）
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 8)
  tokens.sort((a, b) => b.length - a.length)
  for (const token of tokens.slice(0, 3)) {
    const tl = token.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? '').toLowerCase().includes(tl)) return i + 1
    }
  }

  return null
}

/** 在日志内搜索（大小写不敏感），返回全部命中行号（1 基） */
export function searchLines(lines: string[], query: string, limit = 200): number[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(q)) {
      out.push(i + 1)
      if (out.length >= limit) break
    }
  }
  return out
}

/** 中文角色 → 一句话说明 */
export function describeRole(role: string): string {
  switch (role) {
    case '崩溃现场':
      return 'JVM 崩溃报告，优先级最高'
    case '启动器日志':
      return '启动器的启动过程记录'
    case '登录注入器':
      return '账号登录与注入器日志'
    case '游戏日志':
      return '游戏本体 latest.log'
    default:
      return '附加文件'
  }
}
