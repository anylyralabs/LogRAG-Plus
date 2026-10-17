/**
 * 分析记录持久化与看板聚合。
 *
 * ## 为什么不能沿用 LogShare 的做法
 *
 * 生产环境的分析记录存在 Redis ZSET + 一个 602MB 的单文件归档
 * （`/app/runtime/logs/ai_analyses.log`）。要做任何统计都得把整文件读一遍，
 * 因此「低分样本长什么样」这种问题在实践中没人问得起。
 * 结果是评分体系的缺陷（证据分 = 工具调用次数）长期无人发现。
 *
 * 本模块把评分结果落进 SQLite 的**结构化表**，使下列查询变成一次索引扫描：
 *  - 某维度均值是否异常（比较各维度的区分度）；
 *  - 哪些分析分低且轮次高（提示词/停止条件问题）；
 *  - 扣分理由的分布（哪一类缺陷最常见）；
 *  - 同一份日志多次分析的结果差异（改动的效果对比）。
 *
 * ## 存什么、不存什么
 *
 * 存：分数、维度、轮次、工具调用摘要、结论字段、扣分理由、未命中的锚点。
 * 不存：日志正文与完整答案（体积大且已在会话表/LogShare 侧）。
 * 只留答案长度与结论摘要——统计需要的是**结构**，不是原文。
 */

import { randomUUID } from 'node:crypto';

import { getDb, registerMigration } from '../store/db.ts';
import { records as recordsCfg } from '../config.ts';
import type { StructuredConclusion } from '../agent/structured.ts';
import type { ScoreResult } from './scorer.ts';

// ── 表结构 ───────────────────────────────────────────────

