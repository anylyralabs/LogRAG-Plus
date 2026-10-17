/**
 * 端到端实测 —— 向本地服务发送真实日志，捕获并解析 SSE 流。
 *
 * 用法:
 *   npx tsx scripts/e2e-test.ts <日志文件> [问题]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = process.env.LOGRAG_URL ?? 'http://127.0.0.1:8788';
const logPath = process.argv[2];
const question = process.argv[3] ?? '请分析这份日志，找出问题所在并给出解决方案。';

if (!logPath) {
  console.error('用法: npx tsx scripts/e2e-test.ts <日志文件> [问题]');
  process.exit(1);
}

const logContent = readFileSync(logPath!, 'utf8');

interface Frame {
  event: string;
  data: string;
}

async function main(): Promise<void> {
  console.log('═══ LogRAG+ 端到端实测 ═══\n');
  console.log(`日志: ${basename(logPath!)}（${logContent.length} 字节 / ${logContent.split('\n').length} 行）`);
  console.log(`问题: ${question}\n`);
  console.log('-'.repeat(74));

  const start = Date.now();
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: question, logContent }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  if (res.body === null) {
    console.error('响应无 body');
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let thinking = '';
  let content = '';
  const tools: Array<{ name: string; args: unknown }> = [];
  const toolResults: Array<{ name: string; summary: string }> = [];
  let errorMsg: string | null = null;
  let done = false;
  let frameCount = 0;

  while (true) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawFrame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (rawFrame.startsWith(':')) continue; // 心跳

      const frame = parseFrame(rawFrame);
      if (frame === null) continue;
      frameCount++;

      handleFrame(frame, {
        onThinking: (d) => { thinking += d; },
        onContent: (d) => { content += d; },
        onTool: (t) => tools.push(t),
        onToolResult: (t) => toolResults.push(t),
        onError: (e) => { errorMsg = e; },
        onDone: () => { done = true; },
      });
    }
  }

  const elapsed = Date.now() - start;

  console.log('\n' + '-'.repeat(74));
  console.log('═══ 执行过程 ═══\n');

  console.log(`工具调用（${tools.length} 次）：`);
  for (const t of tools) {
    console.log(`  · ${t.name}(${JSON.stringify(t.args).slice(0, 110)})`);
  }

  console.log(`\n工具返回（${toolResults.length} 次）：`);
  for (const t of toolResults) {
    console.log(`  → [${t.name}] ${t.summary.slice(0, 130)}`);
  }

  console.log(`\n思维链: ${thinking.length} 字`);
  console.log(`正文:   ${content.length} 字`);
  console.log(`帧数:   ${frameCount}`);
  console.log(`耗时:   ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`结束:   ${done ? 'done 帧正常' : '未收到 done'}${errorMsg !== null ? ` | 错误: ${errorMsg}` : ''}`);

  console.log('\n' + '='.repeat(74));
  console.log('═══ 完整回答 ═══\n');
  console.log(content);

  if (thinking !== '') {
    console.log('\n' + '='.repeat(74));
    console.log('═══ 思维链（前 1500 字）═══\n');
    console.log(thinking.slice(0, 1500));
  }
}

interface FrameHandlers {
  onThinking: (delta: string) => void;
  onContent: (delta: string) => void;
  onTool: (t: { name: string; args: unknown }) => void;
  onToolResult: (t: { name: string; summary: string }) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}

function parseFrame(raw: string): Frame | null {
  let event = '';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function handleFrame(frame: Frame, h: FrameHandlers): void {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    return;
  }

  if (frame.event === 'status') {
    const type = payload['type'];
    if (type === 'thinking' && typeof payload['delta'] === 'string') {
      h.onThinking(payload['delta']);
    } else if (type === 'tool') {
      h.onTool({ name: String(payload['name'] ?? ''), args: payload['arguments'] ?? {} });
    } else if (type === 'tool_result') {
      h.onToolResult({
        name: String(payload['name'] ?? ''),
        summary: String(payload['summary'] ?? ''),
      });
    }
    return;
  }

  if (frame.event === 'done') {
    h.onDone();
    return;
  }

  if (frame.event === 'error') {
    h.onError(String(payload['error'] ?? '未知错误'));
    return;
  }

  // 正文增量
  const choices = payload['choices'] as Array<{ delta?: { content?: string } }> | undefined;
  const delta = choices?.[0]?.delta?.content;
  if (typeof delta === 'string') h.onContent(delta);
}

main().catch((e) => {
  console.error('实测异常:', e);
  process.exit(1);
});
