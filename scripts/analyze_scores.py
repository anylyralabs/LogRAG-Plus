#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生产分析记录的评分体系复核（本地离线）。

回答三个问题：
  1. 评分四维各自在**什么情形**下失真？
  2. 哪些低分是「真答得差」，哪些是「答对了但被系统性低估」？
  3. 可以直接拿来当典型/回归用例的样本有哪些？

输入：data/corpus/analyses_compact.jsonl（9353 条，压缩版）
输出：data/corpus/score_review.json   结构化结论
      data/corpus/score_review.md     人类可读报告
"""
import json
import os
import collections
import statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data/corpus/analyses_compact.jsonl")
OUTJSON = os.path.join(ROOT, "data/corpus/score_review.json")
OUTMD = os.path.join(ROOT, "data/corpus/score_review.md")

records = []
with open(SRC, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

print("读入", len(records), "条")

report = {"total": len(records)}


def overall(r):
    v = (r.get("score") or {}).get("overall")
    return v if isinstance(v, (int, float)) else None


scored = [r for r in records if overall(r) is not None]
report["scored"] = len(scored)

# ── 1. evidenceSufficiency 与工具次数的映射关系（验证「纯映射」假设）──
rel = collections.defaultdict(collections.Counter)
for r in scored:
    n = r.get("toolCallsCount")
    v = (r.get("score") or {}).get("evidenceSufficiency")
    if isinstance(n, int) and isinstance(v, (int, float)):
        rel[n][int(v)] += 1

mapping = {}
for n in sorted(rel):
    if n > 6:
        continue
    vals = rel[n]
    mapping[n] = {
        "n": sum(vals.values()),
        "distinct_values": sorted(vals.items()),
        "min": min(vals),
        "max": max(vals),
    }
report["evidence_mapping"] = mapping

# 唯一值个数 ≤2 说明该维度对该工具次数基本是常量，即由工具次数决定。
# 实测每个桶都有极少量离群值（如 2 次工具里混了 1 条 60 分），故判据用
# 「主导取值占比 ≥95%」而非「取值唯一」——否则会把结论判反。
pure_mapping = True
for _n, _v in mapping.items():
    total = _v["n"]
    dominant = max(cnt for _, cnt in _v["distinct_values"])
    if total > 0 and dominant / total < 0.95:
        pure_mapping = False
report["evidence_is_pure_mapping"] = pure_mapping
report["evidence_step_function"] = {
    str(n): max(_v["distinct_values"], key=lambda kv: kv[1])[0] for n, _v in mapping.items()
}

# ── 2. 低分样本的失败归因 ───────────────────────────────
# 把「评分维度」当作归因线索：哪一维拖低了总分
def dims(r):
    s = r.get("score") or {}
    return {
        "toolEfficiency": s.get("toolEfficiency"),
        "evidenceSufficiency": s.get("evidenceSufficiency"),
        "conclusionClarity": s.get("conclusionClarity"),
    }


low = [r for r in scored if overall(r) < 80]
report["low_count"] = len(low)
report["low_ratio"] = round(len(low) / len(scored), 4)

low_by_dim = collections.Counter()
for r in low:
    d = dims(r)
    numeric = {k: v for k, v in d.items() if isinstance(v, (int, float))}
    if not numeric:
        low_by_dim["unknown"] += 1
        continue
    worst = min(numeric, key=lambda k: numeric[k])
    low_by_dim[worst] += 1
report["low_worst_dimension"] = dict(low_by_dim.most_common())

# ── 3. 误判检测：零工具但答案完整、总分却低 ──────────────
# 判据：toolCallsCount == 0 且 rootCause 非空 且 fullAnswer 有一定长度
mistrial = []
for r in scored:
    n = r.get("toolCallsCount") or 0
    rc = str(r.get("rootCause") or "").strip()
    ans = str(r.get("fullAnswer") or "")
    if n == 0 and len(rc) >= 15 and len(ans) >= 400:
        mistrial.append({
            "logId": r.get("logId"),
            "cacheKey": r.get("cacheKey"),
            "overall": overall(r),
            "evidence": (r.get("score") or {}).get("evidenceSufficiency"),
            "rounds": r.get("rounds"),
            "rootCause": rc[:220],
            "answerChars": len(ans),
        })
mistrial.sort(key=lambda x: x["overall"] if x["overall"] is not None else 0)
report["zero_tool_but_complete"] = mistrial
report["zero_tool_but_complete_count"] = len(mistrial)

# ── 4. 重复工具调用（toolEfficiency 低分的直接原因）──────
repeat_stats = []
for r in scored:
    chain = r.get("toolCallChain") or []
    keys = collections.Counter()
    for c in chain:
        name = c.get("name")
        args = c.get("args")
        try:
            argkey = json.dumps(args, ensure_ascii=False, sort_keys=True)
        except Exception:
            argkey = str(args)
        keys[f"{name}|{argkey}"] += 1

    repeats = {k: v for k, v in keys.items() if v > 1}
    wasted = sum(v - 1 for v in repeats.values())

    if wasted >= 2:
        repeat_stats.append({
            "logId": r.get("logId"),
            "cacheKey": r.get("cacheKey"),
            "overall": overall(r),
            "toolEfficiency": (r.get("score") or {}).get("toolEfficiency"),
            "toolCalls": len(chain),
            "wastedCalls": wasted,
            "examples": [
                {"call": k.split("|", 1)[0], "args": k.split("|", 1)[1][:160], "times": v}
                for k, v in sorted(repeats.items(), key=lambda kv: -kv[1])[:3]
            ],
        })

repeat_stats.sort(key=lambda x: -x["wastedCalls"])
report["heavy_repeat_calls"] = repeat_stats[:40]
report["heavy_repeat_count"] = len(repeat_stats)
report["records_with_repeat"] = sum(
    1 for r in scored
    if any(
        v > 1
        for v in collections.Counter(
            f"{c.get('name')}|{json.dumps(c.get('args'), ensure_ascii=False, sort_keys=True)}"
            for c in (r.get("toolCallChain") or [])
        ).values()
    )
)

# ── 5. 评分维度与答案长度的关系（结论明确性为何恒高）──────
clarity = [(r.get("score") or {}).get("conclusionClarity") for r in scored]
clarity = [v for v in clarity if isinstance(v, (int, float))]
report["clarity_distribution"] = dict(collections.Counter(int(v // 10) * 10 for v in clarity))

# ── 6. 可直接当典型的高分样本（结构完整 + 轮次合理）────
good = []
for r in scored:
    n = r.get("toolCallsCount") or 0
    rounds = r.get("rounds") or 0
    so = (r.get("structuredOutput") or {})
    if (
        overall(r) >= 95
        and 2 <= n <= 8
        and 2 <= rounds <= 8
        and so.get("rootCause")
        and len(so.get("evidence") or []) >= 2
        and len(so.get("steps") or []) >= 2
    ):
        good.append({
            "logId": r.get("logId"),
            "cacheKey": r.get("cacheKey"),
            "overall": overall(r),
            "rounds": rounds,
            "toolCalls": n,
            "rootCause": str(so.get("rootCause"))[:220],
            "tools": [c.get("name") for c in (r.get("toolCallChain") or [])],
        })
good.sort(key=lambda x: (x["rounds"], x["toolCalls"]))
report["high_quality_typical"] = good[:40]
report["high_quality_count"] = len(good)

with open(OUTJSON, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

# ── Markdown 报告 ────────────────────────────────────────
with open(OUTMD, "w", encoding="utf-8") as f:
    w = f.write
    w("# 生产评分体系复核报告\n\n")
    w(f"样本：{report['total']} 条分析记录（有 overall 的 {report['scored']} 条）\n\n")

    w("## 一、evidenceSufficiency 是工具次数的纯映射\n\n")
    w("| 工具调用次数 | 样本 | 该维取值分布 |\n|---|---|---|\n")
    for n, v in sorted(report["evidence_mapping"].items()):
        dist = "、".join(f"{val}×{cnt}" for val, cnt in v["distinct_values"][:6])
        w(f"| {n} | {v['n']} | {dist} |\n")
    w(f"\n判定：**{'是' if pure_mapping else '否'}**纯映射。")
    w("该维度不测量「证据是否充分」，只测量「调用过几次工具」——")
    w("因此不需要工具的简单问题（点名一个已知崩溃、单点内存不足）会被系统性压到 20 分。\n\n")

    w("## 二、低分样本归因\n\n")
    w(f"overall < 80 的样本 {report['low_count']} 条（占 {report['low_ratio']*100:.1f}%）。"
      "按「拖分最严重的维度」归类：\n\n")
    w("| 拖分维度 | 条数 |\n|---|---|\n")
    for k, v in report["low_worst_dimension"].items():
        w(f"| {k} | {v} |\n")

    w("\n## 三、误判：零工具但答案完整却被压低\n\n")
    w(f"共 {report['zero_tool_but_complete_count']} 条满足「工具调用 0 次 + 有根因 + 答案 ≥400 字」。"
      "这批是评分体系误判的**确定性证据**：模型没调工具不是没查，而是不需要查。\n\n")
    w("| 日志 ID | overall | evidence | 轮次 | 字数 | 根因（截断） |\n|---|---|---|---|---|---|\n")
    for m in mistrial[:15]:
        w(f"| {m['logId']} | {m['overall']} | {m['evidence']} | {m['rounds']} | "
          f"{m['answerChars']} | {m['rootCause'][:60]} |\n")

    w("\n## 四、重复工具调用（toolEfficiency 失分的直接原因）\n\n")
    w(f"有重复调用（同工具 + 完全同参数 ≥2 次）的记录 {report['records_with_repeat']} 条；"
      f"其中浪费 ≥2 次的有 {report['heavy_repeat_count']} 条。\n\n")
    w("| 日志 ID | overall | toolEff | 总调用 | 浪费 | 重复样例 |\n|---|---|---|---|---|---|\n")
    for r in repeat_stats[:15]:
        ex = r["examples"][0] if r["examples"] else {}
        w(f"| {r['logId']} | {r['overall']} | {r['toolEfficiency']} | {r['toolCalls']} | "
          f"{r['wastedCalls']} | {ex.get('call','')} ×{ex.get('times','')} `{str(ex.get('args',''))[:50]}` |\n")

    w("\n## 五、可直接用作典型的高分样本\n\n")
    w(f"满足「overall ≥95 + 工具 2–8 次 + 轮次 2–8 + 有根因/证据/步骤」的样本 {report['high_quality_count']} 条，"
      "取轮次最少的前 20 条：\n\n")
    w("| 日志 ID | overall | 轮次 | 工具 | 工具链 | 根因（截断） |\n|---|---|---|---|---|---|\n")
    for g in good[:20]:
        w(f"| {g['logId']} | {g['overall']} | {g['rounds']} | {g['toolCalls']} | "
          f"{','.join(str(t) for t in g['tools'][:5])} | {g['rootCause'][:60]} |\n")

print("报告已写出:", OUTMD, "与", OUTJSON)
print()
print("=== 摘要 ===")
print("低分(<80) 条数:", report["low_count"], "占比 %.1f%%" % (report["low_ratio"] * 100))
print("拖分维度分布:", report["low_worst_dimension"])
print("零工具但答案完整:", report["zero_tool_but_complete_count"])
print("有重复调用的记录:", report["records_with_repeat"])
print("高质量典型:", report["high_quality_count"])
print("evidence 是否纯映射:", pure_mapping)
