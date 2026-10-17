#!/usr/bin/env python3
"""
生产日志案例挖掘 —— 从 logshare.cn 真实日志中提取高频失败模式。

用途：为 RAG 知识库提供**数据驱动**的补充依据（而非凭经验猜测该写什么）。

用法:
    LOGSHARE_ADMIN_TOKEN=xxx python3 scripts/mine_cases.py [--days 7] [--sample 200]

输出:
    - 失败签名频次统计
    - 按来源（启动器）分类的分布
    - 典型案例的 ID 列表（供人工复核与摘要提取）

注意：本脚本只统计**模式频次**，不导出原始日志内容。
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict

API_BASE = "https://api.logshare.cn/v1/admin"

# 失败签名模式（从 27 份实测日志与上游源码中提炼）
SIGNATURES = [
    # 原生库 / ABI
    ("native:UnsatisfiedLinkError", re.compile(r"UnsatisfiedLinkError")),
    ("native:dlopen-failed", re.compile(r"dlopen failed")),
    ("native:failed-to-load-library", re.compile(r"\[LWJGL\]\s*Failed to load a library")),
    ("native:arch-mismatch", re.compile(r"Platform/architecture mismatch")),
    ("native:libc-so6", re.compile(r"libc\.so\.6")),
    ("native:could-not-init-lwjgl", re.compile(r"Could not initialize class org\.lwjgl")),

    # SDL3 迁移
    ("sdl:no-class-def", re.compile(r"org/lwjgl/sdl/SDL")),
    ("sdl:platform-error", re.compile(r"NoClassDefFoundError.*SDLPlatform")),

    # Java 运行时
    ("java:unsupported-class-version", re.compile(r"UnsupportedClassVersionError")),
    ("java:could-not-create-jvm", re.compile(r"Could not create the Java Virtual Machine")),
    ("java:no-jre", re.compile(r"Could not find Java SE Runtime Environment")),
    ("java:jvm-symbol", re.compile(r'cannot locate symbol "JVM_')),
    ("java:sigill-register-natives", re.compile(r"System\.registerNatives")),

    # 内存
    ("mem:java-heap", re.compile(r"OutOfMemoryError.*Java heap space")),
    ("mem:metaspace", re.compile(r"OutOfMemoryError.*Metaspace")),
    ("mem:gc-overhead", re.compile(r"GC overhead limit exceeded")),

    # Mixin
    ("mixin:apply-error", re.compile(r"MixinApplyError|Mixin apply failed")),
    ("mixin:transformer-error", re.compile(r"MixinTransformerError")),
    ("mixin:injection-failure", re.compile(r"Critical injection failure|InjectionError")),
    ("mixin:target-not-found", re.compile(r"@Mixin target .* was not found")),
    ("mixin:loaded-too-early", re.compile(r"MixinTargetAlreadyLoadedException|was loaded too early")),
    ("mixin:validation", re.compile(r"InjectionValidationException|Injection validation failed")),

    # 依赖 / 版本
    ("dep:hard-dep-no-candidate", re.compile(r"HARD_DEP_NO_CANDIDATE")),
    ("dep:resolution-failed", re.compile(r"Mod resolution failed")),
    ("dep:missing-mandatory", re.compile(r"Missing or unsupported mandatory dependencies")),
    ("dep:duplicate-mods", re.compile(r"Duplicate mods found|Found duplicate mods")),
    ("dep:id-registered", re.compile(r"already registered|ID already registered")),
    ("ver:no-such-method", re.compile(r"NoSuchMethodError")),
    ("ver:no-such-field", re.compile(r"NoSuchFieldError")),
    ("ver:incompatible-class-change", re.compile(r"IncompatibleClassChangeError")),
    ("ver:abstract-method", re.compile(r"AbstractMethodError")),
    ("ver:jpms-resolution", re.compile(r"java\.lang\.module\.ResolutionException")),

    # 渲染器 / 图形
    ("gfx:sigsegv-mobileglues", re.compile(r"libmobileglues\.so")),
    ("gfx:sigsegv-mali", re.compile(r"libGLES_mali\.so")),
    ("gfx:sigsegv-adreno", re.compile(r"libGLESv2_adreno\.so")),
    ("gfx:framebuffer-unsupported", re.compile(r"GL_FRAMEBUFFER_UNSUPPORTED")),
    ("gfx:shader-compile-failed", re.compile(r"shader.*compil|Could not compile shader", re.I)),

    # 崩溃报告 / 原生崩溃
    ("crash:mc-crash-report", re.compile(r"-+\s*Minecraft Crash Report\s*-+")),
    ("crash:hs-err", re.compile(r"# A fatal error has been detected by the Java Runtime Environment")),
    ("crash:launcher-crash", re.compile(r"ZalithLauncher Crash Report|FCL Crash Report")),
    ("crash:sigsegv", re.compile(r"SIGSEGV")),
    ("crash:sigbus", re.compile(r"SIGBUS")),
    ("crash:sigill", re.compile(r"SIGILL")),

    # 服务端
    ("srv:cant-keep-up", re.compile(r"Can't keep up")),
    ("srv:ticking-entity", re.compile(r"Ticking entity|Ticking block entity")),
    ("srv:tick-loop", re.compile(r"Exception in server tick loop")),
    ("srv:port-bind", re.compile(r"Failed to bind to port|Address already in use")),

    # 存档 / 世界
    ("world:chunk-nbt", re.compile(r"Chunk NBT read error|Chunk file at .* is missing")),
    ("world:datapack", re.compile(r"prevented the world from loading|datapack")),
    ("world:stack-overflow", re.compile(r"StackOverflowError")),

    # 认证
    ("auth:401", re.compile(r"MinecraftClientHttpException.*401|InvalidCredentialsException")),
    ("auth:403", re.compile(r"MinecraftClientHttpException.*403")),

    # 其他
    ("misc:file-not-found", re.compile(r"FileNotFoundException")),
    ("misc:class-not-found", re.compile(r"ClassNotFoundException")),
    ("misc:null-pointer", re.compile(r"NullPointerException")),
]


def api_get(path: str, token: str, retries: int = 3) -> dict:
    url = f"{API_BASE}{path}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"X-Admin-Token": token})
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return {}


def fetch_log_content(log_id: str, token: str) -> str | None:
    """拉取日志正文。

    两条路径（实测确认）：
      1. admin 详情接口 `/logs/{id}` 直接返回 `content` 字段（推荐，一次拿全）
      2. 公开 raw 接口 `/v1/raw/{id}`（不带 /main.log —— 带后缀会 404）

    正文已经过 LogShare 的脱敏链处理。
    """
    # 路径 1：admin 详情（含 content）
    try:
        data = api_get(f"/logs/{log_id}", token)
        content = data.get("content")
        if isinstance(content, str) and content != "":
            return content
    except Exception:
        pass

    # 路径 2：公开 raw（兜底）
    url = f"https://api.logshare.cn/v1/raw/{log_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LogRAG-Research/0.1"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--sample", type=int, default=120, help="抽样日志数")
    ap.add_argument("--page-size", type=int, default=50)
    args = ap.parse_args()

    token = (__import__("os").environ.get("LOGSHARE_ADMIN_TOKEN") or "").strip()
    if not token:
        print("缺少 LOGSHARE_ADMIN_TOKEN 环境变量", file=sys.stderr)
        sys.exit(1)

    print(f"═══ 生产日志案例挖掘（抽样 {args.sample} 份）═══\n")

    # 1. 拉取日志列表（按来源分层抽样）
    collected: list[dict] = []
    page = 1
    while len(collected) < args.sample and page <= 200:
        data = api_get(f"/logs?limit={args.page_size}&page={page}", token)
        items = data.get("items", [])
        if not items:
            break
        collected.extend(items)
        page += 1
        if page % 5 == 0:
            print(f"  已拉取 {len(collected)} 条列表…")

    print(f"\n列表拉取完成：{len(collected)} 条\n")

    # 2. 按来源统计（确认生态构成）
    source_counter: Counter[str] = Counter()
    for it in collected:
        src = str(it.get("source") or "未指定")
        launcher = src.split("/")[0]
        source_counter[launcher] += 1

    print("─── 启动器分布（抽样）───")
    for name, n in source_counter.most_common():
        print(f"  {name:<14} {n:>4}  ({n / max(1, len(collected)) * 100:.1f}%)")

    # 3. 逐份抓取内容并统计签名
    print(f"\n─── 抓取日志正文并匹配失败签名 ───")
    sig_counter: Counter[str] = Counter()
    sig_examples: dict[str, list[str]] = defaultdict(list)
    kind_counter: Counter[str] = Counter()
    fetched = 0
    failed = 0

    for i, it in enumerate(collected):
        log_id = str(it.get("id") or "")
        if not log_id:
            continue
        content = fetch_log_content(log_id, token)
        if content is None or content == "":
            failed += 1
            continue
        fetched += 1

        for name, pattern in SIGNATURES:
            if pattern.search(content):
                sig_counter[name] += 1
                if len(sig_examples[name]) < 3:
                    src = str(it.get("source") or "?")
                    sig_examples[name].append(f"{log_id} ({src}, {len(content)} 字节)")

        # 日志类型
        if "Minecraft Crash Report" in content:
            kind_counter["crash-report"] += 1
        if "# A fatal error has been detected" in content:
            kind_counter["hs-err"] += 1
        if "==================== Launch Minecraft" in content:
            kind_counter["launcher-shell"] += 1

        if (i + 1) % 20 == 0:
            print(f"  已分析 {i + 1}/{len(collected)}（成功 {fetched}，失败 {failed}）")

    print(f"\n抓取完成：成功 {fetched}，失败 {failed}\n")

    # 4. 输出结果
    print("─── 日志类型分布 ───")
    for kind, n in kind_counter.most_common():
        print(f"  {kind:<18} {n:>4}")

    print("\n─── 失败签名频次（降序）───")
    print(f"{'签名':<34} {'份数':>5} {'占比':>7}")
    print("-" * 52)
    for name, n in sig_counter.most_common():
        pct = n / max(1, fetched) * 100
        print(f"{name:<34} {n:>5} {pct:>6.1f}%")

    print("\n─── 各签名典型案例（供人工复核）───")
    for name, n in sig_counter.most_common(20):
        print(f"\n[{name}] {n} 份")
        for ex in sig_examples[name]:
            print(f"    · {ex}")


if __name__ == "__main__":
    main()
