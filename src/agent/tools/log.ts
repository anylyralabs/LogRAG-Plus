/**
 * 日志工具 —— 在 worker 线程中执行 CPU 密集操作。
 *
 * ## 为什么必须进 worker 线程（实测依据）
 * 10MB 日志上跑一次 grep，Node 主线程**事件循环停顿 1423ms**。期间所有并发请求
 * （含 SSE 心跳）全部冻结。日志分析正是「大文本 + 正则」的 CPU 密集场景，
 * 这是 Node 最不利的负载形态。
 *
 * 对比：PHP(PCRE) 单次 grep 624ms，Node(V8) 57ms——**V8 正则是快的**，
 * 问题不在正则引擎，而在单线程阻塞。因此用 worker 池隔离。
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

/**
 * worker 路径需兼容两种运行方式：
 *  - 开发/测试：直接跑 `.ts`（Node 24 内置类型剥离）
 *  - 生产构建：跑 `tsc` 产出的 `.js`
 * 依据当前模块自身的扩展名推断，避免硬编码。
 */
const SELF_EXT = fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
const WORKER_PATH = fileURLToPath(new URL(`./log-worker${SELF_EXT}`, import.meta.url));

/** 单次工具结果上限（与 LogShare 的 32KB 检索上限一致） */
export const MAX_RESULT_BYTES = 32_000;

export interface GrepOptions {
  pattern: string;
  /** 是否区分大小写（默认否） */
  caseSensitive?: boolean;
  /** 上下文行数 0–5（默认 1） */
  contextLines?: number;
  /** 最大匹配数 1–50（默认 10） */
  maxMatches?: number;
}

export interface GrepMatch {
  line: number;
  text: string;
}

export interface GrepResult {
  ok: boolean;
  /** 格式化后的文本（供模型阅读） */
  text: string;
  matches: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
  error?: string;
}

export interface ReadOptions {
  /** 1-based 起始行 */
  lineStart?: number;
  /** 1-based 结束行（含） */
  lineEnd?: number;
  /** 最大字节数 */
  maxBytes?: number;
}

export interface ReadResult {
  ok: boolean;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  /** 若被截断，下一段的起始行（供续读） */
  nextStart?: number;
  error?: string;
}

interface WorkerRequest {
  id: number;
  op: 'grep' | 'read' | 'listFiles';
  content?: string;
  filename?: string;
  options?: unknown;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/**
 * Worker 池：固定大小的 worker 复用，避免每请求创建线程。
 *
 * 大小取 CPU 核数的一半（下限 1、上限 4）——日志分析是短时突发任务，
 * 过多 worker 会与主线程争抢 CPU。
 */
class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly size: number;
  private nextId = 1;
  private queue: Array<() => void> = [];

  constructor(size: number) {
    this.size = size;
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_PATH);
    worker.on('message', (msg: WorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(msg.error ?? 'worker 执行失败'));
      this.release(worker);
    });
    worker.on('error', (err) => {
      // worker 崩溃：拒绝所有在途请求并重建
      for (const [id, entry] of this.pending) {
        entry.reject(new Error(`worker 崩溃: ${err.message}`));
        this.pending.delete(id);
      }
      this.workers.splice(this.workers.indexOf(worker), 1);
    });
    worker.unref();
    this.workers.push(worker);
    return worker;
  }

  private acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    if (this.workers.length < this.size) return Promise.resolve(this.spawn());
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.idle.pop()!));
    });
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) {
      this.idle.push(worker);
      next();
      return;
    }
    this.idle.push(worker);
  }

  async run<T>(req: Omit<WorkerRequest, 'id'>): Promise<T> {
    const worker = await this.acquire();
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage({ ...req, id } satisfies WorkerRequest);
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

let pool: WorkerPool | null = null;

function getPool(): WorkerPool {
  if (pool === null) {
    const cpus = Number(process.env.AGENT_WORKER_THREADS ?? 0);
    const size = cpus > 0 ? cpus : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
    pool = new WorkerPool(size);
  }
  return pool;
}

function availableParallelism(): number {
  try {
    // Node 18.14+ / 24 提供
    return require('node:os').availableParallelism?.() ?? 4;
  } catch {
    return 4;
  }
}

/** grep：在日志中按正则检索，返回带行号与上下文的匹配 */
export async function grepLog(content: string, options: GrepOptions): Promise<GrepResult> {
  try {
    return await getPool().run<GrepResult>({
      op: 'grep',
      content,
      options,
    });
  } catch (e) {
    return {
      ok: false,
      text: `检索失败：${e instanceof Error ? e.message : String(e)}`,
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** read：读取日志的指定行区间 */
export async function readLog(content: string, options: ReadOptions = {}): Promise<ReadResult> {
  try {
    return await getPool().run<ReadResult>({
      op: 'read',
      content,
      options,
    });
  } catch (e) {
    return {
      ok: false,
      text: `读取失败：${e instanceof Error ? e.message : String(e)}`,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 关闭 worker 池（优雅退出用） */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.close();
    pool = null;
  }
}
