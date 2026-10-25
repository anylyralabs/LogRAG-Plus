/**
 * `ask_user` 之后不得继续自检。
 *
 * ## 守的是什么（实测缺陷）
 *
 * 模型调用 `ask_user` 之后，常见行为是**继续查**：再 grep 一次、再读一段，
 * 然后才产出正文。但此刻界面上问题已经呈现给用户、用户正在等回答，
 * 模型却在后台继续检索——既浪费配额，也让「反问」显得不果断。
 *
 * 修复是三层：
 *  1. 提示词与工具返回明确「问完就停」；
 *  2. 主循环在 `ask_user` 后置 `awaitingUser`，模型再发工具调用即终止；
 *  3. 若终止时正文为空，用问题清单兜底成正文（否则用户只看到一句错误）。
 *
 * 本测试守第 2、3 层——它们不依赖模型是否听话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { runAgent } from '../src/agent/runner.ts'
import type { RunResult } from '../src/agent/runner.ts'
import { createToolContext } from '../src/agent/tools/index.ts'
import type { SseWriter } from '../src/server/sse.ts'

/*
 * `buildTools()` 会探测领域知识库（真实 MariaDB），连接池里的空闲连接会
 * 把进程挂住——测试全过、文件却不退出。这里显式关闭；库未配置时是空操作。
 */
test.after(async () => {
  const { closePool } = await import('../src/store/mysql.ts')
  await closePool()
})

// ── 假模型：问一次 → 又想调工具（模拟「问完继续自检」）──────────

interface Step {
  kind: 'ask' | 'tool' | 'content'
  name?: string
  args?: unknown
  text?: string
}

async function startFakeModel(steps: Step[], synthesisText = '已提问，等待回答。'): Promise<{
  baseUrl: string
  requests: string[]
  close: () => Promise<void>
}> {
  const requests: string[] = []
  let cursor = 0

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push(raw)

      // 收尾轮（runSynthesis）请求体里没有 tools
      const isSynthesis = !raw.includes('"tools"')
      const step: Step = isSynthesis
        ? { kind: 'content', text: synthesisText }
        : (steps[Math.min(cursor, steps.length - 1)] ?? { kind: 'content', text: '结束' })
      cursor += 1
      const no = cursor

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-askloop-${no}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        )
      }

      if (step.kind === 'ask') {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_ask_${no}`,
              type: 'function',
              function: {
                name: 'ask_user',
                arguments: JSON.stringify({
                  questions: ['你的手机是什么型号？', '用的是哪个渲染器？'],
                  reason: '渲染器兼容性依赖具体 GPU，日志里没有记录',
                }),
              },
            },
          ],
        })
        send({}, 'tool_calls')
      } else if (step.kind === 'tool') {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_t_${no}`,
              type: 'function',
              function: { name: step.name ?? 'grep_log_file', arguments: '' },
            },
          ],
        })
        const json = JSON.stringify(step.args ?? { query: 'ERROR' })
        for (let i = 0; i < json.length; i += 7) {
          send({ tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 7) } }] })
        }
        send({}, 'tool_calls')
      } else {
        const t = step.text ?? '正文'
        const cut = Math.ceil(t.length / 2)
        send({ role: 'assistant', content: t.slice(0, cut) })
        send({ content: t.slice(cut) })
        send({}, 'stop')
      }

      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

interface Frame {
  kind: string
  data: string
}

function makeSse(): { frames: Frame[]; sse: SseWriter } {
  const frames: Frame[] = []
  const stub = {
    content: (d: string) => void frames.push({ kind: 'content', data: d }),
    thinking: (d: string) => void frames.push({ kind: 'thinking', data: d }),
    tool: (n: string, a: unknown) =>
      void frames.push({ kind: 'tool', data: `${n}(${JSON.stringify(a)})` }),
    toolResult: (n: string) => void frames.push({ kind: 'tool_result', data: n }),
    limit: (n: number) => void frames.push({ kind: 'limit', data: String(n) }),
    status: (p: Record<string, unknown>) => void frames.push({ kind: 'status', data: JSON.stringify(p) }),
    ask: (q: string[], r?: string) =>
      void frames.push({ kind: 'ask', data: JSON.stringify({ questions: q, reason: r }) }),
    done: (e: Record<string, unknown> = {}) => void frames.push({ kind: 'done', data: JSON.stringify(e) }),
    error: (m: string) => void frames.push({ kind: 'error', data: m }),
    close: () => undefined,
  }
  return { frames, sse: stub as unknown as SseWriter }
}

