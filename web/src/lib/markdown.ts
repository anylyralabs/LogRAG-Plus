/**
 * Markdown → 安全的结构化块。
 *
 * ## 为什么不用 `v-html`，也不引完整渲染器
 * 模型输出里必然混着用户日志原文（`<`、`&`、用户自己贴的 HTML 都是常态）。
 * 一旦走 `v-html`，XSS 就从「需要绕过过滤器」变成「默认成立」。
 *
 * 这里用 `marked.lexer()` **只取词法分析结果**，再把 token 归一化成自有块，
 * 由 Vue 模板渲染（默认转义）。marked 的 HTML 输出能力完全不被调用。
 *
 * 支持范围刻意收敛到模型实际会用到的子集：标题、段落、列表、代码块、
 * 引用、分割线、表格、行内代码/粗体/斜体/删除线/链接。
 */

import { marked, type Token, type Tokens } from 'marked'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' }

export type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'hr' }

export interface ListItem {
  /** 任务列表状态；普通列表为 null */
  checked: boolean | null
  blocks: Block[]
}

/** 链接只放行这几种协议，其余按纯文本显示（防 `javascript:` / `data:`） */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (href === '') return null
  // 相对链接在 SPA 里没有意义，且可能被用于构造站内跳转，按纯文本处理
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null
  try {
    const url = new URL(href)
    return SAFE_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function parseInline(tokens: Token[] | undefined): Inline[] {
  if (tokens === undefined) return []
  const out: Inline[] = []

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        // text token 可能自带子 token（如 `**a** b` 被切成 text + strong）
        if (t.tokens !== undefined && t.tokens.length > 0) out.push(...parseInline(t.tokens))
        else if (t.text !== '') out.push({ kind: 'text', text: t.text })
        break
      }
      case 'escape': {
        const t = token as Tokens.Escape
        out.push({ kind: 'text', text: t.text })
        break
      }
      case 'codespan': {
        const t = token as Tokens.Codespan
        out.push({ kind: 'code', text: t.text })
        break
      }
      case 'strong': {
        const t = token as Tokens.Strong
        out.push({ kind: 'strong', children: parseInline(t.tokens) })
        break
      }
      case 'em': {
        const t = token as Tokens.Em
        out.push({ kind: 'em', children: parseInline(t.tokens) })
        break
      }
      case 'del': {
        const t = token as Tokens.Del
        out.push({ kind: 'del', children: parseInline(t.tokens) })
        break
      }
      case 'link': {
        const t = token as Tokens.Link
        const href = safeHref(t.href)
        if (href === null) out.push(...parseInline(t.tokens))
        else out.push({ kind: 'link', href, children: parseInline(t.tokens) })
        break
      }
      case 'br':
        out.push({ kind: 'br' })
        break
      case 'html': {
        // 不解释 HTML；原样当文本显示（Vue 会转义）
        const t = token as Tokens.HTML
        out.push({ kind: 'text', text: t.raw })
        break
      }
      case 'image': {
        const t = token as Tokens.Image
        // 不加载远程图片：会泄漏阅读者 IP，且模型几乎不产出可用图片
        out.push({ kind: 'text', text: t.text === '' ? '[图片]' : `[图片：${t.text}]` })
        break
      }
      default: {
        const raw = (token as { raw?: unknown }).raw
        if (typeof raw === 'string' && raw !== '') out.push({ kind: 'text', text: raw })
      }
    }
  }

  return mergeText(out)
}

/** 合并相邻文本节点，减少渲染节点数 */
function mergeText(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (node.kind === 'text' && last !== undefined && last.kind === 'text') {
      last.text += node.text
      continue
    }
    out.push(node)
  }
  return out
}

function parseBlocks(tokens: Token[]): Block[] {
  const out: Block[] = []

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break
      case 'heading': {
        const t = token as Tokens.Heading
        out.push({
          kind: 'heading',
          level: Math.max(1, Math.min(4, t.depth)),
          inline: parseInline(t.tokens),
        })
        break
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph
        out.push({ kind: 'paragraph', inline: parseInline(t.tokens) })
        break
      }
      case 'text': {
        const t = token as Tokens.Text
        // 顶层 text（列表项里常见）当作段落
        out.push({ kind: 'paragraph', inline: parseInline(t.tokens ?? [{ ...t, type: 'text' }]) })
        break
      }
      case 'code': {
        const t = token as Tokens.Code
        out.push({ kind: 'code', lang: (t.lang ?? '').trim(), content: t.text })
        break
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote
        out.push({ kind: 'quote', blocks: parseBlocks(t.tokens) })
        break
      }
      case 'list': {
        const t = token as Tokens.List
        out.push({
          kind: 'list',
          ordered: t.ordered,
          start: typeof t.start === 'number' ? t.start : 1,
          items: t.items.map((item) => ({
            checked: item.task ? item.checked === true : null,
            blocks: parseBlocks(item.tokens),
          })),
        })
        break
      }
      case 'table': {
        const t = token as Tokens.Table
        out.push({
          kind: 'table',
          head: t.header.map((cell) => parseInline(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => parseInline(cell.tokens))),
        })
        break
      }
      case 'hr':
        out.push({ kind: 'hr' })
        break
      case 'html': {
        const t = token as Tokens.HTML
        // 块级 HTML 不解释，作为代码块原样显示——这既保留信息，又不执行
        out.push({ kind: 'code', lang: '', content: t.raw.trimEnd() })
        break
      }
      default: {
        const raw = (token as { raw?: unknown }).raw
        if (typeof raw === 'string' && raw.trim() !== '') {
          out.push({ kind: 'paragraph', inline: [{ kind: 'text', text: raw.trim() }] })
        }
      }
    }
  }

  return out
}

/**
 * 解析 Markdown 文本。
 *
 * 解析失败（例如未闭合的围栏）时退回「整段纯文本」，而不是抛错：
 * 流式过程中半截 Markdown 是常态，界面不能因此白屏。
 */
export function parseMarkdown(source: string): Block[] {
  if (source.trim() === '') return []
  try {
    return parseBlocks(marked.lexer(source))
  } catch {
    return [{ kind: 'paragraph', inline: [{ kind: 'text', text: source }] }]
  }
}
