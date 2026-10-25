/**
 * Markdown 解析测试。
 *
 * 重点不是「渲染得好不好看」，而是**安全不变量**：
 * 任何输入都不得产生可执行的 HTML，链接协议必须白名单化。
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'

function flatten(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return flatten(n.children)
        case 'br':
          return '\n'
      }
    })
    .join('')
}

function firstParagraph(blocks: Block[]): Inline[] {
  const first = blocks[0]
  if (first === undefined || first.kind !== 'paragraph') return []
  return first.inline
}

describe('parseMarkdown', () => {
  it('解析标题、段落、列表、代码块', () => {
    const blocks = parseMarkdown(
      ['## 判定', '', '根因是 **模组冲突**。', '', '- 第一项', '- 第二项', '', '```json', '{"a":1}', '```'].join('\n'),
    )
    const kinds = blocks.map((b) => b.kind)
    expect(kinds).toContain('heading')
    expect(kinds).toContain('paragraph')
    expect(kinds).toContain('list')
    expect(kinds).toContain('code')

    const code = blocks.find((b) => b.kind === 'code')
    expect(code).toMatchObject({ kind: 'code', lang: 'json', content: '{"a":1}' })
  })

  it('行内代码与粗体结构正确', () => {
    const inline = firstParagraph(parseMarkdown('根因是 `libSDL3.so` 缺失，**必须**修复。'))
    const kinds = inline.map((n) => n.kind)
    expect(kinds).toContain('code')
    expect(kinds).toContain('strong')
    expect(flatten(inline)).toContain('libSDL3.so')
  })

  it('原始 HTML 当作文本，不解释', () => {
    const html = '<img src=x onerror=alert(1)>'
    const blocks = parseMarkdown(html)
    const text = JSON.stringify(blocks)
    // 结构里只能有 text，不能出现 html 或 image 节点
    expect(text).not.toContain('"kind":"html"')
    expect(text).not.toContain('"kind":"image"')
    expect(text).toContain('onerror')
  })

  it('块级 HTML 原样进入代码块（保留信息、不执行）', () => {
    const blocks = parseMarkdown('<div onclick="x()">hello</div>')
    const code = blocks.find((b) => b.kind === 'code')
    expect(code).toBeDefined()
    if (code !== undefined && code.kind === 'code') {
      expect(code.content).toContain('onclick')
    }
  })

  it('危险链接协议被降级为纯文本', () => {
    const inline = firstParagraph(parseMarkdown('[点我](javascript:alert(1))'))
    expect(inline.some((n) => n.kind === 'link')).toBe(false)
    expect(flatten(inline)).toContain('点我')
  })

  it('data: 链接同样被拒绝', () => {
    const inline = firstParagraph(parseMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)'))
    expect(inline.some((n) => n.kind === 'link')).toBe(false)
  })

  it('http/https/mailto 链接保留', () => {
    const inline = firstParagraph(parseMarkdown('[文档](https://example.com/a)'))
    const link = inline.find((n) => n.kind === 'link')
    expect(link).toBeDefined()
    if (link !== undefined && link.kind === 'link') {
      expect(link.href.startsWith('https://example.com')).toBe(true)
    }
  })

  it('图片不加载远程资源，降级为文本', () => {
    const blocks = parseMarkdown('![截图](https://evil.example.com/track.png)')
    expect(JSON.stringify(blocks)).not.toContain('evil.example.com')
    expect(JSON.stringify(blocks)).toContain('图片')
  })

  it('未闭合的围栏不抛异常', () => {
    expect(() => parseMarkdown('```\n未闭合')).not.toThrow()
  })

  it('空文本返回空数组', () => {
    expect(parseMarkdown('   ')).toEqual([])
  })

  it('嵌套列表可解析', () => {
    const blocks = parseMarkdown(['- 外层', '  - 内层', '- 第二项'].join('\n'))
    expect(blocks.some((b) => b.kind === 'list')).toBe(true)
  })

  it('表格保留表头与行', () => {
    const blocks = parseMarkdown(['| 列 A | 列 B |', '| --- | --- |', '| 1 | 2 |'].join('\n'))
    const table = blocks.find((b) => b.kind === 'table')
    expect(table).toBeDefined()
    if (table !== undefined && table.kind === 'table') {
      expect(table.head).toHaveLength(2)
      expect(table.rows).toHaveLength(1)
    }
  })
})
