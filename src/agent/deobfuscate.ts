/**
 * 反混淆：通过 koffi 直调 SpinYarn 的 C ABI。
 *
 * ## 为什么走 C ABI 而不是 HTTP
 *
 * SpinYarn 有三种形态：C ABI（cdylib）、PHP 扩展、HTTP Web API。LogShare 用的是
 * PHP 扩展，而 PHP 扩展本质是包着同一套 C ABI。这里直接调 C ABI 有两个好处：
 *
 * 1. **与 LogShare 共用同一份 mappings 与同一份 Redis 缓存**（部署后启用）——
 *    缓存键由库内部决定，两边用同一个 `mappings_dir` + 同一个 `redis_url` 即自然共享；
 * 2. 不起额外进程、不占端口，常驻句柄可复用。
 *
 * ## 实测踩到的坑（改签名前必读）
 *
 * `spinyarn_deobfuscate` 是 **5 个参数**：
 *
 * ```
 * result* spinyarn_deobfuscate(handle*, const char* content, size_t len,
 *                              const char* version, mapping_type_t type);
 * ```
 *
 * 少传 `version` 时**进程会静默退出**（C 栈错位，退出码 0、无任何输出），
 * 而不是抛异常。定位成本极高，故在此写死说明。
 *
 * `size_t` 参数在 koffi 里必须用 **BigInt** 传，否则会被截断。
 *
 * ## 降级策略：fail-open
 *
 * 反混淆是**增强**，不是分析的前置条件。句柄建不起来、映射缺失、调用抛错，
 * 一律返回原文并记录原因。绝不因为「反混淆失败」而让用户拿不到分析——
 * 那等于让一个可选组件拖垮主流程。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { logshareDeobf as cfg } from '../config.ts';

/** C ABI 的映射族：`YARN` 认 intermediary/named 名，`VANILLA` 认 official 名 */
const MAPPING_YARN = 0;
const MAPPING_VANILLA = 1;

interface Handle {
  /** koffi 的指针（不透明） */
  ptr: unknown;
  /** 建立时的配置指纹：变了就重建 */
  fingerprint: string;
  /** 建立时间 */
  at: number;
}

export interface DeobfuscateResult {
  /** 输出文本（失败时等于输入） */
  text: string;
  /** 是否真的改写了内容 */
  changed: boolean;
  /** 失败原因（成功时为 undefined） */
  error?: string;
}

/** 失败节流：与 LogShare 的 SpinYarnClient 同策略（60s），避免每请求重试 */
const FAILURE_THROTTLE_MS = 60_000;
let lastFailureAt = 0;
let lastError = '';

let handle: Handle | null = null;
let lib: {
  init: (dir: string) => unknown;
  initRedis: (
    dir: string,
    max: bigint,
    high: bigint,
    low: bigint,
    redisUrl: string,
  ) => unknown;
  deobfuscate: (
    h: unknown,
    content: Buffer,
    len: bigint,
    version: string,
    type: number,
  ) => unknown;
  resultText: (r: unknown) => string;
  resultLen: (r: unknown) => bigint;
  resultFree: (r: unknown) => void;
} | null = null;

/** 当前反混淆状态（供 /health 暴露） */
export type DeobfuscateStatus = 'ok' | 'disabled' | 'failed';

export function deobfuscateStatus(): { status: DeobfuscateStatus; detail: string } {
  if (cfg.soPath === '' || cfg.mappingsDir === '') {
    return { status: 'disabled', detail: '未配置 SPINYARN_SO / SPINYARN_MAPPINGS_DIR' };
  }
  if (lib === null) {
    return { status: 'failed', detail: lastError === '' ? '库尚未加载' : lastError };
  }
  if (handle === null) {
    return { status: 'failed', detail: lastError === '' ? '句柄未建立' : lastError };
  }
  return { status: 'ok', detail: '已加载' };
}

