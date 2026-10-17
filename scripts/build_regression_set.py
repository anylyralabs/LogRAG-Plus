#!/usr/bin/env python3
"""
构建回归测试集 —— 从生产分析记录中抽取样本，固化为可重复运行的用例。

## 设计原则

**双层样本**：
  - **低分样本**（score < 75）：用于发现系统缺陷（如评分误判、模型行为异常）
  - **高分样本**（score >= 90）：用于防止回退（改动后不应变差）

**为什么不直接存 logId**：
生产日志有 TTL（7 天），且内容会变。因此**截取足够的日志片段**固化到仓库，
保证测试可重复、不依赖外部服务。

**期望值的记录方式**：
不记录"应该得多少分"（评分体系本身可能有问题），而记录：
  - `expected_category`：问题分类（由人工复核确定）
  - `expected_keywords`：答案中应出现的关键信号（模组名、异常类、配置项）
  - `must_not_contain`：不应出现的错误判断
  - `notes`：人工复核备注（用于区分"真缺陷"与"评分误判"）

用法:
    LOGSHARE_ADMIN_TOKEN=xxx python3 scripts/build_regression_set.py [--out tests/fixtures/regression]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter

API_BASE = "https://api.logshare.cn/v1/admin"

# 单条样本的日志片段上限（避免仓库膨胀）
MAX_EXCERPT_BYTES = 24_000

# 从日志中提取"关键信号"（供期望值参考）
SIGNAL_PATTERNS = [
    (r"(?:Caused by:\s*)?([a-z][\w.]*(?:Exception|Error|Throwable))", "exception"),
    (r"mod(?:ule)?\s+([a-z0-9_-]+)\s+(?:requires|is missing)", "mod"),
    (r"Missing or unsupported mandatory dependencies", "dep"),
    (r"HARD_DEP(?:_NO_CANDIDATE)?", "dep"),
    (r"Mod resolution failed", "dep"),
    (r"(SIGSEGV|SIGBUS|SIGILL|SIGFPE)", "signal"),
    (r"Problematic frame:\s*\n?#?\s*C\s+\[([^\]]+)\]", "native_frame"),
    (r"UnsupportedClassVersionError", "java"),
    (r"OutOfMemoryError", "oom"),
    (r"is missing mods\.toml|not a valid mod file", "invalid_mod"),
    (r"Duplicate mods found|Found duplicate mods", "duplicate"),
    (r"was loaded too early|MixinTargetAlreadyLoadedException", "mixin"),
    (r"Critical injection failure", "mixin"),
    (r"target (?:class )?(\S+) was not found|Could not find any targets", "mixin_target"),
    (r"EOFException.*End of input", "json"),
    (r"JsonSyntaxException|MalformedJsonException", "json"),
    (r"prevented the world from loading", "world"),
    (r"Chunk (?:NBT read error|file at)", "world"),
    (r"Can't keep up", "server"),
    (r"Failed to bind to port", "server"),
]


def api_get(path: str, token: str, retries: int = 3) -> dict:
    url = f"{API_BASE}{path}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"X-Admin-Token": token})
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return {}


def fetch_log(log_id: str, token: str) -> str:
    """取日志正文（admin 详情优先）。"""
    try:
        d = api_get(f"/logs/{log_id}", token)
        c = d.get("content")
        if isinstance(c, str) and c:
            return c
    except Exception:
        pass

    # 兜底：公开 raw（注意不带 /main.log）
    try:
        req = urllib.request.Request(
            f"https://api.logshare.cn/v1/raw/{log_id}",
            headers={"User-Agent": "LogRAG-Regression/0.1"},
        )
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def extract_signals(content: str) -> dict[str, list[str]]:
    """提取日志中的关键信号（供期望值参考）。"""
    out: dict[str, list[str]] = {}
    for pattern, kind in SIGNAL_PATTERNS:
        for m in re.finditer(pattern, content, re.I):
            val = (m.group(1) if m.groups() else m.group(0)).strip()
            if len(val) > 120:
                continue
            out.setdefault(kind, [])
            if val not in out[kind]:
                out[kind].append(val)
    return {k: v[:8] for k, v in out.items()}


def excerpt(content: str, max_bytes: int = MAX_EXCERPT_BYTES) -> str:
    """
    截取足够复现问题的片段。

    策略：若日志超限，优先保留**开头环境信息**与**结尾崩溃段**——
    这两处是诊断信息的集中地。
    """
    if len(content.encode("utf-8")) <= max_bytes:
        return content

    lines = content.split("\n")
    head_budget = max_bytes // 4
    tail_budget = max_bytes - head_budget

    head: list[str] = []
    n = 0
    for line in lines:
        n += len(line.encode("utf-8")) + 1
        if n > head_budget:
            break
        head.append(line)

    tail: list[str] = []
    n = 0
    for line in reversed(lines):
        n += len(line.encode("utf-8")) + 1
        if n > tail_budget:
            break
        tail.insert(0, line)

    skipped = len(lines) - len(head) - len(tail)
    return "\n".join(head) + f"\n\n[... 中间省略 {skipped} 行 ...]\n\n" + "\n".join(tail)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="tests/fixtures/regression")
    ap.add_argument("--low", type=int, default=8, help="抽取多少低分样本")
    ap.add_argument("--high", type=int, default=8, help="抽取多少高分样本")
    ap.add_argument("--scan-pages", type=int, default=6)
    args = ap.parse_args()

    token = (os.environ.get("LOGSHARE_ADMIN_TOKEN") or "").strip()
    if not token:
        print("缺少 LOGSHARE_ADMIN_TOKEN", file=sys.stderr)
        sys.exit(1)

    print("═══ 构建回归测试集 ═══\n")

    # 拉取分析记录
    records: list[dict] = []
    for pg in range(1, args.scan_pages + 1):
        try:
            data = api_get(f"/ai/analyses?limit=50&page={pg}", token)
        except Exception as e:
            print(f"  第 {pg} 页失败: {e}")
            break
        items = data.get("items", [])
        if not items:
            break
        records.extend(items)
    print(f"扫描 {len(records)} 条分析记录")

    scored = [r for r in records if isinstance(r.get("score"), dict)]
    scored.sort(key=lambda r: r["score"].get("overall") or 0)

    low = scored[: args.low]
    high = scored[-args.high :] if len(scored) >= args.high else []

    os.makedirs(args.out, exist_ok=True)

    cases: list[dict] = []
    for tier, batch in (("low", low), ("high", high)):
        for r in batch:
            log_id = str(r.get("logId") or "")
            if log_id == "":
                continue

            content = fetch_log(log_id, token)
            if content == "":
                print(f"  [{tier}] {log_id} 正文获取失败，跳过")
                continue

            s = r.get("score") or {}
            cases.append({
                "id": log_id,
                "tier": tier,
                "score": s.get("overall"),
                "dims": {
                    "toolEfficiency": s.get("toolEfficiency"),
                    "evidenceSufficiency": s.get("evidenceSufficiency"),
                    "conclusionClarity": s.get("conclusionClarity"),
                },
                "mode": r.get("mode"),
                "rounds": r.get("rounds"),
                "toolCallsCount": r.get("toolCallsCount"),
                "rootCause": (r.get("rootCause") or "")[:400],
                "signals": extract_signals(content),
                "excerpt": excerpt(content),
                # 期望值：初版由机器填充，需人工复核后修正
                "expect": {
                    "category": "",
                    "keywords": [],
                    "must_not_contain": [],
                    "notes": "待人工复核：区分真缺陷与评分误判",
                },
            })
            print(f"  [{tier}] {log_id} score={s.get('overall')} ({len(content)} 字节 → {len(cases[-1]['excerpt'])} 字节片段)")

    # 写入
    cases_path = os.path.join(args.out, "cases.json")
    with open(cases_path, "w", encoding="utf-8") as f:
        json.dump({
            "generated_at": int(time.time()),
            "source": "logshare.cn /ai/analyses",
            "total_scanned": len(records),
            "cases": cases,
        }, f, ensure_ascii=False, indent=2)

    # 写入人类可读的复核清单
    review_path = os.path.join(args.out, "REVIEW.md")
    with open(review_path, "w", encoding="utf-8") as f:
        f.write("# 回归样本人工复核清单\n\n")
        f.write("> 对每条样本填写 `expect` 字段后，测试才能用于守门。\n")
        f.write("> **关键区分**：低分是「真缺陷」还是「评分误判」？\n\n")

        for tier, label in (("low", "低分样本（找缺陷）"), ("high", "高分样本（防回退）")):
            group = [c for c in cases if c["tier"] == tier]
            if not group:
                continue
            f.write(f"## {label}（{len(group)} 条）\n\n")
            for c in group:
                f.write(f"### `{c['id']}` — overall {c['score']}\n\n")
                f.write(f"- 维度：工具 {c['dims']['toolEfficiency']} / 证据 {c['dims']['evidenceSufficiency']} / 清晰 {c['dims']['conclusionClarity']}\n")
                f.write(f"- 过程：{c['rounds']} 轮 / {c['toolCallsCount']} 次工具调用 / 模式 {c['mode']}\n")
                f.write(f"- 既有根因判断：{c['rootCause'][:200]}\n")
                f.write(f"- 日志信号：`{json.dumps(c['signals'], ensure_ascii=False)}`\n\n")
                f.write("**复核项**：\n")
                f.write("- [ ] 根因判断是否正确？\n")
                f.write("- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）\n")
                f.write("- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明\n")
                f.write("- [ ] 填写 `expect.category`（问题分类）\n\n")

    print(f"\n已写入：")
    print(f"  {cases_path}（{len(cases)} 条）")
    print(f"  {review_path}（人工复核清单）")
    print(f"\n**下一步**：按 REVIEW.md 复核并填写 expect 字段，测试才能守门。")


if __name__ == "__main__":
    main()
