/**
 * SSE 增量解析测试（前端 `src/api/client.ts`）。
 *
 * 这是前端里**最容易出错、又最不显眼**的一段：它把 TCP 上的字节流切成事件。
 * 出错时的表现不是崩溃，而是「正文少了几个字」「工具行时不时消失」
 * 「偶发空白答案」——这类缺陷在浏览器里极难复现，因为分块边界是网络决定的。
 *
 * 因此这里用一个**按字节切块**的假服务端，把边界变成数据：
 * 事件中间切、UTF-8 多字节字符中间切、CRLF、多行 data、心跳注释、
 * 末尾没有空行、未知帧类型、非 SSE 的 JSON 错误。全部在 CI 里可重复。
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ApiError, streamChat } from '../src/api/client.ts';

// 前端在浏览器里用 localStorage 记住「接口基地址」与设置；测试进程里补一个最小实现
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

/** 待下发的响应体与状态码，每个用例自行设置。块可以是 Buffer——用于把字节切在多字节字符中间 */
let nextResponse: { status: number; contentType: string; chunks: Array<string | Buffer> } = {
  status: 200,
  contentType: 'text/event-stream',
  chunks: [],
};

/** 请求体记录：用于断言前端确实把会话 ID / 供应商透传上去了 */
let lastRequest: { body: unknown; headers: Record<string, unknown> } | null = null;

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let body: unknown = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    lastRequest = { body, headers: req.headers as Record<string, unknown> };

    res.writeHead(nextResponse.status, { 'content-type': nextResponse.contentType });
    // 逐块写出，且**每块之间留出一次事件循环**：这样才能真实地
    // 让客户端按块边界解析，而不是一次性拿到完整流。
    let i = 0;
    const writeNext = (): void => {
      if (i >= nextResponse.chunks.length) {
        res.end();
        return;
      }
      res.write(nextResponse.chunks[i] ?? '');
      i += 1;
      setTimeout(writeNext, 1);
    };
    writeNext();
  });
});

let port = 0;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // 让 client.ts 走测试服务端
  store.set('lograg.apiBase', `http://127.0.0.1:${port}`);
});

after(() => {
  server.close();
});

interface Collected {
  statuses: Array<Record<string, unknown>>;
  content: string;
  done: Array<Record<string, unknown>>;
  errors: string[];
}

async function run(chunks: Array<string | Buffer>): Promise<Collected> {
  nextResponse = { status: 200, contentType: 'text/event-stream', chunks };
  const out: Collected = { statuses: [], content: '', done: [], errors: [] };
  await streamChat(
    { message: '为什么会崩？' },
    {
      onStatus: (p) => out.statuses.push(p as unknown as Record<string, unknown>),
      onContent: (d) => {
        out.content += d;
      },
      onDone: (p) => out.done.push(p as unknown as Record<string, unknown>),
      onError: (m) => out.errors.push(m),
    },
  );
  return out;
}

// ── 帧解析 ──────────────────────────────────────────────

test('状态帧、正文增量与 done 帧按顺序还原', async () => {
  const out = await run([
    'event: status\ndata: {"type":"tool","name":"grep_log_file","arguments":{"query":"ERROR"}}\n\n',
    'data: {"choices":[{"delta":{"content":"先看"}}]}\n\n',
    'event: status\ndata: {"type":"tool_result","name":"grep_log_file","summary":"3 处命中"}\n\n',
    'data: {"choices":[{"delta":{"content":"错误行"}}]}\n\n',
    'event: done\ndata: {"status":"completed","sessionId":"sess_1","remaining":7}\n\n',
  ]);

  assert.equal(out.statuses.length, 2);
  assert.deepEqual(out.statuses[0], {
    type: 'tool',
    name: 'grep_log_file',
    arguments: { query: 'ERROR' },
  });
  assert.equal(out.statuses[1]?.['type'], 'tool_result');
  assert.equal(out.content, '先看错误行');
  assert.deepEqual(out.done, [{ status: 'completed', sessionId: 'sess_1', remaining: 7 }]);
  assert.deepEqual(out.errors, []);
});

test('事件被切成两半、且切在多字节汉字中间，正文仍逐字还原', async () => {
  // 「崩」的 UTF-8 是 3 字节；这里从它的第 2 个字节之后切开，
  // 于是客户端第一次 read 拿到的是**半个字符**。
  // 若解析器没有用 TextDecoder({ stream: true }) 累积残字节，
  // 这里会得到 U+FFFD 替换符——线上表现为「答案里混着乱码方块」，
  // 而且只在特定网络分块下出现，几乎不可能手工复现。
  const payload = 'data: {"choices":[{"delta":{"content":"崩溃原因"}}]}\n\n';
  const bytes = Buffer.from(payload, 'utf8');
  const at = bytes.indexOf(Buffer.from('崩', 'utf8'));
  assert.ok(at > 0, '夹具应包含目标汉字');

  const out = await run([bytes.subarray(0, at + 2), bytes.subarray(at + 2)]);

  assert.equal(out.content, '崩溃原因');
  assert.ok(!out.content.includes('\uFFFD'), '不得出现替换符');
});

