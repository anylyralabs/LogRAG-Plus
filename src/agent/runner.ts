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
import { StreamingSanitizer, stripToolCallText } from './sanitize.ts';
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
   * 本轮模型发起的反问（`ask_user` 工具调用）。
   *
   * 为什么要在结果里单独带出来：追问是**用户需要回答的东西**。只存在于
   * 工具调用记录或正文里，前端无法稳定地把它渲染成交互块，刷新后更是丢失。
   * 这里收集结构化的问题清单，随消息落库。
   */
  asks: Array<{ questions: string[]; reason?: string }>;
  /**
   * 工具调用记录。
   *
   * `result` 保留**较完整的原文**（上限 100KB/次）而非仅用于展示的摘要——
   * 证据落地性评分需要拿工具返回当语料，只有摘要就核不了引用。
   */
  toolCalls: Array<{ round: number; name: string; args: unknown; result: string; ok: boolean }>;
  /** 实际轮次 */
  rounds: number;
  /** 是否触及轮次上限（含「原地打转」提前中止） */
  hitLimit: boolean;
  /**
   * 是否因“原地打转”而提前中止（连续同一调用）。
   *
   * 与 `hitLimit` 共用收尾路径，但两者对模型的含义不同：
   * 轮次耗尽 = 预算用完，收尾轮要说“用已有材料总结”；
   * 打转 = 方法失效，收尾轮要说“停止重复检索，直接给出判断”。
   */
  spinDetected?: boolean;
  /** 是否检测到「工具调用被写成正文」（生产语料 29 条命中此形态） */
  toolCallAsText?: boolean;
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
    // 收尾轮不调用工具，追问只可能来自主循环
    asks: first.asks,
    toolCalls: [...first.toolCalls, ...final.toolCalls],
    rounds: first.rounds + final.rounds,
    hitLimit: true,
    // 中止原因来自主循环，不能在合并时丢掉——收尾轮本身既不打转也不带假调用
    spinDetected: first.spinDetected ?? false,
    toolCallAsText: first.toolCallAsText ?? false,
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
    message:
      prev.spinDetected === true
        ? '检测到重复检索，已中止工具通道，正在整理现有证据给出结论…'
        : `工具调用已达 ${prev.rounds} 次上限，正在基于已获取的信息给出最终结论…`,
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
    return { ok: false, content, reasoning, asks: [], toolCalls: [], rounds: 0, hitLimit: false, error: msg };
  }

  // 收尾轮仍无正文时不要伪装成功——一份「23 分的空答案」比一句「请重试」
  // 对用户伤害更大。`tools` 已彻底不在场，所以这里的机会是**唯一**的。
  if (content.trim() === '') {
    return {
      ok: false,
      content,
      reasoning,
      asks: [],
      toolCalls: [],
      rounds: 0,
      hitLimit: false,
      error: '已达到工具调用上限但没有产出结论。请重试或更换模型。',
    };
  }

  return { ok: true, content, reasoning, asks: [], toolCalls: [], rounds: 0, hitLimit: false };
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

  // 「预算用完」与「方法失效」要给模型不同的指令：前者的病是没查够，后者是白查了。
  // 生产语料里 255 条轮次 ≥10 的低分记录（典型 `fw79h8D`：97 轮 / 96 次调用仍停在 78 分）
  // 都属于后者——它们在**重复同一个已经失败过的动作**，再给「多查一点」的余地只会继续空转。
  if (prev.spinDetected === true) {
    parts.push(
      `【系统提示】检测到你在重复同一次工具调用（同一工具、同一参数连续多次），` +
        '因此**提前中止**了工具通道。这不是轮次耗尽，而是这条路已经走不通。',
    );
    parts.push('');
    parts.push('- 停止一切重复检索。**不要再试图用同一个关键词再查一遍。**');
    parts.push('- 直接基于下方已获取的信息给出结论；若确实证据不足，就明确说「现有信息无法判定根因」，');
    parts.push('  并给出**用户可以自己做的下一步检查**（哪一个文件、哪一行、看什么）。');
    parts.push('- 特别注意：如果前面的检索都返回「无匹配」，那本身就是一个结论——说明该关键词不在日志里，');
    parts.push('  应换判据（换行号区间、换文件名、换报错原文），而不是重复同一个查询。');
  } else {
    parts.push(
      `【系统提示】本次分析已用完 ${prev.rounds} 次工具调用上限，工具通道已关闭，` +
        '无法再检索或读取任何内容。请**立即**基于下方已获取的信息给出最终结论：',
    );
    parts.push('');
    parts.push('- 不要再请求任何工具，本次调用不会执行它们。');
    parts.push('- 证据不足的地方如实说明「现有信息无法判定」，不要编造。');
  }

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
  // 追问轮不评分：这一轮没有结论，拿「结论的证据落地性」去打分必然得低分
  // （实测追问轮曾因此拿到 56 分 + deliverable:false，而它其实完全正常）。
  // 追问的产出是问题，不是可评分的答案。
  if (result.asks.length > 0) return result;

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
  /** 本轮 `ask_user` 提出的问题（结构化，供落库与回放） */
  const asks: RunResult['asks'] = [];
  let hitLimit = false;
  /** 是否因「原地打转」而非轮次耗尽而中止（两者共用收尾路径，但日志要分得清） */
  let spinDetected = false;
  /** 模型是否把工具调用写成了正文（生产语料 29 条，见 sanitize.ts） */
  let toolCallAsText = false;
  /**
   * 已向用户提问，本轮进入「只许收尾」状态。
   *
   * 为什么需要这个状态（实测缺陷）：`ask_user` 之后模型常会**继续自检**
   * ——再 grep 一次、再读一段，然后才产出正文。但界面上问题已经呈现给用户、
   * 用户正在等回答，而模型还在后台查东西：既浪费配额，也让「反问」这件事
   * 显得不果断。问题问出去之后，本轮唯一该做的事是把问题与理由写进正文，
   * 而不是继续验证。
   */
  let awaitingUser = false;

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

        // 反问：从调用参数里取出问题清单。
        //
        // 工具的返回文本是给模型看的说明书，不是给前端解析的协议；
        // 结构化数据在**参数**里，这里直接取，避免前端正则解析中文提示。
        if (name === 'ask_user') {
          const args = matched?.name === name ? matched.args : undefined;
          const parsed = extractAsk(args);
          if (parsed !== null) {
            asks.push(parsed);
            sse.ask(parsed.questions, parsed.reason);
            // 进入「只许收尾」：下一轮模型若再发工具调用，直接终止并补一次收尾，
            // 而不是让它继续自检（见 awaitingUser 的注释）
            awaitingUser = true;
          }
        }

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

      // 已经问过用户，模型却还要调工具：说明它想继续自检。
      // 这里不再执行，直接结束主循环——问题已经呈现给用户，继续查只是在拖延回答。
      if (awaitingUser && announced.length > 0) {
        sse.status({
          type: 'reflection',
          message: '已向你提问，先等你的回答；不再继续检索。',
        });
        break;
      }

      // 原地打转检测（依据：生产语料 255 条低分记录是「轮次 ≥10 且效率分 0」，
      // 典型如 `fw79h8D` 97 轮 / 96 次工具调用仍停在 78 分）。
      //
      // 为什么必须在**宣告之后、结果回来之前**判断：此时我们才知道这一轮要调用
      // 什么；等到结果回来再判断，又一次空转已经发生了。
      //
      // 处理方式与撞轮次上限**同一条路径**（`hitLimit` → 收尾轮），因为它本质是
      // 「这条路走不通了，用已有材料给出结论」——而不是失败。若走失败分支，
      // 用户会因为模型绕圈而拿不到任何答案，这比 78 分更糟。
      if (tracker.isSpinning()) {
        hitLimit = true;
        spinDetected = true;
        sse.limit(maxRounds);
        break;
      }

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

    // 工具调用被写成正文（生产语料 29 条，见 `sanitize.ts` 的 `stripToolCallText`）。
    //
    // 关键在于**不能只把它删掉就算成功**：那 29 条里有相当一部分答案原本就只有
    // 这一段假调用，删完剩一片空白——用户看到的是「成功但什么都没有」。
    // 因此这里把「检测到假调用」当作**本轮流产**处理，交给收尾轮重新产出。
    // 若收尾轮也失败，上层会如实报失败（空正文一律失败，这条铁律不变）。
    const stripped = stripToolCallText(content);
    if (stripped.detected) {
      content = stripped.text;
      toolCallAsText = true;
      // 把正文里那段假调用**从流里收回**：已经发出去的增量无法撤回，
      // 但至少让它别再累积到「已交付内容」里，前端按 `done` 帧的最终正文渲染。
      sse.status({
        type: 'reflection',
        message: '模型把工具调用写成了正文（未真正执行），正在重新整理结论…',
      });
    }

    // 关键校验：流是否正常结束且有正文
    // （实测教训：上游流可能中途截断，只留思维链而无正文，被当作成功）
    //
    // 空正文一律视为失败——**包括撞轮次上限的情形**。旧实现在撞顶时把空正文
    // 当成功返回（`&& !hitLimit`），于是端到端跑出「30 轮工具检索、0 字答案、
    // 自评 23 分、却报 completed」的结果。收尾轮由 `runAgent` 负责补上，
    // 这里只负责如实反映「这一轮没产出」。
    // 把工具调用写成正文 = 本轮流产，与「撞顶」同样交给收尾轮重做一次
    // （只清掉假调用就交付，会让用户拿到一段空白——那 29 条生产记录正是如此）
    if (toolCallAsText) hitLimit = true;

    // 已提问但模型没写出正文：把问题清单本身作为正文。
    // 否则用户只看到一句错误，而问题其实已经随 ask 帧发出去了——两边对不上。
    if (awaitingUser && content.trim() === '' && asks.length > 0) {
      // 兜底正文**不复述问题**：问题已随 ask 帧结构化下发，界面会渲染成输入框。
      // 正文只交代「为什么问」——这正是 ask 帧里没有的信息，不重复。
      const reason = asks.map((a) => a.reason ?? '').find((r) => r !== '') ?? ''
      content =
        reason !== ''
          ? `需要补充一些日志里没有的信息才能继续判断：${reason}`
          : '需要补充一些日志里没有的信息才能继续判断，问题见上方。'
      sse.content(content)
    }

    if (content.trim() === '' || toolCallAsText) {
      const msg = awaitingUser
        ? '已向你提问，请先回答上面的问题。'
        : toolCallAsText
        ? '模型把工具调用写成了正文（未真正执行），本轮无有效结论。'
        : spinDetected
        ? '模型在重复同一次检索，已中止并转入结论整理。'
        : hitLimit
        ? '已达到工具调用上限但没有产出结论。'
        : reasoning !== ''
          ? '上游流异常截断：已产生思维链但正文为空。请重试。'
          : '模型未返回任何内容。请重试或更换模型。';
      return {
        ok: false,
        content,
        reasoning,
        asks,
        toolCalls,
        rounds: tracker.count,
        hitLimit,
        spinDetected,
        toolCallAsText,
        error: msg,
      };
    }

    return {
      ok: true,
      content,
      reasoning,
      asks,
      toolCalls,
      rounds: tracker.count,
      hitLimit,
      spinDetected,
      toolCallAsText,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content, reasoning, asks, toolCalls, rounds: tracker.count, hitLimit, error: msg };
  } finally {
    // 撞顶 `break`、客户端断开、抛错——三条路径都要让底层图当场停下，
    // 否则它会继续把工具跑完、再发一次没人消费的模型请求（见上面实测序列）。
    // 正常跑完时这只是一次空操作。
    innerAbort.abort();
  }
}

/**
 * 从 `ask_user` 的调用参数里取出问题清单。
 *
 * 模型偶尔会把 `questions` 写成字符串而不是数组；两种都接受，
 * 但仍要求至少有一个非空问题，否则当作「没有提问」——空数组会让界面
 * 渲染一个没有内容的追问块。
 */
function extractAsk(args: unknown): { questions: string[]; reason?: string } | null {
  if (args === null || typeof args !== 'object') return null;
  const rec = args as { questions?: unknown; reason?: unknown };

  const raw = rec.questions;
  const list = Array.isArray(raw)
    ? raw.filter((q): q is string => typeof q === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  const questions = list.map((q) => q.trim()).filter((q) => q !== '');
  if (questions.length === 0) return null;

  const reason = typeof rec.reason === 'string' && rec.reason.trim() !== '' ? rec.reason.trim() : undefined;
  return { questions, ...(reason !== undefined ? { reason } : {}) };
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