/** 加载 .so 并绑定函数（只做一次） */
function loadLib(): NonNullable<typeof lib> {
  if (lib !== null) return lib;

  const soPath = resolve(cfg.soPath);
  if (!existsSync(soPath)) {
    throw new Error(`SpinYarn 库不存在：${soPath}`);
  }

  // koffi 是可选依赖：没装时反混淆整体禁用，不影响主流程。
  // ESM 里没有 `require`，用 createRequire 拿到 CJS 加载器（koffi 是原生模块）。
  const requireCjs = createRequire(import.meta.url);
  const koffi = requireCjs('koffi') as {
    load: (p: string) => {
      func: (sig: string) => (...args: unknown[]) => unknown;
    };
  };

  const l = koffi.load(soPath);
  lib = {
    init: l.func('void *spinyarn_init(const char *mappings_dir)') as never,
    initRedis: l.func(
      'void *spinyarn_init_redis(const char *mappings_dir, size_t cache_max_entries, size_t cache_high_watermark, size_t cache_low_watermark, const char *redis_url)',
    ) as never,
    deobfuscate: l.func(
      'void *spinyarn_deobfuscate(void *handle, const char *content, size_t len, const char *version, int mapping_type)',
    ) as never,
    resultText: l.func('const char *spinyarn_result_text(void *result)') as never,
    resultLen: l.func('size_t spinyarn_result_len(void *result)') as never,
    resultFree: l.func('void spinyarn_result_free(void *result)') as never,
  };
  return lib;
}

/** 配置指纹：任一参数变化都要重建句柄（尤其 redis_url，它决定缓存是否共享） */
function fingerprintOf(): string {
  return [
    resolve(cfg.mappingsDir),
    cfg.redisUrl,
    cfg.cacheMax,
    cfg.cacheHigh,
    cfg.cacheLow,
  ].join('|');
}

