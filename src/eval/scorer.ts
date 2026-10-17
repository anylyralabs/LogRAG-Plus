/**
 * 分析质量评分器。
 *
 * ## 为什么要重写，而不是沿用生产环境那套
 *
 * 线上 9353 条分析记录的评分体系有三个可被数据证实的缺陷：
 *
 * ### 缺陷一：证据分 = 工具调用次数（最严重）
 *
 * `evidenceSufficiency` 是工具次数的阶跃函数（0→20、1→60、2→80、≥3→95）。
 * 后果：
 * - 「0 次工具 + 结论完整（有根因且有步骤）」的记录共 **253 条，overall 全部恰好等于 68**；
 * - 「1–3 次工具 + 同样结论完整」的记录 1478 条，overall 均值 **93.3**。
 *
 * 两组结论质量没有差别，25 分的差距完全来自「调没调工具」。
 * 而「不需要工具」恰恰是对**特征明确、单点报错**的日志最正确的处理方式——
 * 系统却在惩罚它。这会让模型学会「为了拿分而乱调工具」，
 * 生产数据里 `grep_log_file` 有 41% 的调用毫无命中正是这种激励的产物。
 *
 * ### 缺陷二：效率分把「探索」与「浪费」混为一谈
 *
 * `toolEfficiency` 与**空结果调用次数**强相关（0 次→100、1 次→85、2 次→70、3 次→55、4 次→0），
 * 与重复调用几乎无关（重复同参数的记录只有 47 条）。
 * 但「检索没命中」有两种完全不同的成因：
 * - **方向错了**：同一条查询反复问（真正该扣）；
 * - **日志里就是没有**：换个词继续试（这是必要的探索，不该扣）。
 *
 * ### 缺陷三：结论明确性几乎恒满分
 *
 * `conclusionClarity` 均值 99.54，四维里最没有区分度——它实际上没在起作用。
 *
 * ## 本评分器的设计原则
 *
 * 1. **证据分衡量文本，不衡量行为**：结论里的每个可核实标识能否在
 *    日志正文或工具返回里找到（见 `anchors.ts`）。不调工具但引用准确 = 满分。
 * 2. **无证据可核实时，该维度返回 `null` 并从加权中剔除**，
 *    而不是给个凑数的分数。纯对话（没有日志）不该被证据分影响。
 * 3. **效率分对「零调用」中性**：省着用工具不加分，也不扣分。
 * 4. **诚实标注不确定是加分项**，不是扣分项——含糊地假装确定才扣分。
 */

import type { StructuredConclusion } from '../agent/structured.ts';
import { extractAnchors, verifyAnchors, type VerificationResult } from './anchors.ts';

/** 一次工具调用（由运行器收集） */
export interface ToolCallRecord {
  round: number;
  name: string;
  args: unknown;
  /** 工具返回的文本 */
  result: string;
  ok: boolean;
}

export interface ScoreInput {
  /** 最终答复全文 */
  answer: string;
  /** 结构化结论（提取失败时 `ok === false`） */
  conclusion: StructuredConclusion;
  /**
   * 日志正文。
   *
   * 没有任何日志时为 `null`——此时证据维度**不适用**（见文件头原则 2）。
   */
  logText: string | null;
  /** 工具调用链 */
  toolCalls: ToolCallRecord[];
  /** 轮次 */
  rounds: number;
}

export interface DimensionScore {
  name: string;
  /** 0–100；`null` 表示本维度不适用，不参与加权 */
  score: number | null;
  weight: number;
  /** 扣分/加分的具体理由（面向人） */
  notes: string[];
}

export interface ClaimGrounding {
  claim: string;
  /** 该断言提取到的锚点数 */
  anchors: number;
  /** 命中的锚点数 */
  found: number;
  /** 该断言的得分 0–1 */
  score: number;
  /** 未命中的锚点原文 */
  missing: string[];
}

