/**
 * 追问结束后的界面状态守门（用假 SSE 流真实驱动 store）。
 *
 * ## 后端行为（本轮更新）
 * 模型调用 `ask_user` 之后**不再继续自检**：本轮直接收尾，把问题与理由写进正文。
 * 这是刻意的——用户正在等回答，模型继续 grep 只会让人干等，还浪费配额。
 *
 * ## 前端必须跟着改的三处
 * 1. 不能继续显示「正在检索 / 正在分析」的转圈：它已经停了；
 * 2. 这一轮**不算失败**：交付物是问题，不是答案，不该出现「重新分析」或「无结论」；
 * 3. 追问本身要留在消息里，刷新后还能作答（`meta.asks` 回放）。
 *
 * 这些如果不同步，用户会看到永远转圈的界面，或被告知「本次没有产出结论」——
 * 而实际上系统正等着他回答。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useChatStore } from '@/stores/chat'

/** 把若干 SSE 帧拼成一个响应体 */
function sseBody(frames: string[]): string {
  return frames.join('')
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

const ASK_FRAME =
  'event: status\n' +
  'data: {"type":"ask","questions":["你的手机是什么型号？","启动器里用的是哪个渲染器？"],"reason":"渲染器兼容性依赖具体 GPU"}\n\n'

/** 后端在提问后不再检索，直接收尾：正文 + done，没有更多 tool 帧 */
const DONE_FRAME =
  'event: done\n' +
  'data: {"status":"completed","sessionId":"sask123","remaining":9,"asks":[{"questions":["你的手机是什么型号？","启动器里用的是哪个渲染器？"],"reason":"渲染器兼容性依赖具体 GPU"}]}\n\n'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('以提问结束的一轮', () => {
  it('记录追问、标记「等你回答」，且不显示「正在检索」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(sseBody([ASK_FRAME, DONE_FRAME]))),
    )

    const store = useChatStore()
    await store.send('我的游戏崩溃了')

    const assistant = store.messages[1]
    expect(assistant).toBeDefined()
    expect(assistant?.asks).toHaveLength(1)
    expect(assistant?.asks[0]?.questions).toEqual([
      '你的手机是什么型号？',
      '启动器里用的是哪个渲染器？',
    ])

    // 后端不再自检 → 前端也不该说「正在检索」
    expect(store.phase).not.toContain('正在检索')
    expect(store.awaitingAnswer).toBe(true)
    expect(store.busy).toBe(false)
  })

  it('正文为空也不算「无结论」（交付物是问题，不是答案）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(sseBody([ASK_FRAME, DONE_FRAME]))),
    )

    const store = useChatStore()
    await store.send('我的游戏崩溃了')

    const assistant = store.messages[1]
    expect(assistant?.content).toBe('')
    expect(assistant?.status).not.toBe('empty')
    expect(assistant?.error).toBeNull()
  })

  it('问题落库后回放仍在（meta.asks）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            session: { id: 'sask123', logId: null, hasLog: false, createdAt: 1, expiresAt: 9999999999 },
            rounds: { allowed: true, remaining: 8 },
            messages: [
              { role: 'user', content: '我的游戏崩溃了', createdAt: 1 },
              {
                role: 'assistant',
                content: '需要先确认设备与渲染器。',
                createdAt: 2,
                meta: {
                  asks: [
                    {
                      questions: ['你的手机是什么型号？'],
                      reason: '渲染器兼容性依赖具体 GPU',
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    const store = useChatStore()
    const { api } = await import('@/lib/api')
    const ok = await store.replay('sask123', api.replaySession)

    expect(ok).toBe(true)
    expect(store.messages[1]?.asks[0]?.questions).toEqual(['你的手机是什么型号？'])
  })

  it('开始新一轮时清掉上一轮的等待态', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++
        // 第一轮：提问；第二轮：正常回答
        return call === 1
          ? sseResponse(sseBody([ASK_FRAME, DONE_FRAME]))
          : sseResponse(
              sseBody([
                'data: {"choices":[{"delta":{"content":"结论如下。"}}]}\n\n',
                'event: done\ndata: {"status":"completed","sessionId":"sask123","remaining":8}\n\n',
              ]),
            )
      }),
    )

    const store = useChatStore()
    await store.send('我的游戏崩溃了')
    expect(store.awaitingAnswer).toBe(true)

    await store.send('Pixel 8，MobileGlues')
    expect(store.awaitingAnswer).toBe(false)
  })
})
