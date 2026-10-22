/**
 * 追问（`ask_user`）端到端守门。
 *
 * ## 守的是什么
 * 追问必须是**可回答且可恢复**的：
 *  1. 模型调用 `ask_user` 时，问题要随 SSE 帧下发（前端才能渲染成输入块）；
 *  2. 问题要随消息落库（刷新、换设备后仍能回答）；
 *  3. 用户回答后，模型下一轮能在历史里读到这段问答。
 *
 * 之前只把问题写在正文里：模型会用不同措辞重述，前端无法稳定解析；
 * 刷新后更是彻底消失——「AI 反问你」变成一次性提示。
 *
 * ## 怎么测（不调真实模型）
 * 用假 OpenAI 端点让模型**真的发起**一次 `ask_user` 工具调用，走完整 Agent 环路，
 * 然后断言 SSE 与回放接口里的结构化字段。假端点的写法与
 * `tests/agent-loop.test.ts` 一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-ask-'));

/* ── 假模型端点 ────────────────────────────────────────────
 * 第一轮：发起 ask_user 工具调用
 * 第二轮：看到工具结果后给出结论（正文 + 结构化 JSON）
 */
let callCount = 0;

const fakeModel: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('end', () => {
    callCount++;
    const requestNo = callCount;

    /**
     * 用**请求体**判断该走哪一支，而不是看第几次调用。
     *
     * 测试之间共享同一个假端点；按调用次数判断会让第二个用例一上来就跳过
     * 工具调用（因为它已经是第 2 次请求），断言随之失真。真实端点的行为只
     * 取决于「上下文里有没有工具结果」，这里如实模拟。
     */
    const hasToolResult = body.includes('"role":"tool"');
    const wantsConclusion = body.includes('直接给结论');
    const askFirst = !hasToolResult && !wantsConclusion;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    /**
     * 每个响应必须有唯一 `id`。
     *
     * LangChain 把 completion 的 `id` 当作 `AIMessage.id`，而 LangGraph 的消息
     * 归约按 id 就地覆盖。固定 id 会让第二轮覆盖第一轮，表现为 agent「无声停止」。
     * 这是假端点的保真度要求，不是产品缺陷（见 tests/agent-loop.test.ts 的说明）。
     */
    const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-ask-${requestNo}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };

    if (askFirst) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_ask_${requestNo}`,
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                questions: ['你的手机是什么型号？', '启动器里用的是哪个渲染器？'],
                reason: '渲染器兼容性依赖具体 GPU，日志里没有记录',
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 第二轮：给出正文 + 结尾 JSON 块
    const answer = [
      '需要先确认设备与渲染器，才能判断是驱动问题还是配置问题。',
      '',
      '```json',
      JSON.stringify({
        rootCause: '缺少设备信息，暂时无法确定根因',
        confidence: 0.4,
        evidence: [],
        steps: ['先提供手机型号与渲染器名称'],
      }),
      '```',
    ].join('\n');

    const cut = Math.ceil(answer.length / 2);
    send({ role: 'assistant', content: answer.slice(0, cut) });
    send({ content: answer.slice(cut) });
    send({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

let modelOrigin = '';
let serviceOrigin = '';
let service: Server;

test.before(async () => {
  await new Promise<void>((resolve) => fakeModel.listen(0, '127.0.0.1', () => resolve()));
  const addr = fakeModel.address();
  if (addr === null || typeof addr === 'string') throw new Error('假模型端口不可用');
  modelOrigin = `http://127.0.0.1:${addr.port}/v1`;

  process.env['DATA_DIR'] = testDir;
  process.env['LOGSHARE_INTERNAL_URL'] = '';
  process.env['LOGSHARE_PUBLIC_API_URL'] = '';
  // 服务端默认供应商指向假端点：请求里不带 provider 也能走通
  process.env['AI_BASE_URL'] = modelOrigin;
  process.env['AI_MODEL'] = 'fake-model';
  process.env['AI_API_KEY'] = 'test-key';
  // 关掉量化阈值之类无关配置，保持输出确定性
  process.env['AGENT_MAX_ROUNDS'] = '6';

  const { createHttpServer } = await import('../src/server/index.ts');
  service = createHttpServer();
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', () => resolve()));
  const a = service.address();
  if (a === null || typeof a === 'string') throw new Error('服务端口不可用');
  serviceOrigin = `http://127.0.0.1:${a.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  const { closeStore } = await import('../src/store/session.ts');
  closeStore();
  rmSync(testDir, { recursive: true, force: true });
});

/** 发一轮对话，返回原始 SSE 文本 */
async function chat(message: string, sessionId?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${serviceOrigin}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      message,
      ...(sessionId !== undefined ? { sessionId } : {}),
      fingerprint: 'fp_ask_test',
    }),
  });
  return { status: res.status, text: await res.text() };
}

/** 从 SSE 文本里挑出某类帧 */
function frames(text: string, event: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    if (ev !== event) continue;
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      out.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      /* 损坏帧跳过 */
    }
  }
  return out;
}

test('模型调用 ask_user 时下发结构化追问帧', async () => {
  const { status, text } = await chat('我的游戏崩溃了');
  assert.equal(status, 200);
  if (!text.includes('event: done')) {
    console.error('--- SSE DEBUG ---\n' + text.slice(0, 3000));
  }

  const statusFrames = frames(text, 'status');
  const askFrames = statusFrames.filter((f) => f['type'] === 'ask');
  assert.equal(askFrames.length, 1, `应有一个 ask 帧，实际状态帧：${JSON.stringify(statusFrames)}`);

  const ask = askFrames[0]!;
  assert.deepEqual(ask['questions'], ['你的手机是什么型号？', '启动器里用的是哪个渲染器？']);
  assert.equal(ask['reason'], '渲染器兼容性依赖具体 GPU，日志里没有记录');

  // done 帧也带一份：代理缓冲可能合并/丢弃 status 帧，前端有兜底
  const done = frames(text, 'done')[0];
  assert.ok(done !== undefined, '应有 done 帧');
  const doneAsks = done['asks'] as Array<{ questions: string[] }> | undefined;
  assert.equal(doneAsks?.[0]?.questions.length, 2);
});

test('追问随消息落库：会话回放带 meta.asks', async () => {
  const { text } = await chat('再问一次设备信息');
  const done = frames(text, 'done')[0];
  const sessionId = String(done?.['sessionId'] ?? '');
  assert.ok(sessionId.startsWith('s'), 'done 帧必须带 sessionId');

  const res = await fetch(`${serviceOrigin}/v1/session/${encodeURIComponent(sessionId)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    messages: Array<{ role: string; meta?: { asks?: Array<{ questions: string[] }> } }>;
  };

  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant !== undefined, '应有助手消息');
  assert.equal(assistant.meta?.asks?.[0]?.questions.length, 2);
});

test('没有追问的轮次不写空 meta（不制造空壳）', async () => {
  // 第二次请求时 callCount 已 >1，假端点直接给正文、不再调工具
  const { text } = await chat('直接给结论');
  const done = frames(text, 'done')[0];
  const sessionId = String(done?.['sessionId'] ?? '');

  const res = await fetch(`${serviceOrigin}/v1/session/${encodeURIComponent(sessionId)}`);
  const body = (await res.json()) as {
    messages: Array<{ role: string; meta?: unknown }>;
  };
  const last = [...body.messages].reverse().find((m) => m.role === 'assistant');
  assert.equal(last?.meta, undefined);
});
