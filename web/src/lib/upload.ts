/**
 * 浏览器端上传准备：读文件、解 ZIP、按服务端规则预检。
 *
 * ## 为什么前端要再校验一遍
 * 服务端会校验，但它在跨网转发之后（LogShare 那一侧）或至少在一次 12MB 上传之后。
 * 在浏览器里先算清楚：
 *  - 超限的文件根本不发出去，省流量也省用户的等待；
 *  - 能指出**具体哪个文件超了多少**，而不是一句笼统的 400；
 *  - ZIP 由客户端解压是 API 的明确约定（服务端不处理 ZIP）。
 *
 * ## 与服务端保持同一组常量
 * `src/upload/validate.ts` 的 10MB / 50000 行 / 200 文件 / 12MB。
 * 两边不一致会造成「本服务放行、LogShare 拒绝」的困惑。
 */

import { unzipSync } from 'fflate'

export const MAX_CONTENT_BYTES = 10 * 1024 * 1024
export const MAX_LINES = 50_000
export const MAX_FILES = 200
export const MAX_FILES_TOTAL_BYTES = 12 * 1024 * 1024
export const MAX_FILENAME_CHARS = 128

/** 服务端 `source` 的格式：`启动器/版本` */
const SOURCE_RE = /^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._+-]{1,32}$/

/** 文本类扩展名（保留：用于提示哪些文件会被当作日志读取） */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'log',
  'txt',
  'text',
  'yml',
  'yaml',
  'json',
  'json5',
  'md',
  'properties',
  'cfg',
  'conf',
  'toml',
  'ini',
  'xml',
  'csv',
])

export interface UploadFile {
  name: string
  data: string
}

export interface PreparedUpload {
  content: string
  files: UploadFile[]
  source: string
  /** 面向用户的提示（非错误） */
  notes: string[]
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

/** 文件名是否安全：与服务端 `isSafeFileName` 同规则 */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name.length > MAX_FILENAME_CHARS) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

/** 取路径的最后一段（ZIP 里的目录结构不该成为文件名的一部分） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.')
  return parts[parts.length - 1] ?? ''
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function lineCount(text: string): number {
  if (text === '') return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 看起来是二进制吗（NUL 字节是可靠信号） */
function looksBinary(bytes: Uint8Array): boolean {
  const cap = Math.min(bytes.length, 8192)
  for (let i = 0; i < cap; i++) if (bytes[i] === 0) return true
  return false
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 展开一个（可能为 ZIP 的）文件。
 *
 * ZIP 条目只保留单段文件名、去掉目录；`__MACOSX/` 与目录条目直接跳过。
 * 不做「清洗」路径分隔符——直接把目录剥掉，因为用户上传的是整个 logs 文件夹，
 * 目录层级对分析没有意义。
 */
function expandFile(file: File, bytes: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const isZip =
    extensionOf(file.name) === 'zip' ||
    (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)

  if (!isZip) {
    return [{ name: file.name, bytes }]
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new UploadError(`无法解压 ${file.name}：文件可能已损坏，或使用了不支持的压缩方式。`)
  }

  const out: Array<{ name: string; bytes: Uint8Array }> = []
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue
    if (path.startsWith('__MACOSX/') || path.endsWith('.DS_Store')) continue
    const name = baseName(path)
    if (name === '') continue
    if (extensionOf(name) === 'zip') continue // 不递归解压，避免压缩炸弹
    if (looksBinary(data)) continue
    out.push({ name, bytes: data })
  }

  if (out.length === 0) {
    throw new UploadError(`${file.name} 里没有可读的文本文件。`)
  }

  return out
}

/**
 * 准备上传内容。
 *
 * 主日志取「最大的那份 .log」，其余作为附件。这样服务端的 `content` 是主日志，
 * `files` 是崩溃报告等附件，两者不会重复发送同一个文件。
 */
