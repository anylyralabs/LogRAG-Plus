/**
 * Agent 主循环的端到端回归（用假模型端点跑，不依赖外部模型服务）。
 *
 * ## 为什么必须存在
 *
 * 2026-10-17 第一次端到端真跑（`kalkLqQ`，259KB 的 axolotl 日志）暴露了四个
 * 致命缺陷，全部位于「模型流 → 工具调用 → SSE」这条链路上，而当时**一个
 * 自动化测试都没有**——它们只能靠真模型手工跑出来：
 *
 * | 缺陷 | 表现 |
 * |---|---|
 * | 轮次按两倍计数 | `maxRounds: 30` 实际只允许 15 次调用，16 次就撞顶 |
 * | 撞顶即空输出 | 30 轮成果全丢，回「288 事件 / 0 字答案 / 自评 23 分 / 却报 completed」 |
 * | `tool` 帧参数恒为 `{}` | 分片路径在参数占位 `{}` 时提前宣告，16 次调用全部无参数 |
 * | 截断无重试 | 只出思维链不出正文时直接失败 |
 *
 * 真模型不可用于 CI（要钱、要网络、输出不确定）。但这条链路的**触发条件**
 * 是确定的：只要按 OpenAI 兼容协议下发分片的 `tool_calls`，就能复现全部四种
 * 情形。于是这里起一个假端点，把「模型说什么」变成数据。
 *
 * 假端点按**真实端点的行为**下发参数——分片、且分片边界刻意切在 JSON 中间，
 * 因为「参数恒为 `{}`」这个缺陷只在分片路径上出现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runAgent } from '../src/agent/runner.ts';
import type { RunResult } from '../src/agent/runner.ts';
import { createToolContext } from '../src/agent/tools/index.ts';
import type { SseWriter } from '../src/server/sse.ts';

// ── 假模型端点 ───────────────────────────────────────────────

/** 一步脚本：这一次模型请求返回什么 */
type Step =
  | { kind: 'tool'; name: string; args: unknown }
  | { kind: 'content'; text: string }
  /** 只有思维链、没有正文（模拟上游流截断） */
  | { kind: 'reasoning'; text: string };

interface FakeModel {
  baseUrl: string;
  /** 收到的原始请求体（按序），用于断言发给模型的是什么 */
  requests: string[];
  close: () => Promise<void>;
}

/** 把参数切成 7 字节一片，刻意为难分片拼接（真实端点同样会把 JSON 切开） */
function fragments(json: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < json.length; i += 7) out.push(json.slice(i, i + 7));
  return out;
}