const FAKE_LOG = [
  '[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
  '[12:00:03] [main/ERROR]: java.lang.NoSuchMethodError: net.minecraft.client.Minecraft.resize',
].join('\n')

async function run(steps: Step[]): Promise<{ res: RunResult; frames: Frame[]; requests: string[] }> {
  const model = await startFakeModel(steps)
  const { frames, sse } = makeSse()
  try {
    const res = await runAgent({
      userMessage: '这份日志为什么崩溃？',
      provider: { baseUrl: model.baseUrl, apiKey: 'test', model: 'fake-model' },
      toolContext: createToolContext(FAKE_LOG, 'abc1234'),
      promptContext: { hasLog: true, domainKnowledge: '（测试占位）' },
      maxRounds: 30,
      sse,
    })
    return { res, frames, requests: model.requests }
  } finally {
    await model.close()
  }
}

// ── 用例 ────────────────────────────────────────────────────

test('问完就停：ask_user 之后模型再要调工具时立即终止', async () => {
  const { res, requests } = await run([
    { kind: 'ask' },
    // 模型想继续自检——这一步不该被执行
    { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
    { kind: 'tool', name: 'grep_log_file', args: { query: 'Exception' } },
    { kind: 'content', text: '不该走到这里' },
  ])

  assert.equal(res.ok, true, `应正常结束，实际：${res.error ?? ''}`)
  assert.equal(res.asks.length, 1, '应记录一次提问')

  // 关键：ask_user 之后不应再有工具调用
  const names = res.toolCalls.map((c) => c.name)
  assert.deepEqual(names, ['ask_user'], `ask_user 之后不应执行任何工具，实际：${names.join(', ')}`)

  // 请求数应很少：ask 一轮 + 收尾轮
  assert.ok(
    requests.length <= 3,
    `不应为「问完继续查」多付请求，实际发了 ${requests.length} 次`,
  )
})

test('问完就停：模型没写正文时，兜底正文只交代原因、不复述问题', async () => {
  // 只发 ask，然后立刻又发工具调用——模型始终没写正文
  const { res, frames } = await run([
    { kind: 'ask' },
    { kind: 'tool', name: 'read_log_file', args: { from: 1, to: 10 } },
  ])

  // 用户必须看到原因，而不是一句「分析失败」
  assert.equal(res.ok, true, `应有正文兜底，实际：${res.error ?? ''}`)
  assert.ok(res.content.includes('渲染器兼容性'), `正文应说明提问理由，实际：${res.content.slice(0, 200)}`)

  // 关键：**不复述问题**——问题由 ask 帧下发，正文再说一遍就是重复
  assert.ok(
    !res.content.includes('什么型号'),
    `正文不应复述问题原文，实际：${res.content.slice(0, 200)}`,
  )

  // 追问帧必须已下发（前端据此渲染作答块）
  const askFrame = frames.find((f) => f.kind === 'ask')
  assert.ok(askFrame !== undefined, '应发出 ask 帧')
  assert.ok(askFrame.data.includes('什么型号'), 'ask 帧里才该有问题原文')
})

test('追问轮不评分（没有结论可评，硬评必然低分）', async () => {
  const { res } = await run([
    { kind: 'ask' },
    { kind: 'tool', name: 'read_log_file', args: { from: 1, to: 10 } },
  ])
  assert.equal(res.asks.length, 1)
  assert.equal(
    res.score,
    undefined,
    `追问轮不该有评分，实际给了 ${res.score?.overall ?? '?'} 分`,
  )
})

test('问完就停：给出明确的状态说明，而不是静默中断', async () => {
  const { frames } = await run([
    { kind: 'ask' },
    { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
  ])

  const notice = frames.find(
    (f) => f.kind === 'status' && (f.data.includes('已向你提问') || f.data.includes('等你的回答')),
  )
  assert.ok(notice !== undefined, '应告知用户「已提问、不再继续检索」')
})

test('未提问时不受影响：正常多轮工具检索照旧', async () => {
  const { res } = await run([
    { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
    { kind: 'tool', name: 'grep_log_file', args: { query: 'NoSuchMethodError' } },
    { kind: 'content', text: '根因是模组与游戏版本不匹配。' },
  ])

  assert.equal(res.ok, true)
  assert.equal(res.asks.length, 0)
  assert.equal(res.toolCalls.length, 2, '未提问时工具调用不应被拦截')
})