test('CRLF 行结束符与心跳注释行都能正确处理', async () => {
  const out = await run([
    ': ping\r\n\r\n',
    'event: status\r\ndata: {"type":"thinking","delta":"分析中"}\r\n\r\n',
    ': keep-alive\n\n',
    'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]);

  assert.equal(out.statuses.length, 1);
  assert.equal(out.statuses[0]?.['delta'], '分析中');
  assert.equal(out.content, '结论');
  assert.equal(out.done.length, 1);
});

test('多行 data 按 SSE 规范以换行拼接', async () => {
  // 服务端目前不这么发，但网关/代理可能改写分帧；这条守的是「不要想当然按单行解析」
  const out = await run([
    'event: status\ndata: {"type":"thinking",\ndata: "delta":"分段"}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]);
  assert.equal(out.statuses.length, 1);
  assert.equal(out.statuses[0]?.['delta'], '分段');
});

test('末尾事件没有补空行也会被处理', async () => {
  const out = await run(['event: done\ndata: {"status":"completed"}']);
  assert.equal(out.done.length, 1);
});

test('未知帧类型不会中断整条流（前向兼容）', async () => {
  const out = await run([
    'event: status\ndata: {"type":"未来新增的类型","whatever":1}\n\n',
    'data: {"choices":[{"delta":{"content":"仍然可用"}}]}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]);

  assert.equal(out.statuses.length, 1);
  assert.equal(out.content, '仍然可用');
  assert.equal(out.done.length, 1);
});

test('单个坏块被跳过，不影响后续内容', async () => {
  const out = await run([
    'data: 这不是 JSON\n\n',
    'data: {"choices":[{"delta":{"content":"后续内容还在"}}]}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]);
  assert.equal(out.content, '后续内容还在');
  assert.equal(out.done.length, 1);
});

test('服务端 error 帧走 onError，不抛异常', async () => {
  const out = await run(['event: error\ndata: {"error":"上游模型不可用"}\n\n']);
  assert.deepEqual(out.errors, ['上游模型不可用']);
  assert.deepEqual(out.done, []);
});

test('空正文增量被忽略（不发无意义的空事件）', async () => {
  const out = await run([
    'data: {"choices":[{"delta":{"content":""}}]}\n\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]);
  assert.equal(out.content, '');
});

// ── 非流式错误：这是「转了圈然后什么都没有」的根因 ─────

test('推流前失败：429 抛 ApiError 且带服务端文案（配额用尽必须能被识别）', async () => {
  nextResponse = {
    status: 429,
    contentType: 'application/json; charset=utf-8',
    chunks: ['{"ok":false,"error":"今日分析次数已用完，请明天再试"}'],
  };

  await assert.rejects(
    () => streamChat({ message: 'x' }, {}),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 429);
      assert.match(e.message, /次数已用完/);
      return true;
    },
  );
});

test('content-type 不是 event-stream 时按 JSON 错误处理，不误当流解析', async () => {
  nextResponse = {
    status: 200,
    contentType: 'application/json',
    chunks: ['{"ok":false,"error":"路由不存在"}'],
  };

  await assert.rejects(() => streamChat({ message: 'x' }, {}), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    return true;
  });
});

// ── 请求体构造 ──────────────────────────────────────────

test('请求体原样透传：会话延续与自定义供应商都靠它', async () => {
  nextResponse = {
    status: 200,
    contentType: 'text/event-stream',
    chunks: ['event: done\ndata: {"status":"completed"}\n\n'],
  };
  await streamChat(
    {
      message: '继续',
      logId: 'kalkLqQ',
      sessionId: 'sess_9',
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm1' },
    },
    {},
  );

  const body = lastRequest?.body as Record<string, unknown>;
  assert.equal(body['message'], '继续');
  assert.equal(body['logId'], 'kalkLqQ');
  assert.equal(body['sessionId'], 'sess_9');
  assert.deepEqual(body['provider'], {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    model: 'm1',
  });
  assert.match(String(lastRequest?.headers['accept']), /text\/event-stream/);
  // `fingerprint` 由上层 store 补齐（客户端的职责只是别把它丢掉）：
  // 这里断言「不凭空造字段」，避免客户端与 store 各造一套配额标识。
  assert.equal('fingerprint' in body, false);
});
