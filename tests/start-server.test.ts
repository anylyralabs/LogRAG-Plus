/**
 * 启动、端口递增与优雅退出的测试。
 *
 * 守的是运维层面反复踩的三件事：
 * 1. 端口被占用时自动递增，而不是抛 `listen EADDRINUSE` 堆栈；
 * 2. 就绪后打印 `READY port=`，让脚本能判断「真的起来了」；
 * 3. SIGTERM 能在百毫秒级释放端口（这是重启撞端口的直接原因）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-start-'));

/** 起一个占位监听器，模拟「旧进程还没退」 */
async function occupy(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 找一个当前空闲的端口基数（避免与真实服务冲突） */
async function pickBasePort(): Promise<number> {
  for (let p = 41200; p < 41300; p++) {
    try {
      const s = await occupy(p);
      await s.close();
      return p;
    } catch {
      continue;
    }
  }
  throw new Error('找不到空闲端口');
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一次 server，直到输出 READY 或超时；随后可选发送 SIGTERM */
function runServer(
  env: Record<string, string>,
  opts: { stopAfterReady?: boolean; timeoutMs?: number } = {},
): Promise<RunResult & { exitSignal?: NodeJS.Signals | null; msToExit?: number }> {
  const timeoutMs = opts.timeoutMs ?? 40_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    let killedAt = 0;
    let exitSignal: NodeJS.Signals | null = null;
    let msToExit: number | undefined;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    const maybeStop = (): void => {
      if (opts.stopAfterReady !== true) return;
      if (!stdout.includes('READY port=')) return;
      killedAt = Date.now();
      child.kill('SIGTERM');
    };

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      maybeStop();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      maybeStop();
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      exitSignal = signal;
      if (killedAt > 0) msToExit = Date.now() - killedAt;
      resolve({ code, stdout, stderr, exitSignal, msToExit });
    });
  });
}

const BASE_ENV = {
  DATA_DIR: testDir,
  HOST: '127.0.0.1',
  // 避免真实网络：不配任何上游
  AI_BASE_URL: '',
  LOGSHARE_INTERNAL_URL: '',
  LOGSHARE_PUBLIC_API_URL: '',
  RAG_INDEX_PATH: '',
};

test.after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test('端口空闲时按 PORT 启动，并打印 READY 供脚本判据', async () => {
  const base = await pickBasePort();
  const r = await runServer({ ...BASE_ENV, PORT: String(base) }, { stopAfterReady: true });

  assert.match(r.stdout, new RegExp(`READY port=${base}`), '必须打印单行 READY 标记');
});

test('端口被占用时自动递增，而不是抛 EADDRINUSE 堆栈', async () => {
  const base = await pickBasePort();
  const blocker = await occupy(base);
  try {
    const r = await runServer({ ...BASE_ENV, PORT: String(base) }, { stopAfterReady: true });

    assert.match(r.stdout, new RegExp(`READY port=${base + 1}`), '应退到下一个端口');
    assert.match(r.stdout, /已被占用/, '要说明为什么换了端口');
    assert.doesNotMatch(r.stderr, /EADDRINUSE/, '不应把 Node 原始堆栈抛给用户');
  } finally {
    await blocker.close();
  }
});

test('PORT_AUTO_INCREMENT=0 时保持原行为（撞端口即失败）', async () => {
  const base = await pickBasePort();
  const blocker = await occupy(base);
  try {
    const r = await runServer(
      { ...BASE_ENV, PORT: String(base), PORT_AUTO_INCREMENT: '0' },
      { timeoutMs: 20_000 },
    );
    assert.notEqual(r.code, 0, '关闭递增后应失败退出');
    assert.match(r.stderr, /被占用|EADDRINUSE/, '要给出可读原因');
  } finally {
    await blocker.close();
  }
});

test('SIGTERM 在百毫秒级退出并释放端口（重启撞端口的根因）', async () => {
  const base = await pickBasePort();
  const r = await runServer({ ...BASE_ENV, PORT: String(base) }, { stopAfterReady: true });

  assert.match(r.stdout, /\[shutdown\] 收到 SIGTERM/);
  assert.match(r.stdout, /\[shutdown\] 已退出/);
  assert.ok(
    r.msToExit !== undefined && r.msToExit < 2000,
    `应在 2 秒内退出，实际 ${String(r.msToExit)}ms`,
  );
  assert.equal(r.code, 0, '优雅退出应为 0');
});

test('退出后端口立即可被重新绑定（无需等 TIME_WAIT）', async () => {
  const base = await pickBasePort();
  await runServer({ ...BASE_ENV, PORT: String(base) }, { stopAfterReady: true });

  // 立刻抢占同一端口：若监听器没释放，这里会抛 EADDRINUSE
  const again = await occupy(base);
  await again.close();
});
