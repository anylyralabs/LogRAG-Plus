/**
 * Agent 运行器 —— 把 DeepAgents 的流映射到 SSE 协议。
 *
 * ## 实测确定的流结构（`streamMode: 'messages'`）
 * 每个 chunk 是 `[message, meta]`：
 *  - `meta.langgraph_node`：`model_request`（模型输出）或 `tools`（工具返回）
 *  - `AIMessageChunk.content`：正文增量（字符串）
 *  - `AIMessageChunk.additional_kwargs.reasoning_content`：**思维链增量**
 *  - `AIMessageChunk.tool_calls`：完整工具调用（含 id/name/args）
 *  - `AIMessageChunk.tool_call_chunks`：工具调用增量（args 分片）
 *  - `ToolMessage`：工具返回结果（含 name/content）
 *
 * ## SSE 映射
 * | 流事件 | SSE 帧 |
 * |---|---|
 * | reasoning_content 增量 | `event: status` + `{"type":"thinking","delta":"..."}` |
 * | tool_calls 完成 | `event: status` + `{"type":"tool","name":...,"arguments":...}` |
 * | ToolMessage | `event: status` + `{"type":"tool_result","name":...,"summary":...}` |
 * | content 增量 | `data: {"choices":[{"delta":{"content":"..."}}]}` |
 * | 流结束 | `event: done` + `{"status":"completed"}` |
 */

import { StateBackend, createDeepAgent, createFilesystemMiddleware } from 'deepagents';
import type { BaseMessage } from '@langchain/core/messages';

import { buildSystemPrompt, type PromptContext } from './prompt.ts';
import { createModel, type ProviderConfig } from './model.ts';
import { buildTools, type ToolContext } from './tools/index.ts';
import { StreamingSanitizer } from './sanitize.ts';
import {
  ToolCallTracker,
  type Announcement,
  type ChunkInput,
  type FullCallInput,
} from './tool-tracker.ts';
import { extractConclusion } from './structured.ts';
import { scoreAnalysis, type ScoreResult } from '../eval/scorer.ts';
import type { SseWriter } from '../server/sse.ts';
/** 工具结果摘要的最大字符数（进 SSE 帧的摘要，完整结果进模型上下文） */
const SUMMARY_MAX = 200;

/** 单次工具结果进模型的字节上限（超出则截断，避免上下文爆炸） */
const TOOL_RESULT_MAX_BYTES = 32_000;

/**
 * 每次工具返回在记录里保留的最大字符数。
 *
 * 与 `TOOL_RESULT_MAX_BYTES`（发给模型的单次上限）不同：这个上限只影响
 * **评分用**的留档。评语料越大，锚点校验越慢（逐个子串查找），
 * 100KB × 数十次调用已足以覆盖实际会引用的内容。
 */
const TOOL_RESULT_KEEP_MAX = 100_000;

export interface RunOptions {
  /** 用户消息（含日志内容） */
  userMessage: string;
  /** 历史消息（多轮对话） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 模型供应商 */
  provider: ProviderConfig;
  /** 工具上下文 */
  toolContext: ToolContext;
  /** 提示词上下文 */
  promptContext: PromptContext;
  /** 最大轮次 */
  maxRounds?: number;
  /** SSE 输出 */
  sse: SseWriter;
  /** 中止信号（客户端断开） */
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  /** 完整正文 */
  content: string;
  /** 完整思维链 */
  reasoning: string;
  /**
   * 工具调用记录。
   *
   * `result` 保留**较完整的原文**（上限 100KB/次）而非仅用于展示的摘要——
   * 证据落地性评分需要拿工具返回当语料，只有摘要就核不了引用。
   */
  toolCalls: Array<{ round: number; name: string; args: unknown; result: string; ok: boolean }>;
  /** 实际轮次 */
  rounds: number;
  /** 是否触及轮次上限 */
  hitLimit: boolean;
  /**
   * 质量自评（见 `src/eval/scorer.ts`）。
   *
   * 生产环境的评分体系把「调用过几次工具」当成「证据是否充分」，
   * 导致 253 条结论正确、零工具调用的分析全部得 68 分。本评分器按
   * **结论中的引用能否在日志/检索结果里核对上**打分，不按行为打分。
   */
  score?: ScoreResult;
  error?: string;
}