registerMigration('analysis_records', (conn) => {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS analysis_records (
      id               TEXT PRIMARY KEY,
      created          INTEGER NOT NULL,
      session_id       TEXT NOT NULL,
      log_id           TEXT,
      provider         TEXT NOT NULL,
      model            TEXT NOT NULL,
      overall          INTEGER NOT NULL,
      deliverable      INTEGER NOT NULL,
      grounding        INTEGER,
      verification     INTEGER NOT NULL,
      actionability    INTEGER NOT NULL,
      economy          INTEGER NOT NULL,
      rounds           INTEGER NOT NULL,
      tool_calls       INTEGER NOT NULL,
      empty_calls      INTEGER NOT NULL,
      failed_calls     INTEGER NOT NULL,
      tool_names       TEXT NOT NULL,
      root_cause       TEXT NOT NULL,
      confidence       REAL,
      evidence_count   INTEGER NOT NULL,
      steps_count      INTEGER NOT NULL,
      grounding_recall REAL,
      deductions       TEXT NOT NULL,
      missing_anchors  TEXT NOT NULL,
      answer_chars     INTEGER NOT NULL
    );
  `);
  conn.exec('CREATE INDEX IF NOT EXISTS idx_analysis_created ON analysis_records(created);');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_analysis_overall ON analysis_records(overall);');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_analysis_log ON analysis_records(log_id);');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_analysis_model ON analysis_records(model);');
});

// ── 写入 ─────────────────────────────────────────────────

export interface SaveRecordInput {
  sessionId: string;
  logId: string | null;
  provider: string;
  model: string;
  rounds: number;
  answerChars: number;
  score: ScoreResult;
  /** 结构化结论（用于落根因、置信度、证据/步骤条数） */
  conclusion: StructuredConclusion;
  toolCalls: Array<{ name: string; result: string; ok: boolean }>;
}

/** 工具返回「没有内容」的判据（与评分器保持一致） */
const EMPTY_MARKERS = [
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
  return EMPTY_MARKERS.some((m) => low.includes(m));
}

/** 落一条分析记录，返回记录 ID */
export function saveAnalysisRecord(input: SaveRecordInput): string {
  const db = getDb();
  const id = `ar_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const d = input.score.dimensions;

  const toolNames = [...new Set(input.toolCalls.map((c) => c.name))];
  const failedCalls = input.toolCalls.filter((c) => !c.ok).length;
  // 只统计**成功但没内容**的调用。失败的调用单独归为 failedCalls——
  // 同一个调用既算「失败」又算「空结果」会在聚合里被重复计入，
  // 让「检索方向错」与「工具不可用」这两类问题的比例失真。
  const emptyCalls = input.toolCalls.filter((c) => c.ok && isEmptyResult(c.result)).length;

  const c = input.conclusion;

  db.prepare(
    `INSERT INTO analysis_records (
       id, created, session_id, log_id, provider, model,
       overall, deliverable, grounding, verification, actionability, economy,
       rounds, tool_calls, empty_calls, failed_calls, tool_names,
       root_cause, confidence, evidence_count, steps_count,
       grounding_recall, deductions, missing_anchors, answer_chars
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    Math.floor(Date.now() / 1000),
    input.sessionId,
    input.logId,
    input.provider,
    input.model,
    input.score.overall,
    input.score.deliverable ? 1 : 0,
    d.grounding.score,
    d.verification.score ?? 0,
    d.actionability.score ?? 0,
    d.economy.score ?? 0,
    input.rounds,
    input.toolCalls.length,
    emptyCalls,
    failedCalls,
    JSON.stringify(toolNames),
    c.rootCause.slice(0, 500),
    c.confidence,
    c.evidence.length,
    c.steps.length,
    input.score.groundingDetail.recall,
    JSON.stringify(input.score.deductions.slice(0, 10)),
    JSON.stringify(input.score.groundingDetail.anchors.missing.slice(0, 10).map((a) => a.text)),
    input.answerChars,
  );

  return id;
}

// ── 查询 ─────────────────────────────────────────────────

export interface AnalysisRecord {
  id: string;
  created: number;
  sessionId: string;
  logId: string | null;
  provider: string;
  model: string;
  overall: number;
  deliverable: boolean;
  grounding: number | null;
  verification: number;
  actionability: number;
  economy: number;
  rounds: number;
  toolCalls: number;
  emptyCalls: number;
  failedCalls: number;
  toolNames: string[];
  rootCause: string;
  confidence: number | null;
  evidenceCount: number;
  stepsCount: number;
  groundingRecall: number | null;
  deductions: string[];
  missingAnchors: string[];
  answerChars: number;
}

interface Row {
  id: string;
  created: number;
  session_id: string;
  log_id: string | null;
  provider: string;
  model: string;
  overall: number;
  deliverable: number;
  grounding: number | null;
  verification: number;
  actionability: number;
  economy: number;
  rounds: number;
  tool_calls: number;
  empty_calls: number;
  failed_calls: number;
  tool_names: string;
  root_cause: string;
  confidence: number | null;
  evidence_count: number;
  steps_count: number;
  grounding_recall: number | null;
  deductions: string;
  missing_anchors: string;
  answer_chars: number;
}

function parseJsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(r: Row): AnalysisRecord {
  return {
    id: r.id,
    created: r.created,
    sessionId: r.session_id,
    logId: r.log_id,
    provider: r.provider,
    model: r.model,
    overall: r.overall,
    deliverable: r.deliverable === 1,
    grounding: r.grounding,
    verification: r.verification,
    actionability: r.actionability,
    economy: r.economy,
    rounds: r.rounds,
    toolCalls: r.tool_calls,
    emptyCalls: r.empty_calls,
    failedCalls: r.failed_calls,
    toolNames: parseJsonArray(r.tool_names),
    rootCause: r.root_cause,
    confidence: r.confidence,
    evidenceCount: r.evidence_count,
    stepsCount: r.steps_count,
    groundingRecall: r.grounding_recall,
    deductions: parseJsonArray(r.deductions),
    missingAnchors: parseJsonArray(r.missing_anchors),
    answerChars: r.answer_chars,
  };
}

export interface RecordFilter {
  /** 最低总分（含） */
  minScore?: number;
  /** 最高总分（含） */
  maxScore?: number;
  /** 仅可交付 / 仅不可交付 */
  deliverable?: boolean;
  logId?: string;
  model?: string;
  /** 起始时间（秒） */
  since?: number;
  /** 结束时间（秒） */
  until?: number;
  /** 返回条数上限，默认 50，硬上限 `records.maxPageSize` */
  limit?: number;
  offset?: number;
  /** 排序字段 */
  orderBy?: 'created' | 'overall' | 'rounds' | 'tool_calls';
  /** 升序（默认降序） */
  ascending?: boolean;
}

const ORDERABLE: ReadonlySet<string> = new Set(['created', 'overall', 'rounds', 'tool_calls']);

/**
 * 分页查询分析记录。
 *
 * `limit` 会被夹到 `records.maxPageSize`——HTTP 层不得放宽，
 * 否则一次请求就能把整张表读出来（这是 LogShare 那边踩过的坑：
 * 内部聚合调用方必须显式放宽上限，而不是靠 HTTP 参数透传）。
 */
export function listAnalysisRecords(filter: RecordFilter = {}): AnalysisRecord[] {
  const db = getDb();

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filter.minScore !== undefined) {
    where.push('overall >= ?');
    params.push(filter.minScore);
  }
  if (filter.maxScore !== undefined) {
    where.push('overall <= ?');
    params.push(filter.maxScore);
  }
  if (filter.deliverable !== undefined) {
    where.push('deliverable = ?');
    params.push(filter.deliverable ? 1 : 0);
  }
  if (filter.logId !== undefined) {
    where.push('log_id = ?');
    params.push(filter.logId);
  }
  if (filter.model !== undefined) {
    where.push('model = ?');
    params.push(filter.model);
  }
  if (filter.since !== undefined) {
    where.push('created >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push('created <= ?');
    params.push(filter.until);
  }

  const orderCol = filter.orderBy !== undefined && ORDERABLE.has(filter.orderBy) ? filter.orderBy : 'created';
  const dir = filter.ascending === true ? 'ASC' : 'DESC';

  const rawLimit = filter.limit ?? 50;
  const limit = Math.max(1, Math.min(Math.trunc(rawLimit), recordsCfg.maxPageSize));
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

  const sql =
    `SELECT * FROM analysis_records` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${orderCol} ${dir} LIMIT ? OFFSET ?`;

  const rows = db.prepare(sql).all(...params, limit, offset) as unknown as Row[];
  return rows.map(toRecord);
}

/** 取单条记录 */
export function getAnalysisRecord(id: string): AnalysisRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM analysis_records WHERE id = ?').get(id) as unknown as Row | undefined;
  return row === undefined ? null : toRecord(row);
}

/**
 * 看板统计。
 *
 * `pageSize` 显式放宽到 `records.maxAggregateRows`：聚合必须看到全量样本，
 * 否则「均值」会静默退化为「最近 N 条的均值」。
 */
export function analysisStats(since?: number): AnalysisStats {
  const db = getDb();

  const maxRows = recordsCfg.maxAggregateRows;
  const sinceClause = since === undefined ? '' : ' WHERE created >= ?';
  const params: number[] = since === undefined ? [] : [since];

  // 先看总量，超过聚合上限时在返回值里显式标记「已截断」，
  // 而不是悄悄只统计一部分（静默的统计口径错误比不统计更糟）。
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM analysis_records${sinceClause}`).get(...params) as
    | { n: number }
    | undefined;
  const total = totalRow?.n ?? 0;
  const truncated = total > maxRows;

  const rows = db
    .prepare(`SELECT * FROM analysis_records${sinceClause} ORDER BY created DESC LIMIT ?`)
    .all(...params, maxRows) as unknown as Row[];

  if (rows.length === 0) {
    return {
      total: 0,
      sampled: 0,
      truncated: false,
      avgOverall: null,
      dimensions: { grounding: null, verification: null, actionability: null, economy: null },
      deliverableRate: null,
      avgRounds: null,
      avgToolCalls: null,
      scoreBuckets: {},
      topDeductions: [],
      byModel: {},
      lowScoreCount: 0,
    };
  }

  const avg = (pick: (r: Row) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  };

  const buckets: Record<string, number> = {};
  for (const r of rows) {
    const lo = Math.floor(r.overall / 10) * 10;
    const key = `${lo}-${lo + 9}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }

  // 扣分理由的词频。理由里带具体数字（如「有 3 次…」）会造成同一类缺陷被拆成多键，
  // 故先抹掉数字再计数——聚合要的是「哪一类问题最常见」。
  const deductionCount = new Map<string, number>();
  for (const r of rows) {
    for (const raw of parseJsonArray(r.deductions)) {
      const key = raw.replace(/\d+/g, 'N').slice(0, 120);
      deductionCount.set(key, (deductionCount.get(key) ?? 0) + 1);
    }
  }
  const topDeductions = [...deductionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([text, count]) => ({ text, count }));

  const byModel: Record<string, { count: number; avgOverall: number }> = {};
  const modelAgg = new Map<string, number[]>();
  for (const r of rows) {
    const arr = modelAgg.get(r.model) ?? [];
    arr.push(r.overall);
    modelAgg.set(r.model, arr);
  }
  for (const [model, arr] of modelAgg) {
    byModel[model] = {
      count: arr.length,
      avgOverall: Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10,
    };
  }

  return {
    total,
    sampled: rows.length,
    truncated,
    avgOverall: avg((r) => r.overall),
    dimensions: {
      grounding: avg((r) => r.grounding),
      verification: avg((r) => r.verification),
      actionability: avg((r) => r.actionability),
      economy: avg((r) => r.economy),
    },
    deliverableRate:
      Math.round((rows.filter((r) => r.deliverable === 1).length / rows.length) * 1000) / 1000,
    avgRounds: avg((r) => r.rounds),
    avgToolCalls: avg((r) => r.tool_calls),
    scoreBuckets: buckets,
    topDeductions,
    byModel,
    lowScoreCount: rows.filter((r) => r.overall < 70).length,
  };
}

export interface AnalysisStats {
  total: number;
  /** 参与聚合的样本数 */
  sampled: number;
  /** 样本量超过聚合上限，统计只覆盖最近 `sampled` 条 */
  truncated: boolean;
  avgOverall: number | null;
  dimensions: {
    grounding: number | null;
    verification: number | null;
    actionability: number | null;
    economy: number | null;
  };
  deliverableRate: number | null;
  avgRounds: number | null;
  avgToolCalls: number | null;
  scoreBuckets: Record<string, number>;
  topDeductions: Array<{ text: string; count: number }>;
  byModel: Record<string, { count: number; avgOverall: number }>;
  lowScoreCount: number;
}

/**
 * 清除超过保留期的记录。
 *
 * 返回删除条数。保留期由 `records.retentionDays` 控制（默认 90 天）。
 */
export function purgeAnalysisRecords(): number {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - recordsCfg.retentionDays * 86400;
  const res = db.prepare('DELETE FROM analysis_records WHERE created < ?').run(cutoff);
  return Number(res.changes);
}

/** 记录总数（诊断用） */
export function countAnalysisRecords(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM analysis_records').get() as { n: number } | undefined;
  return row?.n ?? 0;
}
