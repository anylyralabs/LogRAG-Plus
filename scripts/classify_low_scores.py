#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把低分记录分成「可归因的失败类型」，产出处置计划。

## 为什么需要这一步

第一轮复核把 851 条 low 记录混在一起看，得出的结论是模糊的——
「toolEfficiency 拖分 508 条」并不能告诉你要改什么。真正的处置取决于
**低分的原因属于哪一类**：

  | 类型 | 本质 | 该改什么 |
  |---|---|---|
  | 正确但被低估 | 评分规则的缺陷 | 评分器（不改模型行为） |
  | 工具调用格式失败 | 模型输出了裸 `<tool_call>` 文本 | 提示词 + 工具调用协议 |
  | 轮次失控 | 停止条件不足 | 提示词（适可而止）+ 硬性轮次上限 |
  | 未产出结构化结论 | 输出规格未被遵守 | 输出规格 + 结果校验 |

## 一个必须记住的数据限制

归档字段 `fullAnswerSnippet` **被截断在 300 字**（9353 条里 9197 条正好 300）。
因此**不能**用答案长度判断质量；判断依据只能是 `rootCause`、
`validation.structuredOutput` 与轮次/工具特征。

输出：data/corpus/low_score_plan.md / .json
"""
import json
import os
import collections
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data/corpus/analyses_compact.jsonl")
OUTMD = os.path.join(ROOT, "data/corpus/low_score_plan.md")
OUTJSON = os.path.join(ROOT, "data/corpus/low_score_plan.json")

records = []
with open(SRC, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))


def sc(r):
    return r.get("score") or {}


def overall(r):
    v = sc(r).get("overall")
    return v if isinstance(v, (int, float)) else None


def root_cause(r):
    so = (r.get("structuredOutput") or {})
    return str(so.get("rootCause") or r.get("rootCause") or "").strip()


def has_structure(r):
    so = r.get("structuredOutput") or {}
    return bool(so.get("rootCause")) and len(so.get("steps") or []) > 0


RAW_TOOLCALL = re.compile(r"<tool_call|<function=|```json\s*\{\s*\"rootCause\"")


def classify(r):
    """给一条记录打类型标签（互斥，按优先级）"""
    ans = str(r.get("fullAnswer") or "")
    rounds = r.get("rounds") or 0
    tools = r.get("toolCallsCount") or 0
    rc = root_cause(r)

    # B：工具调用格式失败——答案为空，或把工具调用写成了正文文本
    if ans.strip() == "" or (tools == 0 and "<tool_call" in ans and "##" not in ans):
        return "format_failure"

    # D：没产出结论
    if rc == "":
        return "no_conclusion"

    # C：轮次失控
    if rounds >= 10:
        return "runaway_rounds"

    # A：正确但被低估——结论完整、轮次极少、工具为零或极少
    if tools <= 1 and rounds <= 2 and has_structure(r):
        return "correct_underrated"

    return "other"


buckets = collections.defaultdict(list)
for r in records:
    o = overall(r)
    if o is None or o >= 80:
        continue
    buckets[classify(r)].append(r)

print("=== 低分（<80）样本分类 ===")
for k, v in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: {len(v)}")

# 各类型的分数区间与特征
detail = {}
for k, rows in buckets.items():
    ovs = [overall(r) for r in rows if overall(r) is not None]
    detail[k] = {
        "count": len(rows),
        "overall_min": min(ovs) if ovs else None,
        "overall_max": max(ovs) if ovs else None,
        "overall_avg": round(sum(ovs) / len(ovs), 1) if ovs else None,
        "avg_rounds": round(sum((r.get("rounds") or 0) for r in rows) / len(rows), 2),
        "avg_tools": round(sum((r.get("toolCallsCount") or 0) for r in rows) / len(rows), 2),
        "avg_evidence": round(
            sum((sc(r).get("evidenceSufficiency") or 0) for r in rows) / len(rows), 1
        ),
        "avg_tool_eff": round(sum((sc(r).get("toolEfficiency") or 0) for r in rows) / len(rows), 1),
    }

# 「正确但被低估」是最重要的一类：给出全部清单（用于改评分器与做回归）
underrated = sorted(buckets["correct_underrated"], key=lambda r: overall(r) or 0)

# 顺手统计：全量里「结论完整 + 0 工具」的记录总数（不限低分）
zerotool_complete = [
    r for r in records
    if (r.get("toolCallsCount") or 0) == 0 and has_structure(r)
]
print()
print(f"=== 全量「0 工具但结论完整」记录: {len(zerotool_complete)} 条 ===")
zo = [overall(r) for r in zerotool_complete if overall(r) is not None]
if zo:
    print(f"  overall 区间 {min(zo)}–{max(zo)}，均值 {sum(zo)/len(zo):.1f}")
    print("  overall 分布:", dict(collections.Counter(int(v // 10) * 10 for v in zo).most_common()))

# 对照：1–3 次工具且结论完整的记录
fewtool_complete = [
    r for r in records
    if 1 <= (r.get("toolCallsCount") or 0) <= 3 and has_structure(r)
]
fo = [overall(r) for r in fewtool_complete if overall(r) is not None]
if fo:
    print(f"=== 1–3 工具且结论完整: {len(fewtool_complete)} 条，overall 均值 {sum(fo)/len(fo):.1f} ===")

plan = {
    "total": len(records),
    "buckets": detail,
    "zero_tool_complete": {
        "count": len(zerotool_complete),
        "overall_avg": round(sum(zo) / len(zo), 1) if zo else None,
        "overall_min": min(zo) if zo else None,
        "overall_max": max(zo) if zo else None,
    },
    "few_tool_complete": {
        "count": len(fewtool_complete),
        "overall_avg": round(sum(fo) / len(fo), 1) if fo else None,
    },
    "samples": {
        "correct_underrated": [
            {
                "logId": r.get("logId"),
                "cacheKey": r.get("cacheKey"),
                "overall": overall(r),
                "evidence": sc(r).get("evidenceSufficiency"),
                "toolEfficiency": sc(r).get("toolEfficiency"),
                "rounds": r.get("rounds"),
                "tools": r.get("toolCallsCount"),
                "rootCause": root_cause(r)[:200],
            }
            for r in underrated[:80]
        ],
        "format_failure": [
            {
                "logId": r.get("logId"),
                "overall": overall(r),
                "rounds": r.get("rounds"),
                "answerHead": str(r.get("fullAnswer") or "")[:120],
            }
            for r in buckets["format_failure"][:30]
        ],
        "runaway_rounds": [
            {
                "logId": r.get("logId"),
                "overall": overall(r),
                "rounds": r.get("rounds"),
                "tools": r.get("toolCallsCount"),
                "toolEfficiency": sc(r).get("toolEfficiency"),
                "rootCause": root_cause(r)[:140],
            }
            for r in sorted(buckets["runaway_rounds"], key=lambda r: -(r.get("rounds") or 0))[:30]
        ],
        "no_conclusion": [
            {
                "logId": r.get("logId"),
                "overall": overall(r),
                "rounds": r.get("rounds"),
                "answerHead": str(r.get("fullAnswer") or "")[:120],
            }
            for r in buckets["no_conclusion"][:30]
        ],
    },
}

with open(OUTJSON, "w", encoding="utf-8") as f:
    json.dump(plan, f, ensure_ascii=False, indent=2)

with open(OUTMD, "w", encoding="utf-8") as f:
    w = f.write
    w("# 低分记录归因与处置计划\n\n")
    w(f"样本：{len(records)} 条分析记录；其中 overall < 80 的 "
      f"{sum(len(v) for v in buckets.values())} 条。\n\n")

    w("## 一、分类统计\n\n")
    w("| 类型 | 条数 | overall 区间 | 均值 | 平均轮次 | 平均工具 | 平均证据分 | 平均效率分 |\n")
    w("|---|---|---|---|---|---|---|---|\n")
    for k, v in sorted(detail.items(), key=lambda kv: -kv[1]["count"]):
        w(f"| {k} | {v['count']} | {v['overall_min']}–{v['overall_max']} | {v['overall_avg']} | "
          f"{v['avg_rounds']} | {v['avg_tools']} | {v['avg_evidence']} | {v['avg_tool_eff']} |\n")

    w("\n## 二、核心病灶：评分器把「不需要工具」当成「没有证据」\n\n")
    w(f"- 全量中「0 次工具调用 **且** 结论完整（有根因 + 有步骤）」的记录：**{len(zerotool_complete)} 条**，")
    w(f"overall 区间 {plan['zero_tool_complete']['overall_min']}–{plan['zero_tool_complete']['overall_max']}，"
      f"均值 **{plan['zero_tool_complete']['overall_avg']}**。\n")
    w(f"- 对照「1–3 次工具且结论完整」的记录：{len(fewtool_complete)} 条，"
      f"overall 均值 **{plan['few_tool_complete']['overall_avg']}**。\n\n")
    w("两组的结论完整度没有差别，分数却差十几分——差别只在于**调没调工具**。\n\n")
    w("处置：LogRAG+ 的评分器不能沿用这条规则。证据充分性应衡量"
      "「结论中的每条断言能否在日志或检索结果里找到对应文字」，"
      "而不是「调用过几次工具」。\n\n")

    w("## 三、类型 A：正确但被低估（优先处置）\n\n")
    w(f"共 {len(underrated)} 条。全部清单见 `low_score_plan.json` 的 `samples.correct_underrated`。\n\n")
    w("| 日志 ID | overall | 证据分 | 效率分 | 轮次 | 工具 | 根因（截断） |\n|---|---|---|---|---|---|---|\n")
    for r in underrated[:25]:
        w(f"| {r.get('logId')} | {overall(r)} | {sc(r).get('evidenceSufficiency')} | "
          f"{sc(r).get('toolEfficiency')} | {r.get('rounds')} | {r.get('toolCallsCount')} | "
          f"{root_cause(r)[:60]} |\n")

    w("\n## 四、类型 B：工具调用格式失败\n\n")
    w(f"共 {len(buckets['format_failure'])} 条。特征是答案为空，或把工具调用写成了正文文本"
      "（例如整条答案是 `<tool_call> <function=list_log_files/>`）。\n\n")
    w("| 日志 ID | overall | 轮次 | 答案开头 |\n|---|---|---|---|\n")
    for r in buckets["format_failure"][:20]:
        head = str(r.get("fullAnswer") or "")[:70].replace("\n", " ").replace("|", "\\|")
        w(f"| {r.get('logId')} | {overall(r)} | {r.get('rounds')} | `{head}` |\n")

    w("\n## 五、类型 C：轮次失控\n\n")
    w(f"共 {len(buckets['runaway_rounds'])} 条（轮次 ≥10）。\n\n")
    w("| 日志 ID | overall | 轮次 | 工具 | 效率分 | 根因（截断） |\n|---|---|---|---|---|---|\n")
    for r in sorted(buckets["runaway_rounds"], key=lambda r: -(r.get("rounds") or 0))[:20]:
        w(f"| {r.get('logId')} | {overall(r)} | {r.get('rounds')} | {r.get('toolCallsCount')} | "
          f"{sc(r).get('toolEfficiency')} | {root_cause(r)[:50]} |\n")

    w("\n## 六、类型 D：未产出结构化结论\n\n")
    w(f"共 {len(buckets['no_conclusion'])} 条（根因为空）。\n\n")
    w("| 日志 ID | overall | 轮次 | 答案开头 |\n|---|---|---|---|\n")
    for r in buckets["no_conclusion"][:20]:
        head = str(r.get("fullAnswer") or "")[:70].replace("\n", " ").replace("|", "\\|")
        w(f"| {r.get('logId')} | {overall(r)} | {r.get('rounds')} | `{head}` |\n")

    w("\n## 七、数据限制（写报告时必须记住）\n\n")
    w("归档字段 `fullAnswerSnippet` 被**截断在 300 字**——9353 条里 9197 条正好 300 字。\n")
    w("因此：\n")
    w("- 不能用答案长度判断答案质量；\n")
    w("- 「零工具但答案完整」这类判据若用答案长度做门槛，会永远命中不了（第一轮复核即踩此坑）；\n")
    w("- 判断结论质量只能依据 `rootCause` 与 `validation.structuredOutput`。\n")

print()
print("报告已写出:", OUTMD)