/**
 * 运行 Agent 并把输出流式写入 SSE。
 *
 * 含两道兜底，都是实测踩出来的：
 *  1. **截断重试**：本地/自建模型偶发在生成正文前断流（实测约 1/10 概率）。
 *  2. **撞顶收尾**：工具轮次用尽时强制一次「只综合、不调工具」的收尾轮。
 *     没有这道兜底时，30 轮真实工具检索的成果会被整体丢弃——实测跑出
 *     「288 个事件、0 字答案、自评 23 分」的结果，是比直接报错更糟的形态。
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const first = await runAgentOnce(options);

  // 截断（有思维链但无正文）→ 重试一次
  if (!first.ok && first.error?.includes('异常截断') && !options.sse.isClosed) {
    options.sse.status({ type: 'reflection', message: '首次生成中断，正在重试…' });
    const retry = await runAgentOnce(options);
    return withScore(retry, options);
  }

  // 撞轮次上限 → 收尾轮
  if (first.hitLimit && !options.sse.isClosed) {
    const final = await runSynthesis(options, first);
    return withScore(mergeRuns(first, final), options);
  }

  return withScore(first, options);
}

/**
 * 合并「主循环」与「收尾轮」的结果。
 *
 * 正文与轮次沿用收尾轮（那才是交付给用户的答案），思维链与工具调用记录
 * 则是两段拼接——它们是过程留档，评分与回溯都需要完整。
 */
function mergeRuns(first: RunResult, final: RunResult): RunResult {
  return {
    ...final,
    reasoning: first.reasoning + final.reasoning,
    toolCalls: [...first.toolCalls, ...final.toolCalls],
    rounds: first.rounds + final.rounds,
    hitLimit: true,
  };
}

/**
 * 撞上工具轮次上限后的收尾轮：**一次不带 agent 图、不带任何工具**的模型调用。
 *
 * 为什么不能简单地把已有的思维链拼成答案：思维链是**思考过程**，
 * 里面混着被否定的假设、对日志的疑问和自问自答，直接交付会误导用户。
 * 必须让模型在「证据已固定、不能再查」的前提下重新组织一次结论。
 *
 * 为什么不复用 `runAgentOnce({ noTools: true })`（2026-10-17 实测缺陷）：
 * 原实现只是把 `tools` 传空、把我们的 filesystem 中间件去掉，但
 * `createDeepAgent` 会**自己装回内置中间件**，实测收尾轮的请求体里仍然带着
 *
 * ```
 * ls, read_file, write_file, edit_file, delete, glob, grep, task
 * ```
 *
 * 也就是说「工具通道已关闭」对模型而言是句假话：它可以继续写文件，更糟的是
 * 可以调 `task` 拉起一个子 agent 完整重跑一遍分析。收尾轮本该是确定性的最后一次
 * 产出，不能有任何再次发散的可能。
 *
 * 所以收尾轮根本不进 agent 图——它本来就只是一次「给固定的输入、要一段文字」
 * 的调用。少一层图，也少一层可变形的地方。
 */
async function runSynthesis(options: RunOptions, prev: RunResult): Promise<RunResult> {
  const { sse, provider, promptContext, signal } = options;

  sse.status({
    type: 'reflection',
    message: `工具调用已达 ${prev.rounds} 次上限，正在基于已获取的信息给出最终结论…`,
  });

  const model = createModel(provider);
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt({ ...promptContext, toolNames: [] }) },
    { role: 'user' as const, content: buildSynthesisMessage(options, prev) },
  ];

  const contentSanitizer = new StreamingSanitizer();
  const reasoningSanitizer = new StreamingSanitizer();
  let content = '';
  let reasoning = '';

  try {
    const stream = await model.stream(messages, signal === undefined ? {} : { signal });
    for await (const msg of stream) {
      if (sse.isClosed || signal?.aborted === true) break;

      const ak = (msg.additional_kwargs ?? {}) as Record<string, unknown>;
      const rcRaw = ak['reasoning_content'] ?? ak['reasoning'];
      if (typeof rcRaw === 'string' && rcRaw !== '') {
        reasoning += rcRaw;
        const safe = reasoningSanitizer.push(rcRaw);
        if (safe !== '') sse.thinking(safe);
      }

      if (typeof msg.content === 'string' && msg.content !== '') {
        content += msg.content;
        const safe = contentSanitizer.push(msg.content);
        if (safe !== '') sse.content(safe);
      }
    }

    const contentTail = contentSanitizer.flush();
    if (contentTail !== '') sse.content(contentTail);
    const reasoningTail = reasoningSanitizer.flush();
    if (reasoningTail !== '') sse.thinking(reasoningTail);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content, reasoning, toolCalls: [], rounds: 0, hitLimit: false, error: msg };
  }

  // 收尾轮仍无正文时不要伪装成功——一份「23 分的空答案」比一句「请重试」
  // 对用户伤害更大。`tools` 已彻底不在场，所以这里的机会是**唯一**的。
  if (content.trim() === '') {
    return {
      ok: false,
      content,
      reasoning,
      toolCalls: [],
      rounds: 0,
      hitLimit: false,
      error: '已达到工具调用上限但没有产出结论。请重试或更换模型。',
    };
  }

  return { ok: true, content, reasoning, toolCalls: [], rounds: 0, hitLimit: false };
}