export async function prepareUpload(
  fileList: FileList | File[],
  options: { source?: string } = {},
): Promise<PreparedUpload> {
  const input = Array.from(fileList)
  if (input.length === 0) throw new UploadError('没有选择文件。')

  const notes: string[] = []
  const collected: Array<{ name: string; data: string; bytes: number }> = []
  const usedNames = new Set<string>()

  for (const file of input) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const expanded = expandFile(file, bytes)
    if (expanded.length > 1) notes.push(`${file.name} 已解压为 ${expanded.length} 个文件`)

    for (const item of expanded) {
      if (!isSafeFileName(item.name)) {
        notes.push(`已跳过文件名不安全的条目：${item.name.slice(0, 60)}`)
        continue
      }
      if (looksBinary(item.bytes)) {
        notes.push(`已跳过二进制文件：${item.name}`)
        continue
      }
      // 重名时加序号，否则服务端与界面都无法区分两份同名日志
      let name = item.name
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.')
        const stem = dot < 0 ? name : name.slice(0, dot)
        const ext = dot < 0 ? '' : name.slice(dot)
        let n = 2
        while (usedNames.has(`${stem}-${n}${ext}`)) n++
        name = `${stem}-${n}${ext}`
        notes.push(`重名文件已改名为 ${name}`)
      }
      usedNames.add(name)

      const data = decode(item.bytes)
      if (data.trim() === '') {
        notes.push(`已忽略空文件 ${name}`)
        continue
      }
      collected.push({ name, data, bytes: item.bytes.byteLength })
    }
  }

  if (collected.length === 0) {
    throw new UploadError('这些文件里没有可分析的文本内容。')
  }
  if (collected.length > MAX_FILES) {
    throw new UploadError(`附加文件最多 ${MAX_FILES} 个，当前 ${collected.length} 个。`)
  }

  const totalBytes = collected.reduce((s, f) => s + f.bytes, 0)
  // 总量按「主日志 + 附件」算，与后端一致；主日志随后可能独占一份，
  // 但服务端在同时给 content 与 files 时会把两者都计入总量，因此这里直接全算。
  if (totalBytes > MAX_FILES_TOTAL_BYTES) {
    throw new UploadError(
      `日志与附件合计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，超过上限 ${
        MAX_FILES_TOTAL_BYTES / 1024 / 1024
      }MB。请只保留 latest.log 与崩溃报告。`,
    )
  }

  // 主日志：优先最大的 `.log`，否则最大的文本文件
  const logs = collected.filter((f) => extensionOf(f.name) === 'log')
  const pool = logs.length > 0 ? logs : collected
  const main = pool.reduce((a, b) => (b.bytes > a.bytes ? b : a))

  if (utf8Bytes(main.data) > MAX_CONTENT_BYTES) {
    throw new UploadError(
      `主日志 ${main.name} 为 ${(main.bytes / 1024 / 1024).toFixed(1)}MB，超过单文件 ${
        MAX_CONTENT_BYTES / 1024 / 1024
      }MB 上限。请先在本地截取崩溃前后部分再上传。`,
    )
  }
  const lines = lineCount(main.data)
  if (lines > MAX_LINES) {
    throw new UploadError(`主日志 ${main.name} 有 ${lines} 行，超过 ${MAX_LINES} 行上限。`)
  }

  const attachments = collected.filter((f) => f !== main).map((f) => ({ name: f.name, data: f.data }))

  const source = options.source?.trim() ?? ''
  return {
    content: main.data,
    files: attachments,
    source: SOURCE_RE.test(source) ? source : '',
    notes,
  }
}

/**
 * 粘贴内容是否更像日志而不是问题。
 *
 * 用于输入框的「这段像日志，要不要作为日志附件分析？」提示。
 * 判据刻意保守：宁可漏判，也不要频繁打断用户提问。
 */
export function looksLikeLog(text: string): boolean {
  if (text.length < 400) return false
  const lines = text.split('\n')
  if (lines.length < 8) return false

  let logish = 0
  for (const line of lines.slice(0, 80)) {
    if (/^\[?\d{2}:\d{2}:\d{2}/.test(line.trim())) logish++
    else if (/^\[(?:[^\]/]*\/)?(INFO|WARN|ERROR|FATAL|DEBUG)\]/.test(line.trim())) logish++
    else if (/^\s+at\s+[\w$.]+\(/.test(line)) logish++
    else if (/^(Caused by|java\.|net\.minecraft|org\.)/.test(line.trim())) logish++
  }
  return logish >= Math.min(8, Math.ceil(lines.length * 0.15))
}
