/**
 * 启动与关闭。
 *
 * 三件事在这里收口：**端口占用时自动递增**、**优雅退出**、**就绪即报**。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describeConfig, server as serverCfg } from '../config.ts';
import { closeStore } from '../store/session.ts';
import { createHttpServer, startSessionCleanup } from './index.ts';
import { webBuilt, webDir } from './static.ts';

/** 端口被占用时最多往后试几个（PORT_AUTO_INCREMENT=0 关闭该行为） */
const MAX_PORT_TRIES = 20;

/** 是否允许自动递增（配置集中在 config.ts，守门测试要求如此） */
const autoIncrement = serverCfg.portAutoIncrement;

let started: Server | null = null;
let shuttingDown = false;

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 启动。端口被占用时自动往后找（PORT、PORT+1、…）。
 *
 * 为什么要自动递增：Termux 上重启服务时，旧进程常因为还在关闭 SQLite/协程
 * 而**滞后退出**（kill 之后端口最长占用数秒）。此时新进程拿到 EADDRINUSE，
 * 而错误栈里只有 Node 的 `listen EADDRINUSE`，看不出「是上一个我在退」。
 * 递增既让重启不失败，也把真实端口打进日志，避免「启动了但连着旧实例」。
 */
export async function startServer(): Promise<Server> {
  const basePort = serverCfg.port;
  const host = serverCfg.host;
  const tries = autoIncrement ? MAX_PORT_TRIES : 1;

  let lastError: NodeJS.ErrnoException | null = null;

  for (let i = 0; i < tries; i++) {
    const port = basePort + i;
    const server = createHttpServer();
    try {
      await listenOnce(server, port, host);
      started = server;
      // 先装信号处理再打印 READY：外部脚本以 READY 为「可以操作了」的依据，
      // 若那时信号还没接上，紧接着的一次 `kill` 会走 Node 默认行为（滞后退出）
      installShutdownHandlers(server);
      startSessionCleanup();
      onListening(server, port, host, i);
      return server;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      lastError = err;
      if (err.code !== 'EADDRINUSE') {
        // 非端口占用（如权限、地址不可用）递增没有意义，直接抛出
        throw err;
      }
      if (i === 0) {
        // 走 stdout：这是启动状态的一部分，和横幅同一处让人看到；
        // 走 stderr 会被 `> log 2>&1` 之外的调用方漏掉（实测踩过）
        console.log(`⚠ 端口 ${port} 已被占用，尝试后续端口…`);
      }
    }
  }

  throw new Error(
    `端口 ${basePort}–${basePort + tries - 1} 全部被占用。` +
      `请先停止旧进程（ps -ef | grep server.js），或设置 PORT 指定其它端口。` +
      `最后一个错误：${lastError?.message ?? '未知'}`,
  );
}

function onListening(server: Server, port: number, host: string, offset: number): void {
  const addr = server.address() as AddressInfo | null;
  const real = addr?.port ?? port;
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  console.log('═══ LogRAG+ 服务已启动 ═══');
  console.log(`  server             ${host}:${real}${offset > 0 ? `（原 ${port - offset} 被占用）` : ''}`);
  for (const [k, v] of Object.entries(describeRuntime())) {
    // server 已由上一行打印真实端口，跳过配置里的名义端口
    if (k === 'server') continue;
    console.log(`  ${k.padEnd(18)} ${String(v)}`);
  }
  console.log(`\n  监听: http://${shownHost}:${real}`);
  console.log(`  健康检查: http://${shownHost}:${real}/health`);
  console.log(
    webBuilt()
      ? `  前端页面: http://${shownHost}:${real}/logshare/（产物目录 ${webDir()}）`
      : '  前端页面: 未布置（本仓库不含前端；用 WEB_DIR 指向前端产物即可挂到 /logshare/）',
  );
  // 给脚本用的单行标记：重启脚本据此判断「真的起来了」，而不是 grep 人类可读横幅
  console.log(`READY port=${real}`);
  console.log('');
}

/** 运行时配置摘要（启动横幅） */
function describeRuntime(): Record<string, unknown> {
  return describeConfig();
}

/**
 * 优雅退出。
 *
 * 原先**没有任何信号处理**：`kill` 之后靠 Node 默认行为退出，进程常滞后数秒
 * 才释放端口，于是紧接着的重启必然撞 EADDRINUSE。这里显式关闭：
 * 停止接新连接 → 关 SQLite → 关 worker 池 → 退出。
 */
function installShutdownHandlers(server: Server): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    // 二次信号直接硬退，避免「卡在关闭上」永远退不掉
    process.once('SIGTERM', () => process.exit(1));
    process.once('SIGINT', () => process.exit(1));

    console.log(`\n[shutdown] 收到 ${signal}，正在关闭…`);

    const deadline = setTimeout(() => {
      console.error('[shutdown] 关闭超时（5s），强制退出');
      process.exit(1);
    }, 5000);
    deadline.unref();

    server.close(() => {
      void finish();
    });

    // 已建立的 keep-alive 连接不会自己断，主动掐掉，否则 close 回调可能永不触发
    server.closeAllConnections?.();

    const finish = async (): Promise<void> => {
      try {
        closeStore();
      } catch {
        /* 关闭失败不阻断退出 */
      }
      try {
        const { closePool } = await import('../agent/tools/log.ts');
        await closePool();
      } catch {
        /* 同上 */
      }
      clearTimeout(deadline);
      console.log('[shutdown] 已退出');
      process.exit(0);
    };
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/** 供测试或上层脚本主动关闭 */
export async function stopServer(): Promise<void> {
  if (started === null) return;
  const s = started;
  started = null;
  await new Promise<void>((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections?.();
  });
  try {
    closeStore();
  } catch {
    /* ignore */
  }
}

