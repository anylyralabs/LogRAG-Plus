#!/usr/bin/env python3
"""
实战案例挖掘 —— 从 logshare.cn 的 AI 分析记录中提取已验证的排查案例。

## 为什么需要

知识库的「抽象规则」告诉模型"这类问题该怎么修"，但模型更需要**真实案例**：
「同样是 NoSuchFieldError，实际长什么样、根因是什么、怎么修的」。

这些分析记录已含：
  - `rootCause`：已由模型产出的根因判断
  - `score`：四维质量评分（可用来筛选高质量案例）
  - `toolCallsCount` / `rounds`：排查过程复杂度

## 用途

输出结构化案例集，供：
  1. 人工复核后写入 `knowledge/cases/`（实战记录）
  2. 校对知识库的签名与修复步骤是否与实际相符

用法:
    LOGSHARE_ADMIN_TOKEN=xxx python3 scripts/mine_analyses.py [--limit 200] [--min-score 85]

注意：只输出**模式与结论摘要**，不导出完整日志内容。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict

API_BASE = "https://api.logshare.cn/v1/admin"

# 根因分类规则（按**问题本质**分类，不按启动器）
CATEGORIES: list[tuple[str, re.Pattern[str]]] = [
    ("依赖缺失/版本错配",
     re.compile(r"缺(少|失).*前置|depend|HARD_DEP|ModResolution|版本(不匹配|错配)|incompatib", re.I)),
    ("Mixin 注入失败",
     re.compile(r"mixin|注入|InjectionError|refmap", re.I)),
    ("原生库/ABI",
     re.compile(r"dlopen|UnsatisfiedLink|原生库|libc\.so|natives|ABI|架构", re.I)),
    ("Java 运行时",
     re.compile(r"Java (版本|运行时)|UnsupportedClassVersion|JVM|JRE|运行时", re.I)),
    ("内存不足",
     re.compile(r"内存|OutOfMemory|OOM|heap|-Xmx", re.I)),
    ("渲染器/图形驱动",
     re.compile(r"渲染器|OpenGL|Vulkan|glGetString|驱动|GPU|Mali|Adreno|shader|着色器", re.I)),
    ("世界/存档损坏",
     re.compile(r"存档|世界|区块|chunk|NBT|region|datapack|数据包", re.I)),
    ("配置/JSON 损坏",
     re.compile(r"配置|JSON|gson|EOFException|MalformedJson|options\.txt", re.I)),
    ("模组冲突",
     re.compile(r"冲突|重复|duplicate|already registered|不兼容", re.I)),
    ("账号/网络",
     re.compile(r"认证|登录|401|403|InvalidCredentials|网络|连接|timeout", re.I)),
    ("服务端/性能",
     re.compile(r"服务端|TPS|tick|卡顿|Can't keep up|端口", re.I)),
    ("光影/资源包",
     re.compile(r"光影|shaderpack|资源包|resourcepack|OptiFine|Iris|Sodium", re.I)),
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


def classify(root_cause: str) -> list[str]:
    """按问题本质分类（可能命中多个）。"""
    hits = []
    for name, pattern in CATEGORIES:
        if pattern.search(root_cause):
            hits.append(name)
    return hits or ["未分类"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200, help="拉取的分析记录数")
    ap.add_argument("--min-score", type=int, default=0, help="最低综合评分过滤")
    ap.add_argument("--out", type=str, default="", help="输出 JSON 路径")
    args = ap.parse_args()

    token = (os.environ.get("LOGSHARE_ADMIN_TOKEN") or "").strip()
    if not token:
        print("缺少 LOGSHARE_ADMIN_TOKEN 环境变量", file=sys.stderr)
        sys.exit(1)

    print(f"═══ 实战案例挖掘（目标 {args.limit} 条）═══\n")

    records: list[dict] = []
    page_size = 50
    page = 1

    while len(records) < args.limit:
        data = api_get(f"/ai/analyses?limit={page_size}&page={page}", token)
        items = data.get("items", [])
        if not items:
            break
        records.extend(items)
        page += 1
        if page > 40:
            break

    total = len(records)
    print(f"拉取 {total} 条分析记录\n")

    # ── 质量筛选 ──
    scored = [r for r in records if isinstance(r.get("score"), dict)]
    if args.min_score > 0:
        scored = [r for r in scored if (r["score"].get("overall") or 0) >= args.min_score]

    threshold = args.min_score or 0
    print(f"─── 质量筛选（≥{threshold} 分）───")
    print(f"  有效记录: {len(scored)} / {total}")

    # ── 分类统计 ──
    cat_counter: Counter[str] = Counter()
    cat_examples: dict[str, list[dict]] = defaultdict(list)

    for r in scored:
        rc = str(r.get("rootCause") or "")
        if rc == "":
            continue
        for cat in classify(rc):
            cat_counter[cat] += 1
            if len(cat_examples[cat]) < 5:
                cat_examples[cat].append({
                    "logId": r.get("logId"),
                    "score": (r.get("score") or {}).get("overall"),
                    "rounds": r.get("rounds"),
                    "toolCalls": r.get("toolCallsCount"),
                    "rootCause": rc[:300],
                })

    print("\n─── 问题分类分布（按根因本质）───")
    print(f"{'类别':<20} {'条数':>5} {'占比':>7}")
    print("-" * 36)
    for cat, n in cat_counter.most_common():
        print(f"{cat:<20} {n:>5} {n / max(1, len(scored)) * 100:>6.1f}%")

    # ── 过程复杂度 ──
    rounds = [r.get("rounds") or 0 for r in scored]
    tools = [r.get("toolCallsCount") or 0 for r in scored]
    if rounds:
        print(f"\n─── 排查过程复杂度 ───")
        print(f"  平均轮次:     {sum(rounds) / len(rounds):.1f}")
        print(f"  平均工具调用: {sum(tools) / len(tools):.1f}")
        print(f"  最多工具调用: {max(tools)}")

    # ── 典型案例 ──
    print("\n─── 各分类典型案例（供人工复核）───")
    for cat, n in cat_counter.most_common():
        print(f"\n【{cat}】{n} 条")
        for ex in cat_examples[cat][:3]:
            print(f"  · [{ex['logId']}] 评分={ex['score']} 轮次={ex['rounds']} 工具={ex['toolCalls']}")
            print(f"      {ex['rootCause'][:150]}")

    # ── 输出 ──
    if args.out:
        payload = {
            "generated_at": int(time.time()),
            "total": total,
            "filtered": len(scored),
            "min_score": args.min_score,
            "category_counts": dict(cat_counter),
            "examples": {k: v for k, v in cat_examples.items()},
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.out}")


if __name__ == "__main__":
    main()
