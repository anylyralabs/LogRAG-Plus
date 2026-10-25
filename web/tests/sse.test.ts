/**
 * SSE 解析器测试。
 *
 * 这些用例直接对应 `API.md` 里列的五个客户端坑。每一条都曾以「看起来像后端
 * 故障」的形态出现：丢字、乱码、空回答、卡死。纯函数 + 构造字节流才能稳定复现。
 */
import { describe, expect, it } from 'vitest'
import { consumeSse, dispatchFrame, parseFrame, readContentDelta, splitFrames } from '@/lib/sse'
import type { DonePayload, StatusPayload } from '@/lib/types'

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** 把字符串按字节任意切块（模拟 TCP 分包） */
function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size))
  return out
}

function streamFromBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('splitFrames', () => {
  it('按空行切帧并保留不完整尾部', () => {
    const { frames, rest } = splitFrames('data: a\n\ndata: b\n\ndata: c')
    expect(frames).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('data: c')
  })

  it('接受 CRLF 行尾', () => {
    const { frames, rest } = splitFrames('event: done\r\ndata: {}\r\n\r\n')
    expect(frames).toEqual(['event: done\r\ndata: {}'])
    expect(rest).toBe('')
  })

  it('空缓冲不产生帧', () => {
    expect(splitFrames('')).toEqual({ frames: [], rest: '' })
  })
})

describe('parseFrame', () => {
  it('解析 event 与 data', () => {
    expect(parseFrame('event: status\ndata: {"type":"limit"}')).toEqual({
      event: 'status',
      data: '{"type":"limit"}',
    })
  })

  it('多行 data 以换行拼接（规范要求）', () => {
    expect(parseFrame('data: line1\ndata: line2').data).toBe('line1\nline2')
  })

  it('只去掉冒号后的一个空格，其余空格属于数据', () => {
    expect(parseFrame('data:  two spaces').data).toBe(' two spaces')
  })

  it('忽略心跳注释行', () => {
    expect(parseFrame(': keep-alive\ndata: x')).toEqual({ event: '', data: 'x' })
  })

  it('无 event 时表示正文帧', () => {
    expect(parseFrame('data: {"choices":[]}').event).toBe('')
  })
})

describe('readContentDelta', () => {
  it('读取 OpenAI 兼容增量', () => {
    expect(readContentDelta({ choices: [{ delta: { content: '根因' } }] })).toBe('根因')
  })

  it('空 choices 返回 null', () => {
    expect(readContentDelta({ choices: [] })).toBeNull()
  })

  it('非对象返回 null', () => {
    expect(readContentDelta('x')).toBeNull()
  })
})