export interface GroundingDetail {
  /** 语料字符数（日志 + 工具返回，已截断） */
  corpusChars: number;
  /** 锚点级汇总 */
  anchors: VerificationResult;
  /** 断言级明细 */
  claims: ClaimGrounding[];
  /** 命中率 0–1；`null` 表示没有可核实的锚点 */
  recall: number | null;
}

export interface ScoreResult {
  /** 加权总分 0–100 */
  overall: number;
  dimensions: {
    grounding: DimensionScore;
    verification: DimensionScore;
    actionability: DimensionScore;
    economy: DimensionScore;
  };
  groundingDetail: GroundingDetail;
  /** 全部扣分理由的汇总（面向运维） */
  deductions: string[];
  /**
   * 是否可作为可交付答案。
   *
   * 这不是分数阈值，而是一组**必要条件**：有根因、有落地证据、没在瞎猜。
   * 评分用于横向比较，`deliverable` 用于要不要直接给用户看。
   */
  deliverable: boolean;
}

const WEIGHTS = {
  grounding: 0.4,
  verification: 0.2,
  actionability: 0.25,
  economy: 0.15,
} as const;

/** 语料上限：锚点校验是子串查找，语料过大只会拖慢而无收益 */
const MAX_CORPUS_CHARS = 2_000_000;

/** 一次工具调用返回「没有内容」的判据（与检索预算判定保持一致） */
const EMPTY_RESULT_MARKERS = [
  '未找到',
  '没有找到',
  '无结果',
  '没有结果',
  'no results',
  'not found',
  '未检索到',
  '没有检索到',
  '未匹配',
  '无匹配',
  '未命中',
  '没有命中',
];

function isEmptyResult(result: string): boolean {
  const r = result.trim();
  if (r.length < 20) return true;
  const low = r.toLowerCase();
  return EMPTY_RESULT_MARKERS.some((m) => low.includes(m));
}

/** 修复动作动词（用于判定「结论是否可操作」） */
const ACTION_VERBS = [
  '安装',
  '卸载',
  '删除',
  '移除',
  '更新',
  '升级',
  '降级',
  '替换',
  '改为',
  '切换',
  '添加',
  '关闭',
  '禁用',
  '启用',
  '调整',
  '修改',
  '下载',
  '重新安装',
  '回退',
  '调大',
  '调小',
];

/** 只排查不修复的表述（出现这些而无动作动词时扣分） */
const DIAGNOSE_ONLY = ['检查一下', '查看是否', '可以尝试排查', '建议排查', '进一步确认', '需要更多信息'];

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * 证据落地性。
 *
 * 三种情形必须区分开：
 *  - 有语料 + 有锚点 → 按命中率打分（这是主路径）；
 *  - 有语料 + 无锚点 → 结论完全是叙述性的，无从核实，打低分；
 *  - 无语料 → `null`（不适用），**不打分**。
 */