/** 取句柄（按需建立、按指纹复用） */
function getHandle(): Handle | null {
  const fp = fingerprintOf();
  if (handle !== null && handle.fingerprint === fp) return handle;

  // 近期失败过：节流，不重试
  if (handle === null && Date.now() - lastFailureAt < FAILURE_THROTTLE_MS) return null;

  try {
    const l = loadLib();
    const dir = resolve(cfg.mappingsDir);

    let ptr: unknown = null;
    if (cfg.redisUrl !== '') {
      // 与 LogShare 共用缓存：同一个 mappings_dir + 同一个 redis_url
      ptr = l.initRedis(
        dir,
        BigInt(cfg.cacheMax),
        BigInt(cfg.cacheHigh),
        BigInt(cfg.cacheLow),
        cfg.redisUrl,
      );
      // Redis 初始化被拒时退回 on-demand（缓存缺失不该拖垮反混淆）
      if (ptr === null || ptr === undefined) {
        ptr = l.init(dir);
      }
    } else {
      ptr = l.init(dir);
    }

    if (ptr === null || ptr === undefined) {
      throw new Error('spinyarn_init 返回 NULL');
    }

    handle = { ptr, fingerprint: fp, at: Date.now() };
    lastError = '';
    return handle;
  } catch (e) {
    lastFailureAt = Date.now();
    lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/**
 * 从日志里识别 MC 版本。
 *
 * ## 为什么要认这么多种写法
 *
 * 上传的不一定是游戏自己的 `latest.log`。移动端启动器（FCL/ZL2/Pojav）上传的
 * 往往是**启动器日志**，里面没有 `Loading Minecraft X`；它们只把版本写进
 * 启动参数或 classpath：
 *
 * | 来源 | 形态 |
 * |---|---|
 * | 原版 / Fabric 游戏日志 | `Loading Minecraft 1.21.11 with Fabric Loader …` |
 * | 崩溃报告 | `Minecraft Version: 1.20.1` |
 * | FCL / Pojav classpath | `…/intermediary/1.20.1/intermediary-1.20.1.jar` |
 * | Forge 启动参数 | `--fml.mcVersion 1.20.1` |
 * | Forge maven 坐标 | `net.minecraftforge:forge:1.20.1-47.4.23` |
 * | 原版启动器目录 | `…/versions/1.20.1/1.20.1.jar` |
 *
 * 顺序即优先级：越靠前的越不容易误判。全部要求以数字开头，
 * 像 `--version 换形者诅咒`（FCL 的实例名）不会被当成版本号。
 *
 * 扫描窗口取 64KB 而不是 20KB：启动器日志的 classpath 往往在很后面，
 * 实测 FCL 那份 24KB 的日志里，`intermediary/1.20.1` 位于第 232 行。
 */
export function detectVersion(text: string): string | null {
  const head = text.slice(0, 64 * 1024);

  const patterns: RegExp[] = [
    /Loading Minecraft\s+([0-9][\w.+-]*)/i,
    /Minecraft Version:\s*([0-9][\w.+-]*)/i,
    /intermediary\/([0-9][\w.+-]*)\//i,
    /--fml\.mcVersion\s+([0-9][\w.+-]*)/i,
    /net\.minecraftforge:forge:([0-9][\w.+-]*)-/i,
    /\/versions\/([0-9][\w.+-]*)\//i,
    /\bminecraft(?:_version)?\s*[=:]\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i,
  ];

  for (const re of patterns) {
    const m = re.exec(head);
    const raw = m?.[1];
    if (raw === undefined) continue;
    // 版本号结尾不会带标点；正则里的 `[\w.+-]*` 可能把句末的句号吞进来
    const cleaned = raw.replace(/[.,;:]+$/, '');
    if (/^[0-9]/.test(cleaned)) return cleaned;
  }

  return null;
}

/** 该版本在 mappings 目录里是否有映射文件（没有就不必反混淆） */
export function hasMapping(version: string): boolean {
  return existsSync(resolve(cfg.mappingsDir, `${version}.tiny.gz`));
}

/**
 * 反混淆一段文本。
 *
 * @param text 日志正文
 * @param version 目标版本；不传则从文本里识别
 */
export function deobfuscate(text: string, version?: string): DeobfuscateResult {
  if (text === '') return { text, changed: false };

  /*
   * 未配置就**直接跳过**，不当作错误。
   *
   * 反混淆是可选增强，没配 `.so` 与 mappings 时它不是「失败」而是「没开启」；
   * 若往下走，`resolve('')` 会解析成工作目录，koffi 报
   * `cannot read file data: Is a directory`，把一句无意义的报错塞进每次上传的响应。
   */
  if (!cfg.enabled) return { text, changed: false };

  const ver = version ?? detectVersion(text);
  if (ver === null) {
    // 识别不到版本就不猜：反混淆猜错版本会把名字改错，比不改更糟
    return { text, changed: false, error: '未能从日志识别 Minecraft 版本' };
  }

  const h = getHandle();
  if (h === null) {
    return { text, changed: false, error: lastError === '' ? '句柄不可用' : lastError };
  }

  const l = loadLib();

  try {
    // 一次日志可能同时含命名名与混淆名，两种映射族都试一次，取有改写的那个
    for (const type of [MAPPING_YARN, MAPPING_VANILLA]) {
      const buf = Buffer.from(text, 'utf8');
      const res = l.deobfuscate(h.ptr, buf, BigInt(buf.length), ver, type);
      if (res === null || res === undefined) continue;

      try {
        const out = String(l.resultText(res));
        const len = Number(l.resultLen(res));
        const sliced = out.slice(0, len);
        if (sliced !== '' && sliced !== text) {
          return { text: sliced, changed: true };
        }
      } finally {
        l.resultFree(res);
      }
    }
    return { text, changed: false };
  } catch (e) {
    lastFailureAt = Date.now();
    lastError = e instanceof Error ? e.message : String(e);
    return { text, changed: false, error: lastError };
  }
}

/** 供测试：重置句柄与节流状态 */
export function resetDeobfuscator(): void {
  handle = null;
  lib = null;
  lastFailureAt = 0;
  lastError = '';
}