describe('dispatchFrame', () => {
  it('thinking 帧同时触发 onThinking 与 onStatus', () => {
    const thinking: string[] = []
    const statuses: StatusPayload[] = []
    dispatchFrame(
      { event: 'status', data: JSON.stringify({ type: 'thinking', delta: '先看崩溃点' }) },
      { onThinking: (d) => thinking.push(d), onStatus: (s) => statuses.push(s) },
    )
    expect(thinking).toEqual(['先看崩溃点'])
    expect(statuses).toHaveLength(1)
  })

  it('tool 帧带参数', () => {
    const seen: StatusPayload[] = []
    dispatchFrame(
      { event: 'status', data: JSON.stringify({ type: 'tool', name: 'grep_log_file', arguments: { query: 'SIGSEGV' } }) },
      { onStatus: (s) => seen.push(s) },
    )
    expect(seen[0]).toMatchObject({ type: 'tool', name: 'grep_log_file' })
  })

  it('error 帧取出 error 字段', () => {
    let message = ''
    dispatchFrame({ event: 'error', data: JSON.stringify({ error: '上游返回 502' }) }, {
      onError: (m) => (message = m),
    })
    expect(message).toBe('上游返回 502')
  })

  it('error 帧为纯文本时原样传递', () => {
    let message = ''
    dispatchFrame({ event: 'error', data: '分析失败' }, { onError: (m) => (message = m) })
    expect(message).toBe('分析失败')
  })

  it('done 帧解析 sessionId 与 score', () => {
    let done: DonePayload | null = null
    dispatchFrame(
      {
        event: 'done',
        data: JSON.stringify({ status: 'completed', sessionId: 's1', remaining: 9, score: { overall: 90 } }),
      },
      { onDone: (d) => (done = d) },
    )
    expect(done).toMatchObject({ sessionId: 's1', remaining: 9 })
  })

  it('缺少 sessionId 的 done 帧归为未知，不伪造成功', () => {
    let done = false
    const unknown: string[] = []
    dispatchFrame(
      { event: 'done', data: JSON.stringify({ status: 'completed' }) },
      { onDone: () => (done = true), onUnknown: (f) => unknown.push(f.event) },
    )
    expect(done).toBe(false)
    expect(unknown).toEqual(['done'])
  })

  it('损坏的 JSON 不抛异常，走 onUnknown', () => {
    const unknown: string[] = []
    expect(() =>
      dispatchFrame({ event: 'status', data: '{bad' }, { onUnknown: (f) => unknown.push(f.event) }),
    ).not.toThrow()
    expect(unknown).toEqual(['status'])
  })

  it('正文帧读取 choices[0].delta.content', () => {
    const parts: string[] = []
    dispatchFrame(
      { event: '', data: JSON.stringify({ choices: [{ delta: { content: '根因是' } }] }) },
      { onContent: (d) => parts.push(d) },
    )
    expect(parts).toEqual(['根因是'])
  })
})

describe('consumeSse', () => {
  it('端到端：思维链、正文、done 按顺序到达', async () => {
    const events: string[] = []
    let content = ''
    const stream = streamFrom([
      'event: status\ndata: {"type":"thinking","delta":"先看锚点"}\n\n',
      'data: {"choices":[{"delta":{"content":"根因是"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"模组冲突"}}]}\n\n',
      'event: done\ndata: {"status":"completed","sessionId":"s1","remaining":8}\n\n',
    ])

    await consumeSse(stream, {
      onThinking: () => events.push('thinking'),
      onContent: (d) => {
        events.push('content')
        content += d
      },
      onDone: () => events.push('done'),
    })

    expect(content).toBe('根因是模组冲突')
    expect(events).toEqual(['thinking', 'content', 'content', 'done'])
  })

  it('一帧被切成两块时不丢字', async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"完整句子"}}]}\n\n'
    let content = ''
    // 每一块只给 3 字节（必然切在 UTF-8 汉字中间）
    await consumeSse(streamFromBytes(byteChunks(frames, 3)), {
      onContent: (d) => (content += d),
    })
    expect(content).toBe('完整句子')
  })

  it('多字节字符被切在块边界时不产生乱码', async () => {
    const text = '崩溃现场：libSDL3.so 缺失'
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
    let content = ''
    await consumeSse(streamFromBytes(byteChunks(frames, 1)), {
      onContent: (d) => (content += d),
    })
    expect(content).toBe(text)
  })

  it('心跳注释行被忽略', async () => {
    let content = ''
    await consumeSse(streamFrom([': keep-alive\n\n', 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n']), {
      onContent: (d) => (content += d),
    })
    expect(content).toBe('x')
  })

  it('末尾没有空行时仍处理最后一帧', async () => {
    let done = false
    await consumeSse(streamFrom(['event: done\ndata: {"status":"completed","sessionId":"s1","remaining":1}']), {
      onDone: () => (done = true),
    })
    expect(done).toBe(true)
  })

  it('done 之后再来一帧也不崩（协议外但可能发生）', async () => {
    const events: string[] = []
    await consumeSse(
      streamFrom([
        'event: done\ndata: {"status":"completed","sessionId":"s1","remaining":1}\n\n',
        'data: {"choices":[{"delta":{"content":"多余"}}]}\n\n',
      ]),
      { onDone: () => events.push('done'), onContent: (d) => events.push(d) },
    )
    expect(events[0]).toBe('done')
  })
})