function scoreGrounding(input: ScoreInput): { dimension: DimensionScore; detail: GroundingDetail } {
  const notes: string[] = [];

  const hasLog = input.logText !== null && input.logText.trim() !== '';
  const toolText = input.toolCalls.map((c) => c.result).join('\n');
  const hasToolText = toolText.trim() !== '';

  if (!hasLog && !hasToolText) {
    notes.push('没有日志正文也没有工具返回，证据落地性无从核实——本维度不参与评分（按不适用处理）。');
    return {
      dimension: { name: 'grounding', score: null, weight: WEIGHTS.grounding, notes },
      detail: { corpusChars: 0, anchors: { total: 0, found: 0, recall: null, hits: [], missing: [] }, claims: [], recall: null },
    };
  }

  let corpus = `${input.logText ?? ''}\n${toolText}`;
  if (corpus.length > MAX_CORPUS_CHARS) corpus = corpus.slice(0, MAX_CORPUS_CHARS);

  // 断言集合：优先用结构化输出里的 evidence；没有则退化为「根因本身是一条断言」。
  //
  // **根因的权重高于单条证据**（2 : 1）：根因是要交付给用户的结论本身，
  // 一条编造的根因不该被三条正确的旁证「平均」掉。等权会让
  // 「证据都对但结论是编的」这种情况拿到高分，而这恰恰是最危险的输出。
  const claims: Array<{ text: string; weight: number }> = [];
  if (input.conclusion.rootCause.trim() !== '') {
    claims.push({ text: input.conclusion.rootCause, weight: 2 });
  }
  for (const e of input.conclusion.evidence) {
    if (e.trim() !== '') claims.push({ text: e, weight: 1 });
  }

  if (claims.length === 0) {
    notes.push('结论为空，没有任何可供核实的断言。');
    return {
      dimension: { name: 'grounding', score: 0, weight: WEIGHTS.grounding, notes },
      detail: { corpusChars: corpus.length, anchors: { total: 0, found: 0, recall: null, hits: [], missing: [] }, claims: [], recall: null },
    };
  }

  const claimResults: ClaimGrounding[] = [];
  const allAnchors = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const { text: claim, weight } of claims) {
    const anchors = extractAnchors(claim);
    allAnchors.push(...anchors);
    weightTotal += weight;

    if (anchors.length === 0) {
      // 一条自称是证据、却没有引用任何具体标识的断言：无从核实。
      // 比「引用了但没找到」更差——后者至少给出了可证伪的引用。
      claimResults.push({ claim, anchors: 0, found: 0, score: 0, missing: [] });
      continue;
    }

    const v = verifyAnchors(anchors, corpus);
    const s = v.recall ?? 0;
    weightedSum += s * weight;
    claimResults.push({
      claim,
      anchors: v.total,
      found: v.found,
      score: s,
      missing: v.missing.map((a) => a.text),
    });
  }

  const recall = weightTotal === 0 ? 0 : weightedSum / weightTotal;

  // 断言级命中率为主，锚点级命中率为辅：后者能识别「证据堆了一堆但一半是编的」
  const anchorV = verifyAnchors(allAnchors, corpus);
  const combined = anchorV.recall === null ? recall : recall * 0.7 + anchorV.recall * 0.3;

  const noAnchorClaims = claimResults.filter((c) => c.anchors === 0).length;
  if (noAnchorClaims > 0) {
    notes.push(
      `${noAnchorClaims} 条断言完全没有引用可核实的具体标识（异常类名/文件名/版本号/配置项/原文片段），无从核实，按 0 分计入。`,
    );
  }

  if (anchorV.missing.length > 0) {
    const sample = anchorV.missing.slice(0, 5).map((a) => a.text).join('、');
    notes.push(
      `有 ${anchorV.missing.length} 处引用在日志与工具返回中都找不到：${sample}${anchorV.missing.length > 5 ? ' 等' : ''}。可能是推测，也可能是被截断的语料之外的内容。`,
    );
  }

  if (input.toolCalls.length === 0 && combined >= 0.8) {
    notes.push('未使用任何工具，但结论中的引用能在日志正文里核对上——这是有效分析，不因未调用工具而扣分。');
  }

  return {
    dimension: { name: 'grounding', score: clamp100(combined * 100), weight: WEIGHTS.grounding, notes },
    detail: {
      corpusChars: corpus.length,
      anchors: anchorV,
      claims: claimResults,
      recall: combined,
    },
  };
}

/**
 * 声明可核实性。
 *
 * 这里**奖励诚实**：模型主动标注「未核实/无法确认/推测」不是为了扣它的分，
 * 而是为了奖励它。真正该扣的是「没有任何证据支撑却给出满置信度」。
 */