/** 收尾轮里回灌给模型的工具证据总量上限（字符） */
const SYNTHESIS_DIGEST_MAX = 40_000;

/** 单次工具调用在收尾轮摘要里保留的最大字符数 */
const SYNTHESIS_ITEM_MAX = 6_000;

/**
 * 构造收尾轮的输入消息。
 *
 * 收尾轮是一次**全新**的模型调用（不带主循环的消息历史，因为那需要把
 * 全部工具往返重放一遍，代价与风险都高），因此这里必须自带全部上下文：
 * 原始问题与日志正文（沿用 `userMessage`）+ 已获取的工具证据摘要。
 */
function buildSynthesisMessage(options: RunOptions, prev: RunResult): string {
  const parts: string[] = [options.userMessage, '', '---', ''];

  parts.push(
    `【系统提示】本次分析已用完 ${prev.rounds} 次工具调用上限，工具通道已关闭，` +
      '无法再检索或读取任何内容。请**立即**基于下方已获取的信息给出最终结论：',
  );
  parts.push('');
  parts.push('- 不要再请求任何工具，本次调用不会执行它们。');
  parts.push('- 证据不足的地方如实说明「现有信息无法判定」，不要编造。');
  parts.push('- 按输出规范给出结论与可操作步骤。');
  parts.push('');
  parts.push(`已获取的信息（共 ${prev.toolCalls.length} 次调用）：`);

  let used = 0;
  for (let i = 0; i < prev.toolCalls.length; i++) {
    const c = prev.toolCalls[i]!;
    const head = `\n[${i + 1}] ${c.name}(${JSON.stringify(c.args ?? {})})`;
    const remain = SYNTHESIS_DIGEST_MAX - used;
    if (remain <= 0) {
      parts.push(`\n……（其余 ${prev.toolCalls.length - i} 次调用因篇幅省略）`);
      break;
    }
    const keep = Math.min(remain, SYNTHESIS_ITEM_MAX);
    const body = c.result.length > keep ? `${c.result.slice(0, keep)}\n……（截断）` : c.result;
    const block = `${head}\n${body}`;
    parts.push(block);
    used += block.length;
  }

  return parts.join('\n');
}

/**
 * 附加质量自评。
 *
 * 评分在**工具返回之后**做，因为证据落地性需要拿日志正文与工具返回当语料
 * 去核对结论里的引用。评分失败不能让整次分析失败——它只是观测，
 * 没有评分用户照样能拿到答案。
 */
function withScore(result: RunResult, options: RunOptions): RunResult {
  try {
    result.score = scoreAnalysis({
      answer: result.content,
      conclusion: extractConclusion(result.content),
      logText: options.toolContext.logContent,
      toolCalls: result.toolCalls,
      rounds: result.rounds,
    });
  } catch (e) {
    console.error('[runner] 评分失败（不影响分析结果）:', e instanceof Error ? e.message : String(e));
  }
  return result;
}

