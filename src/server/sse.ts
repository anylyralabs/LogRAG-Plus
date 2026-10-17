/**
 * SSE 输出。
 *
 * ## 与 LogShare 的协议兼容
 * 前端已按 LogShare 的帧格式解析（见其 `API.md`），本服务**必须产出相同格式**，
 * 否则前端需同步改造。帧格式：
 *
 * ```
 * event: status
 * data: {"type":"thinking","delta":"..."}     ← 思维链增量
 *
 * event: status
 * data: {"type":"tool","name":"rag_search","arguments":{...}}
 *
 * event: status
 * data: {"type":"tool_result","name":"rag_search","summary":"...","truncated":true}
 *
 * data: {"choices":[{"delta":{"content":"..."}}]}   ← 正文增量（无 event 行）
 *
 * event: done
 * data: {"status":"completed"}
 *
 * event: error
 * data: {"error":"..."}
 * ```
 */

import type { ServerResponse } from 'node:http';

export type StatusType = 'thinking' | 'tool' | 'tool_result' | 'limit' | 'queued' | 'reflection';

export interface SseWriterOptions {
  /** 心跳间隔（毫秒）；0 表示关闭 */
  heartbeatMs?: number;
}

export class SseWriter {
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;

  private readonly res: ServerResponse;
  private readonly heartbeatMs: number;

  constructor(res: ServerResponse, options: SseWriterOptions = {}) {
    this.res = res;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 禁用 Nginx 缓冲，保证逐帧到达
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });

    // 立即冲刷头部
    res.flushHeaders?.();

    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        if (this.closed) return;
        try {
          // SSE 注释帧：客户端忽略，但保持连接活跃
          this.res.write(': heartbeat\n\n');
        } catch {
          this.close();
        }
      }, this.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  /** 客户端是否已断开 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 正文增量（与 OpenAI 兼容格式，前端按 choices[0].delta.content 解析） */
  content(delta: string): void {
    if (delta === '' || this.closed) return;
    this.write('', JSON.stringify({ choices: [{ delta: { content: delta } }] }));
  }

  /** 思维链增量 */
  thinking(delta: string): void {
    if (delta === '' || this.closed) return;
    this.status({ type: 'thinking', delta });
  }

  /** 即将调用工具 */
  tool(name: string, args: unknown): void {
    this.status({ type: 'tool', name, arguments: args });
  }

  /** 工具返回摘要 */
  toolResult(name: string, summary: string, truncated = false): void {
    this.status({ type: 'tool_result', name, summary, truncated });
  }

  /** 达到轮次上限 */
  limit(rounds: number): void {
    this.status({ type: 'limit', rounds });
  }

  /** 通用 status 帧 */
  status(payload: Record<string, unknown>): void {
    if (this.closed) return;
    this.write('status', JSON.stringify(payload));
  }

  /** 正常结束 */
  done(extra: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.write('done', JSON.stringify({ status: 'completed', ...extra }));
    this.close();
  }

  /** 异常结束（消息原样下发，与 LogShare 行为一致） */
  error(message: string): void {
    if (this.closed) return;
    this.write('error', JSON.stringify({ error: message }));
    this.close();
  }

  /** 关闭连接 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.res.end();
    } catch {
      /* 客户端可能已断开 */
    }
  }

  private write(event: string, data: string): void {
    if (this.closed) return;
    try {
      const frame = event === '' ? `data: ${data}\n\n` : `event: ${event}\ndata: ${data}\n\n`;
      this.res.write(frame);
    } catch {
      // 写入失败通常意味着客户端断开
      this.closed = true;
      if (this.heartbeat !== null) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    }
  }
}