function scoreVerification(input: ScoreInput): DimensionScore {
  const notes: string[] = [];
  const c = input.conclusion;

  if (!c.ok) {
    notes.push(`未能提取结构化结论（${c.error ?? '原因未知'}）——前台无法渲染结构化卡片，结论也未被机器校验过。`);
    return { name: 'verification', score: 25, weight: WEIGHTS.verification, notes };
  }

  let score = 60;

  if (c.rootCause.trim() !== '') score += 15;
  else notes.push('结构化结论缺少根因字段。');

  if (c.evidence.length >= 1) score += 10;
  if (c.evidence.length >= 3) score += 5;
  if (c.evidence.length === 0) notes.push('结构化结论里没有任何证据条目。');

  if (c.steps.length >= 1) score += 5;
  if (c.steps.length === 0) notes.push('结构化结论里没有任何解决步骤。');

  // 置信度与证据量必须自洽
  if (c.confidence !== null) {
    if (c.confidence >= 0.9 && c.evidence.length === 0) {
      score -= 20;
      notes.push(`置信度 ${c.confidence} 但证据条目为 0——断言与支撑不自洽。`);
    } else if (c.confidence <= 0.8 && c.evidence.length > 0) {
      score += 5;
      notes.push('置信度未给满且列出了证据，属于有分寸的判断。');
    }
  } else {
    notes.push('未给出置信度，前台无法呈现确定性程度。');
  }

  // 诚实标注不确定 → 加分（这是好行为，必须被激励）
  const text = `${input.answer}\n${c.rootCause}`;
  if (/(未核实|无法确认|不确定|推测|可能|尚需确认|未能确定)/.test(text)) {
    score += 5;
    notes.push('对不确定之处作了显式标注——这是期望行为，不视为缺陷。');
  }

  return { name: 'verification', score: clamp100(score), weight: WEIGHTS.verification, notes };
}

/**
 * 结论可操作性。
 *
 * 面向的是「用户能不能照着做」：有步骤、步骤里带具体对象、有动作动词。
 * 只给「建议检查依赖」而无具体操作的结论，对玩家的价值接近 0。
 */
function scoreActionability(input: ScoreInput): DimensionScore {
  const notes: string[] = [];
  const c = input.conclusion;
  const text = `${input.answer}\n${c.steps.join('\n')}`;

  let score = 40;

  if (c.steps.length >= 1) score += 20;
  if (c.steps.length >= 2) score += 10;
  if (c.steps.length >= 4) score += 5;
  if (c.steps.length === 0) notes.push('没有给出任何解决步骤，用户拿到结论后不知道下一步做什么。');

  const anchoredSteps = c.steps.filter((s) => extractAnchors(s).length > 0).length;
  if (anchoredSteps >= 1) score += 15;
  if (anchoredSteps >= 2) score += 5;
  if (c.steps.length > 0 && anchoredSteps === 0) {
    notes.push('所有步骤都没有指向具体对象（文件名/版本号/配置项/命令），用户无法据此操作。');
  }

  const verbHits = ACTION_VERBS.filter((v) => text.includes(v));
  if (verbHits.length >= 1) score += 10;
  if (verbHits.length >= 3) score += 5;
  if (verbHits.length === 0) notes.push('通篇没有出现具体修复动作（安装/更新/替换/删除……），停留在描述问题。');

  const diagnoseOnly = DIAGNOSE_ONLY.filter((v) => text.includes(v));
  if (diagnoseOnly.length > 0 && verbHits.length === 0) {
    score -= 15;
    notes.push(`只有排查建议而无修复动作（命中：${diagnoseOnly.join('、')}）。`);
  }

  return { name: 'actionability', score: clamp100(score), weight: WEIGHTS.actionability, notes };
}

/**
 * 工具经济性。
 *
 * 与生产评分体系的根本区别：**零调用是中性值（100），不是低分**。
 * 扣分只针对可确证的浪费：
 *  - 同工具 + 完全同参数重复调用；
 *  - 连续多次同工具调用且结果全为空（方向性错误，不是探索）。
 */