async function runAgentOnce(options: RunOptions): Promise<RunResult> {
  const {
    userMessage,
    history = [],
    provider,
    toolContext,
    promptContext,
    maxRounds = 30,
    sse,
    signal,
  } = options;

  const model = createModel(provider);
  const tools = buildTools(toolContext);
  // 工具名清单在下发提示词时才拿到，故在此合并进提示词上下文。
  // 目的是让模型看到**本轮真实可用**的工具名（受配置与是否有日志影响），
  // 而不是一个写死在提示词里的漏项清单。
  const systemPrompt = buildSystemPrompt({
    ...promptContext,
    toolNames: tools.map((t) => t.name),
  });

  const agent = createDeepAgent({
    model,
    systemPrompt,
    tools,
    // 收敛 DeepAgents 内置的文件系统工具
    //
    // 为什么需要：DeepAgents 默认注入 ls / read_file / write_file / edit_file /
    // glob / grep 六个虚拟文件系统工具。本服务不暴露真实文件系统（日志通过 API
    // 传入，知识库由 rag_search 提供），实测中模型会误用它们——例如调用 glob
    // 找知识库文件，结果 "No files found"，浪费轮次。
    //
    // 但 `read_file` 是 FilesystemMiddleware 的**必需工具**（移除会抛
    // "read_file must be included in tools"），因此保留最小集合：
    // read_file（满足框架约束）+ ls（无害的目录列举），其余全部关闭。
    //
    // 本服务不暴露真实文件系统（日志通过 API 传入，知识库由 rag_search 提供），
    // 实测中模型会误用它们——例如调用 glob 找知识库文件，结果 "No files found"，
    // 浪费轮次。
    //
    // 但 `read_file` 是 FilesystemMiddleware 的**必需工具**（移除会抛
    // "read_file must be included in tools"），因此保留最小集合：
    // read_file（满足框架约束）+ ls（无害的目录列举），其余全部关闭。
    //
    // 注意：`middleware: []` 只撤掉这一层，DeepAgents 会把自己内置的中间件
    // 装回来（实测会多出 write_file / edit_file / delete / glob / grep / task）。
    // 需要「彻底没有工具」的场景不能靠它，必须完全不走 agent 图——收尾轮就是这么做的。
    middleware: [
      createFilesystemMiddleware({
        backend: new StateBackend(),
        tools: ['read_file', 'ls'],
        // 覆盖工具描述，明确告知模型这些工具不适用
        customToolDescriptions: {
          read_file: '【本服务不使用】虚拟文件系统工具，无实际文件可读。日志内容已直接给出，知识库请用 rag_search。',
          ls: '【本服务不使用】虚拟文件系统工具，无实际文件可列。',
        },
      }),
    ],
  });

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  let content = '';
  let reasoning = '';
  const toolCalls: RunResult['toolCalls'] = [];
  let hitLimit = false;

  /**
   * 工具调用跟踪器（见 `tool-tracker.ts`）。
   *
   * 轮次计数**只由它维护**（`tracker.count`）。历史缺陷是计数同时写在
   * 「宣告函数内部」与「三个调用点」上，于是每次调用被记成两轮、
   * `maxRounds` 实际只允许一半的工具调用——端到端实测中直接导致空答案。
   */
  const tracker = new ToolCallTracker();

  /** 把一次宣告写成 `tool` 帧 */
  const emitTool = (a: Announcement): void => {
    sse.tool(a.name, a.args);
  };

  /**
   * 流式净化器（过滤框架内部消息）。
   *
   * 实测缺陷：`[system: empty tool message processed, continue]` 曾泄漏到
   * 用户可见的答案中。因 SSE 逐块输出，标记会被拆到多个块里，故需带缓冲的净化。
   */
  const contentSanitizer = new StreamingSanitizer();
  const reasoningSanitizer = new StreamingSanitizer();

  /**
   * 本次调用的内部中止控制器。
   *
   * 为什么必须有（2026-10-17 实测缺陷）：撞上轮次上限时我们只是 `break` 跳出
   * 消费循环，**并没有让底层的 agent 图停下来**。实测请求序列为
   *
   * ```
   * [请求 4] 撞顶 → break   ← 我们以为结束了
   * [请求 5] ……完整工具清单 + 全部历史，没人消费  ← 图还在跑，白烧一次
   * [请求 6] 收尾轮
   * ```
   *
   * 那一次请求带着完整的消息历史与工具返回，是这条链路上最贵的一次调用，却
   * 没有任何人读它的结果。中止信号能让它当场作废。
   */
  const innerAbort = new AbortController();
  const runSignal =
    signal === undefined ? innerAbort.signal : AbortSignal.any([signal, innerAbort.signal]);

  try {
    const stream = await agent.stream({ messages }, { streamMode: 'messages', signal: runSignal });

    for await (const raw of stream) {
      if (sse.isClosed || signal?.aborted === true) {
        break;
      }

      // chunk 结构为 [message, meta]，meta 含 langgraph_node（当前未使用，保留解构以便扩展）
      const [msg] = raw as [BaseMessage, { langgraph_node?: string } | undefined];
      if (msg === undefined || msg === null) continue;

      const msgType = (msg as { getType?: () => string }).getType?.() ?? msg.constructor?.name ?? '';

      // ── 工具返回 ──────────────────────────────────
      if (msgType === 'tool') {
        const name = (msg as { name?: string }).name ?? 'unknown';
        const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        // 先配对（并可能补宣告），再发结果帧 —— 顺序反了会出现
        // 「结果先到、调用后到」的错位观感。
        //
        // 配对与补宣告由跟踪器负责：尚未宣告的调用（真·无参调用、或参数分片
        // 始终没拼成完整 JSON）在此补宣告，此刻参数必然已定——工具已经拿着它
        // 执行完了。这条兜底保证「有结果必有调用」。
        const { call: matched, announced } = tracker.onToolResult();
        if (announced !== null) emitTool(announced);

        const truncated = rawContent.length > SUMMARY_MAX;
        sse.toolResult(name, summarize(rawContent), truncated);

        toolCalls.push({
          round: tracker.count,
          name,
          args: matched?.name === name ? matched.args : (matched?.args ?? {}),
          // 保留较完整原文：证据落地性评分要拿它当语料核对引用。
          // 仍需设上限——单次工具返回理论上可以很大，长期驻留进程不能无限攒。
          result: rawContent.slice(0, TOOL_RESULT_KEEP_MAX),
          ok: !rawContent.startsWith('工具调用失败') && !rawContent.startsWith('检索失败'),
        });
        continue;
      }

      // ── 模型输出 ──────────────────────────────────
      if (msgType !== 'ai' && msgType !== 'AIMessageChunk') continue;

      const ak = (msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs ?? {};

      // 思维链
      const rcRaw = ak['reasoning_content'] ?? ak['reasoning'];
      if (typeof rcRaw === 'string' && rcRaw !== '') {
        reasoning += rcRaw;
        const safe = reasoningSanitizer.push(rcRaw);
        if (safe !== '') sse.thinking(safe);
      }

      // 正文（经流式净化，过滤框架内部消息——实测中它曾泄漏到答案里）
      if (typeof msg.content === 'string' && msg.content !== '') {
        content += msg.content;
        const safe = contentSanitizer.push(msg.content);
        if (safe !== '') sse.content(safe);
      }

      // 工具调用：交给跟踪器还原（分片累积、宣告时机、id↔index 反查全在里面）
      //
      // 这里不再自己判断「参数是否完整」——那是跟踪器的职责，也是两个历史
      // 缺陷（轮次双计、参数恒为空对象）的所在地，已抽成纯模块由单测守门。
      const announced = tracker.onModelMessage(
        (msg as { tool_call_chunks?: ChunkInput[] }).tool_call_chunks,
        (msg as { tool_calls?: FullCallInput[] }).tool_calls,
      );
      for (const a of announced) emitTool(a);

      // 轮次上限
      if (tracker.count > maxRounds) {
        hitLimit = true;
        sse.limit(maxRounds);
        break;
      }
    }

    // 冲刷流式净化器的剩余缓冲（否则尾部内容会丢失）
    const contentTail = contentSanitizer.flush();
    if (contentTail !== '') sse.content(contentTail);
    const reasoningTail = reasoningSanitizer.flush();
    if (reasoningTail !== '') sse.thinking(reasoningTail);

    // 关键校验：流是否正常结束且有正文
    // （实测教训：上游流可能中途截断，只留思维链而无正文，被当作成功）
    //
    // 空正文一律视为失败——**包括撞轮次上限的情形**。旧实现在撞顶时把空正文
    // 当成功返回（`&& !hitLimit`），于是端到端跑出「30 轮工具检索、0 字答案、
    // 自评 23 分、却报 completed」的结果。收尾轮由 `runAgent` 负责补上，
    // 这里只负责如实反映「这一轮没产出」。
    if (content.trim() === '') {
      const msg = hitLimit
        ? '已达到工具调用上限但没有产出结论。'
        : reasoning !== ''
          ? '上游流异常截断：已产生思维链但正文为空。请重试。'
          : '模型未返回任何内容。请重试或更换模型。';
      return { ok: false, content, reasoning, toolCalls, rounds: tracker.count, hitLimit, error: msg };
    }

    return { ok: true, content, reasoning, toolCalls, rounds: tracker.count, hitLimit };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content, reasoning, toolCalls, rounds: tracker.count, hitLimit, error: msg };
  } finally {
    // 撞顶 `break`、客户端断开、抛错——三条路径都要让底层图当场停下，
    // 否则它会继续把工具跑完、再发一次没人消费的模型请求（见上面实测序列）。
    // 正常跑完时这只是一次空操作。
    innerAbort.abort();
  }
}

/** 生成工具结果的摘要（供 SSE 帧） */
function summarize(result: string): string {
  const clean = result.replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_MAX) return clean;
  return clean.slice(0, SUMMARY_MAX) + '…';
}

/**
 * 尝试解析 JSON。
 *
 * 返回 `null` 表示「尚不可解析」（分片未收齐）——调用方据此判断宣告时机，
 * 避免在参数为空时发出无意义的 `tool` 帧。
 */
/** 截断工具结果（供上下文使用） */
export function truncateForModel(text: string, maxBytes = TOOL_RESULT_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8') + '\n\n[结果已截断]';
}
