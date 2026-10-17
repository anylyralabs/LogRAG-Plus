#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""评分体系深挖：toolEfficiency 的真实扣分规则 + 零工具记录是什么。

第一轮复核（analyze_scores.py）得到两个未解释的现象：
  1. `evidenceSufficiency` 的规则已确认（工具次数的阶跃函数），
     但 `toolEfficiency` 均值只有 69.24，且**几乎不是**由「重复调用」造成的
     （同工具+同参数重复的记录仅 47 条）。那么它到底在扣什么？
  2. 「工具调用 0 次」的 319 条记录里，没有一条满足「有根因 + 答案 ≥400 字」。
     这不像「简单问题被低估」，更像**另一种失败**。

本脚本用特征对照把这两人问题落到实证。

输出：data/corpus/score_deepdive.md
"""
import json
import os
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data/corpus/analyses_compact.jsonl")
OUT = os.path.join(ROOT, "data/corpus/score_deepdive.md")

records = []
with open(SRC, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

EMPTY_MARKERS = [
    "未找到", "没有找到", "无结果", "没有结果", "no results", "not found",
    "未检索到", "没有检索到", "未匹配", "无匹配", "未命中", "没有命中",
]


def score_of(r):
    return r.get("score") or {}


def feats(r):
    """从一条记录里抽出的可解释特征"""
    chain = r.get("toolCallChain") or []
    names = [c.get("name") for c in chain]
    argkeys = [
        f"{c.get('name')}|{json.dumps(c.get('args'), ensure_ascii=False, sort_keys=True)}"
        for c in chain
    ]
    dup = sum(v - 1 for v in collections.Counter(argkeys).values() if v > 1)

    def emptyish(c):
        head = str(c.get("resultHead") or "")
        chars = c.get("resultChars")
        if isinstance(chars, int) and chars < 20:
            return True
        low = head.lower()
        return any(m.lower() in low for m in EMPTY_MARKERS)

    empty_calls = sum(1 for c in chain if emptyish(c))
    failed = sum(1 for c in chain if c.get("ok") is False)

    return {
        "tool_calls": len(chain),
        "distinct_tools": len(set(names)),
        "dup_args": dup,
        "empty_calls": empty_calls,
        "failed_calls": failed,
        "rounds": r.get("rounds") or 0,
        "answer_chars": len(str(r.get("fullAnswer") or "")),
        "root_cause_chars": len(str(r.get("rootCause") or "").strip()),
        "tool_eff": score_of(r).get("toolEfficiency"),
        "overall": score_of(r).get("overall"),
    }


feat_list = [(r, feats(r)) for r in records]

# ── 1. toolEfficiency 的取值与各特征的对照 ──────────────
te_values = collections.Counter()
for _r, f in feat_list:
    if isinstance(f["tool_eff"], (int, float)):
        te_values[int(f["tool_eff"])] += 1

print("=== toolEfficiency 取值分布 ===")
for v, c in sorted(te_values.items()):
    print(f"  {v}: {c}")

# 找出「高 toolEfficiency=100」与「低分」两组，比较特征均值
def avg(rows, key):
    vals = [f[key] for _r, f in rows if isinstance(f[key], (int, float))]
    return round(sum(vals) / len(vals), 2) if vals else None


good_eff = [x for x in feat_list if x[1]["tool_eff"] == 100]
bad_eff = [x for x in feat_list if isinstance(x[1]["tool_eff"], (int, float)) and x[1]["tool_eff"] <= 40]

print()
print("=== toolEfficiency=100 vs ≤40 的特征对照 ===")
for k in ("tool_calls", "distinct_tools", "dup_args", "empty_calls", "failed_calls", "rounds", "answer_chars"):
    print(f"  {k:16s} 100分: {avg(good_eff, k)!s:>10}   ≤40分: {avg(bad_eff, k)!s:>10}")

# 关键判据：扣分是否与「空结果调用」强相关
bucket = collections.defaultdict(lambda: collections.Counter())
for _r, f in feat_list:
    if isinstance(f["tool_eff"], (int, float)):
        bucket[min(f["empty_calls"], 6)][int(f["tool_eff"])] += 1

print()
print("=== 空结果调用数 → toolEfficiency 分布 ===")
for k in sorted(bucket):
    tot = sum(bucket[k].values())
    dom = bucket[k].most_common(3)
    print(f"  空结果 {k} 次: n={tot}  取值 {dom}")

# ── 2. 零工具记录到底是什么 ─────────────────────────────
zero = [(r, f) for r, f in feat_list if f["tool_calls"] == 0]
print()
print(f"=== 零工具记录 {len(zero)} 条 ===")
print("  rounds 分布:", dict(collections.Counter(f["rounds"] for _r, f in zero).most_common()))
print("  overall 分布:", dict(collections.Counter(f["overall"] for _r, f in zero).most_common(8)))
print("  根因字数=0 的占比: %.1f%%" % (100 * sum(1 for _r, f in zero if f["root_cause_chars"] == 0) / max(len(zero), 1)))
print("  答案字数 中位数:", sorted(f["answer_chars"] for _r, f in zero)[len(zero) // 2] if zero else None)
print("  答案字数 最大:", max((f["answer_chars"] for _r, f in zero), default=0))

# ── 3. 低分（<80）样本：是「真差」还是「被低估」 ─────────
low = [(r, f) for r, f in feat_list if isinstance(f["overall"], (int, float)) and f["overall"] < 80]
print()
print(f"=== 低分样本 {len(low)} 条 ===")

# 判据：根因非空 + 答案 ≥300 字 + 没有失败/空结果调用 → 倾向「被低估」
underrated = [
    (r, f) for r, f in low
    if f["root_cause_chars"] >= 10 and f["answer_chars"] >= 300
    and f["failed_calls"] == 0 and f["empty_calls"] == 0
]
genuine_bad = [
    (r, f) for r, f in low
    if f["root_cause_chars"] == 0 or f["answer_chars"] < 150
]
print(f"  倾向被低估（根因非空+答案≥300字+无失败/空结果）: {len(underrated)}")
print(f"  倾向真差（根因空 或 答案<150字）: {len(genuine_bad)}")

print()
print("  被低估样本的 toolEfficiency 分布:",
      dict(collections.Counter(f["tool_eff"] for _r, f in underrated).most_common(8)))
print("  被低估样本的 tool_calls 均值:", avg(underrated, "tool_calls"))
print("  被低估样本的 rounds 均值:", avg(underrated, "rounds"))

print()
print("  真差样本的 rounds 分布:",
      dict(collections.Counter(f["rounds"] for _r, f in genuine_bad).most_common(8)))

# ── 报告 ────────────────────────────────────────────────
with open(OUT, "w", encoding="utf-8") as fh:
    w = fh.write
    w("# 评分体系深挖报告\n\n")
    w(f"样本：{len(records)} 条\n\n")

    w("## 一、toolEfficiency 的取值分布\n\n")
    w("| 取值 | 条数 |\n|---|---|\n")
    for v, c in sorted(te_values.items()):
        w(f"| {v} | {c} |\n")

    w("\n## 二、toolEfficiency=100 与 ≤40 的特征对照\n\n")
    w("| 特征 | =100 均值 | ≤40 均值 |\n|---|---|---|\n")
    for k in ("tool_calls", "distinct_tools", "dup_args", "empty_calls", "failed_calls", "rounds", "answer_chars"):
        w(f"| {k} | {avg(good_eff, k)} | {avg(bad_eff, k)} |\n")

    w("\n## 三、空结果调用数 → toolEfficiency 分布\n\n")
    w("| 空结果调用 | 样本 | 主要取值 |\n|---|---|---|\n")
    for k in sorted(bucket):
        tot = sum(bucket[k].values())
        dom = "、".join(f"{v}×{c}" for v, c in bucket[k].most_common(3))
        w(f"| {k} | {tot} | {dom} |\n")

    w(f"\n## 四、零工具记录（{len(zero)} 条）\n\n")
    w("| 指标 | 值 |\n|---|---|\n")
    w(f"| rounds 分布 | {dict(collections.Counter(f['rounds'] for _r, f in zero).most_common())} |\n")
    w(f"| overall 分布 | {dict(collections.Counter(f['overall'] for _r, f in zero).most_common(8))} |\n")
    w(f"| 根因字数为 0 的占比 | {100 * sum(1 for _r, f in zero if f['root_cause_chars'] == 0) / max(len(zero), 1):.1f}% |\n")
    w(f"| 答案字数最大 | {max((f['answer_chars'] for _r, f in zero), default=0)} |\n")

    w(f"\n## 五、低分样本（{len(low)} 条）的性质拆分\n\n")
    w(f"- 倾向**被低估**（有根因 + 答案 ≥300 字 + 无失败/空结果）：**{len(underrated)}** 条\n")
    w(f"- 倾向**真差**（根因为空 或 答案 <150 字）：**{len(genuine_bad)}** 条\n")
    w(f"\n被低估样本的 toolEfficiency 分布：{dict(collections.Counter(f['tool_eff'] for _r, f in underrated).most_common(8))}\n")
    w(f"\n被低估样本平均工具调用 {avg(underrated, 'tool_calls')} 次、平均 {avg(underrated, 'rounds')} 轮。\n")

    w("\n### 被低估样本清单（前 30，按 overall 升序）\n\n")
    w("| 日志 ID | overall | toolEff | 证据 | 工具数 | 轮次 | 根因（截断） |\n|---|---|---|---|---|---|---|\n")
    for r, f in sorted(underrated, key=lambda x: x[1]["overall"])[:30]:
        w(f"| {r.get('logId')} | {f['overall']} | {f['tool_eff']} | "
          f"{(score_of(r).get('evidenceSufficiency'))} | {f['tool_calls']} | {f['rounds']} | "
          f"{str(r.get('rootCause'))[:60]} |\n")

    w("\n### 真差样本清单（前 30）\n\n")
    w("| 日志 ID | overall | 根因字数 | 答案字数 | 工具数 | 轮次 |\n|---|---|---|---|---|---|\n")
    for r, f in sorted(genuine_bad, key=lambda x: x[1]["overall"])[:30]:
        w(f"| {r.get('logId')} | {f['overall']} | {f['root_cause_chars']} | {f['answer_chars']} | "
          f"{f['tool_calls']} | {f['rounds']} |\n")

print()
print("报告已写出:", OUT)