async function startFakeModel(steps: Step[]): Promise<FakeModel> {
  const requests: string[] = [];
  let cursor = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));

      // 脚本用尽后重复最后一步，避免测试因请求次数估算偏差而挂起
      const step = steps[Math.min(cursor, steps.length - 1)]!;
      cursor += 1;
      const requestNo = cursor;

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
        res.write(
          `data: ${JSON.stringify({
            // ⚠️ `id` 必须**每个响应都不同**。
            //
            // LangChain 把 completion 的 `id` 直接当作 `AIMessage.id`，而 LangGraph
            // 的消息归约是**按 id 就地覆盖**而非追加。若假端点固定复用同一个 id
            // （最初写成 `id: 'x'` 时就踩了这个坑），第二轮模型回复会覆盖掉第一轮
            // 那条 AI 消息、停在原地，状态末尾仍是上一条 ToolMessage，条件边据此
            // 判定「没有工具调用」而直接结束——表现为「agent 跑了 2 轮就无声停止」。
            //
            // 真实 OpenAI 兼容端点每次都返回唯一 id，所以这是**假端点的保真度要求**，
            // 不是产品缺陷。记在这里是因为它的症状极容易被误读成 agent 的 bug。
            id: `chatcmpl-fake-${requestNo}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      };

      if (step.kind === 'tool') {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requestNo}`,
              type: 'function',
              function: { name: step.name, arguments: '' },
            },
          ],
        });
        for (const piece of fragments(JSON.stringify(step.args))) {
          send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
        }
        send({}, 'tool_calls');
      } else if (step.kind === 'content') {
        // 正文也分片：验证流式净化器不会吞掉或粘连内容
        const cut = Math.ceil(step.text.length / 2);
        send({ role: 'assistant', content: step.text.slice(0, cut) });
        send({ content: step.text.slice(cut) });
        send({}, 'stop');
      } else {
        send({ role: 'assistant', reasoning_content: step.text });
        send({}, 'stop');
      }

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── 假 SSE 收集器 ────────────────────────────────────────────

interface Frame {
  kind: string;
  data: string;
}

function makeSse(): { frames: Frame[]; sse: SseWriter } {
  const frames: Frame[] = [];
  const stub = {
    isClosed: false,
    content: (d: string) => void frames.push({ kind: 'content', data: d }),
    thinking: (d: string) => void frames.push({ kind: 'thinking', data: d }),
    tool: (name: string, args: unknown) =>
      void frames.push({ kind: 'tool', data: `${name}(${JSON.stringify(args)})` }),
    toolResult: (name: string) => void frames.push({ kind: 'tool_result', data: name }),
    limit: (n: number) => void frames.push({ kind: 'limit', data: String(n) }),
    status: (p: Record<string, unknown>) => void frames.push({ kind: 'status', data: JSON.stringify(p) }),
    done: (e: Record<string, unknown> = {}) => void frames.push({ kind: 'done', data: JSON.stringify(e) }),
    error: (m: string) => void frames.push({ kind: 'error', data: m }),
    close: () => undefined,
  };
  return { frames, sse: stub as unknown as SseWriter };
}

// ── 测试用的极小日志 ─────────────────────────────────────────

const FAKE_LOG = [
  '[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Forge 47.4.23',
  '[12:00:01] [main/INFO]: Loading 1 mods:',
  '[12:00:02] [main/INFO]: \tcloth_config 11.1.136',
  '[12:00:03] [main/ERROR]: Missing or unsupported mandatory dependencies:',
  "\tMod ID: 'spatial_gui', Requested by: 'zzz', Expected range: '[1.0,)', Actual version: '[MISSING]'",
].join('\n');

interface RunOutcome {
  res: RunResult;
  frames: Frame[];
  requests: string[];
}

async function runWithSteps(steps: Step[], maxRounds: number): Promise<RunOutcome> {
  const model = await startFakeModel(steps);
  const { frames, sse } = makeSse();
  try {
    const res = await runAgent({
      userMessage: '帮我看看这份日志为什么启动不了',
      provider: { baseUrl: model.baseUrl, apiKey: 'test', model: 'fake-model' },
      toolContext: createToolContext(FAKE_LOG, 'abc1234'),
      // 显式给领域知识，避免测试进程去读库（那会引入非确定性）
      promptContext: { hasLog: true, domainKnowledge: '（测试占位，仅为跳过读库）' },
      maxRounds,
      sse,
    });
    return { res, frames, requests: model.requests };
  } finally {
    await model.close();
  }
}

// ── 用例 ─────────────────────────────────────────────────────

test('撞轮次上限必须产出结论（回归：288 事件 / 0 字答案 却报 completed）', async () => {
  const answer = '根因是 spatial_gui 依赖的 cloth_config 版本不满足要求，请安装匹配版本后重试。';
  const { res, frames, requests } = await runWithSteps(
    [
      { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR', context_lines: 1 } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'Missing' } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'mods.toml' } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'cloth' } },
      { kind: 'content', text: answer },
    ],
    3,
  );

  assert.equal(res.ok, true, `撞顶后必须仍拿到结论，实际 error=${res.error ?? '(无)'}`);
  assert.ok(res.content.includes('cloth_config'), '最终交付的是收尾轮的正文');
  assert.equal(res.hitLimit, true, '应标记为「撞过上限」，看板要靠它区分');

  // ── 轮次不得双计 ────────────────────────────────────────
  // 旧缺陷下 maxRounds=3 只允许 2 次调用（每次记两轮）。这里必须是 4。
  assert.equal(res.rounds, 4, 'maxRounds=3 时应恰好允许 4 次调用后才判定撞顶');
  assert.equal(res.toolCalls.length, 3, '应真实执行了 3 次工具');

  // ── 收尾轮必须真的是一次「无工具」调用 ──────────────────
  assert.equal(
    requests.length,
    5,
    '4 次工具轮 + 1 次收尾轮。多出来就说明撞顶 break 之后底层图没停、又发了一次没人消费的请求（实测发生过）',
  );
  const synthesisBody = requests[requests.length - 1]!;
  assert.ok(
    synthesisBody.includes('工具调用上限') && synthesisBody.includes('无法再检索'),
    '收尾轮应携带「工具已关闭」的明确指令，否则模型会继续试探着调工具',
  );

  // 断言「工具已关闭」不是一句空话：收尾轮的请求体里**不能**出现任何工具定义。
  //
  // 实测缺陷：原实现只把 `tools` 传空、撤掉自己的 filesystem 中间件，但
  // `createDeepAgent` 会把内置中间件装回来，收尾轮实际带着
  // `ls, read_file, write_file, edit_file, delete, glob, grep, task` 八件套——
  // 模型仍能写文件，甚至能调 `task` 拉起子 agent 把整个分析重跑一遍。
  const synthesisReq = JSON.parse(synthesisBody) as { tools?: unknown[] };
  assert.equal(
    (synthesisReq.tools ?? []).length,
    0,
    `收尾轮不得携带任何工具定义，实际：${JSON.stringify((synthesisReq.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name))}`,
  );

  // ── SSE 帧必须让用户看到发生了什么 ──────────────────────
  const limitIdx = frames.findIndex((f) => f.kind === 'limit');
  assert.ok(limitIdx >= 0, '必须下发 limit 帧');
  const reflectIdx = frames.findIndex(
    (f) => f.kind === 'status' && f.data.includes('reflection'),
  );
  assert.ok(reflectIdx >= 0, '必须告知用户「已改用已获取的信息给出结论」');

  const firstContentAfter = frames.findIndex(
    (f, i) => i > reflectIdx && f.kind === 'content',
  );
  assert.ok(
    firstContentAfter > reflectIdx,
    '正文必须在提示之后才出现——顺序反了用户会以为分析已经结束',
  );
});

test('tool 帧必须带真实参数（回归：args 恒为 {}）', async () => {
  const { frames, res } = await runWithSteps(
    [
      { kind: 'tool', name: 'grep_log_file', args: { query: 'mandatory', context_lines: 2 } },
      { kind: 'content', text: '我看到强制依赖缺失。' },
    ],
    5,
  );

  const toolFrames = frames.filter((f) => f.kind === 'tool');
  assert.ok(toolFrames.length >= 1, '至少应宣告一次工具调用');
  for (const f of toolFrames) {
    assert.ok(
      f.data.includes('"query"'),
      `工具帧丢失了参数（旧缺陷：分片路径提前用 {} 宣告），实际：${f.data}`,
    );
  }

  const emitted = toolFrames[0]!.data;
  assert.ok(
    emitted.includes('mandatory') && emitted.includes('"context_lines":2'),
    `参数应原样还原，实际：${emitted}`,
  );

  // 落档的工具调用同样要有参数（评分与回溯要用它）
  assert.ok(res.toolCalls.length >= 1);
  for (const c of res.toolCalls) {
    assert.ok(
      c.args !== null && typeof c.args === 'object' && Object.keys(c.args).length > 0,
      `落档的工具参数为空：${JSON.stringify(c.args)}`,
    );
  }
});

test('收尾轮仍无正文时如实报失败，绝不伪装成功', async () => {
  const { res } = await runWithSteps(
    [
      { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
      { kind: 'tool', name: 'grep_log_file', args: { query: 'ERROR' } },
      // 收尾轮只给思维链不给正文
      { kind: 'reasoning', text: '我思考了很久…' },
    ],
    3,
  );

  assert.equal(res.ok, false, '空正文必须是失败——「23 分的空答案」比报错更伤用户');
  assert.equal(res.content.trim(), '');
  assert.ok(res.error !== undefined && res.error !== '', '必须带可读的失败原因');
  assert.ok(res.hitLimit, '仍应保留「撞过上限」这个事实供观测');
});

test('上游截断（只出思维链）自动重试一次', async () => {
  const { res, frames, requests } = await runWithSteps(
    [
      { kind: 'reasoning', text: '先看看日志…' },
      { kind: 'content', text: '结论：clot​h_config 版本不匹配。' },
    ],
    5,
  );

  assert.equal(res.ok, true, '重试后应拿到正文');
  assert.equal(requests.length, 2, '应恰好重试一次');
  assert.ok(
    frames.some((f) => f.kind === 'status' && f.data.includes('重试')),
    '重试必须告知用户，否则表现为长时间无响应',
  );
  assert.ok(res.content.includes('版本不匹配'));
});

test('未撞顶时不做收尾轮（省一次调用、不改变交付内容）', async () => {
  const { res, requests } = await runWithSteps(
    [{ kind: 'content', text: '这份日志没有错误特征，启动正常。' }],
    5,
  );

  assert.equal(res.ok, true);
  assert.equal(res.hitLimit, false);
  assert.equal(requests.length, 1, '不该凭空多一次模型调用');
  assert.equal(res.rounds, 0);
});