function scoreEconomy(input: ScoreInput): DimensionScore {
  const notes: string[] = [];
  const calls = input.toolCalls;

  if (calls.length === 0) {
    notes.push('未使用工具。本项**不因未调用工具而扣分**——对特征明确的单点报错，直接作答是正确做法。');
    return { name: 'economy', score: 100, weight: WEIGHTS.economy, notes };
  }

  let score = 100;

  // 完全相同参数的重复调用 = 确证的浪费
  const seen = new Map<string, number>();
  let repeats = 0;
  for (const c of calls) {
    let key: string;
    try {
      key = `${c.name}|${JSON.stringify(c.args)}`;
    } catch {
      key = `${c.name}|${String(c.args)}`;
    }
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) repeats++;
  }
  if (repeats > 0) {
    score -= Math.min(50, repeats * 25);
    notes.push(`有 ${repeats} 次完全相同参数的重复调用（同工具同参数），属于可避免的浪费。`);
  }

  // 空结果调用：区分「探索」与「打转」。
  // 只统计**成功但没内容**的调用——失败的调用已经单独扣分，
  // 再计入空结果会重复惩罚（实测：一次超短失败返回同时命中两条规则）。
  const emptyIdx = calls.map((c, i) => (c.ok && isEmptyResult(c.result) ? i : -1)).filter((i) => i >= 0);
  const emptyRatio = emptyIdx.length / calls.length;

  if (emptyRatio >= 0.6 && calls.length >= 3) {
    score -= 25;
    notes.push(
      `${calls.length} 次调用里 ${emptyIdx.length} 次毫无命中（${Math.round(emptyRatio * 100)}%）——检索方向需要更换，而不是继续换词试。`,
    );
  } else if (emptyRatio >= 0.4 && calls.length >= 3) {
    score -= 10;
    notes.push(`${calls.length} 次调用里 ${emptyIdx.length} 次无命中，检索效率偏低。`);
  }

  const failed = calls.filter((c) => !c.ok).length;
  if (failed > 0) {
    score -= Math.min(20, failed * 5);
    notes.push(`有 ${failed} 次工具调用失败。`);
  }

  return { name: 'economy', score: clamp100(score), weight: WEIGHTS.economy, notes };
}

/** 计算分析质量评分 */
export function scoreAnalysis(input: ScoreInput): ScoreResult {
  const g = scoreGrounding(input);
  const v = scoreVerification(input);
  const a = scoreActionability(input);
  const e = scoreEconomy(input);

  const dims = [g.dimension, v, a, e];

  // 只在**适用**的维度上加权，权重重新归一化。
  // 这样「没有日志的纯对话」不会因为证据维度不适用而被压低总分。
  const applicable = dims.filter((d) => d.score !== null);
  const totalWeight = applicable.reduce((s, d) => s + d.weight, 0);
  const overall =
    totalWeight === 0
      ? 0
      : clamp100(applicable.reduce((s, d) => s + (d.score ?? 0) * d.weight, 0) / totalWeight);

  const deductions = dims.flatMap((d) => d.notes.filter((n) => n !== ''));

  const rootCauseOk = input.conclusion.rootCause.trim() !== '';
  const groundingOk = g.dimension.score === null || g.dimension.score >= 50;

  return {
    overall,
    dimensions: { grounding: g.dimension, verification: v, actionability: a, economy: e },
    groundingDetail: g.detail,
    deductions,
    deliverable: overall >= 70 && rootCauseOk && groundingOk,
  };
}

/** 生成面向模型的自评反馈（用于「重试一次」或后续轮次的提示词） */
export function buildScoreFeedback(result: ScoreResult): string {
  const lines: string[] = [`本次分析自评 ${result.overall} 分。`];

  const g = result.dimensions.grounding;
  if (g.score !== null && g.score < 70) {
    const missing = result.groundingDetail.anchors.missing.slice(0, 5).map((a) => a.text);
    lines.push(
      `证据落地性偏低（${g.score}）。结论中的引用需要能在日志或检索结果里逐字核对；` +
        (missing.length > 0 ? `以下引用未找到：${missing.join('、')}。` : '请补充具体标识（异常类名、文件名、版本号）。'),
    );
  }

  const a = result.dimensions.actionability;
  if (a.score !== null && a.score < 70) {
    lines.push(`结论可操作性偏低（${a.score}）。请给出用户可直接执行的动作（改哪个文件、换成哪个版本、删哪个目录）。`);
  }

  if (!result.deliverable) {
    lines.push('本次结论未达到可交付标准，请补足证据与操作步骤。');
  }

  return lines.join('\n');
}
