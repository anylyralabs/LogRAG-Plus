/**
 * Agent 工具集。
 *
 * 每个工具都是薄封装：参数校验 + 调用底层模块 + 格式化输出。
 * 业务逻辑在 `src/rag/`、`src/github/`、`src/agent/tools/log.ts` 中。
 */

import { tool } from 'langchain';
import * as z from 'zod';

import { grepLog, readLog } from './log.ts';
import { search as ragSearch, listTopics } from '../../rag/search.ts';
import {
  getContent as ghGetContent,
  search as ghSearch,
  searchRepositories as ghSearchRepos,
} from '../../github/client.ts';
import { domainKnowledge as domainKnowledgeCfg, github as githubCfg, webSearch as webSearchCfg } from '../../config.ts';
import { listDomainKnowledge, searchDomainKnowledge } from '../../knowledge/domain.ts';

import { buildAskTool, type AskUserContext } from './ask.ts';

/** 工具执行上下文（每次会话注入） */
export interface ToolContext {
  /** 当前日志正文（无日志时为 null） */
  logContent: string | null;
  /** 当前日志 ID（用于展示） */
  logId: string | null;
  /** 工具调用计数（用于预算控制，由调用方维护） */
  counters: {
    rag: number;
    github: number;
    web: number;
  };
  /** 反问上下文（记录已问过的问题，避免重复追问） */
  ask: AskUserContext;
}

/** 新建工具上下文 */
export function createToolContext(
  logContent: string | null,
  logId: string | null,
): ToolContext {
  return {
    logContent,
    logId,
    counters: { rag: 0, github: 0, web: 0 },
    ask: { asked: [] },
  };
}

/** 预算上限（按信息缺口计数，无结果不计费——由调用方依据结果判定） */
const BUDGET = {
  rag: 8,
  github: 8,
  web: 5,
};

function budgetNotice(name: string, count: number, limit: number): string | null {
  if (count < limit) return null;
  return `\n\n[预算提示] ${name} 调用已达 ${limit} 次，请基于已有证据收敛输出结论，未核实的方面明确标注。`;
}

/**
 * 宽松整数字段。
 *
 * ## 为什么不直接写 `.min().max()`
 *
 * 实测（2026-10-17 端到端真跑）：模型给 `grep_log_file` 传了 `context_lines: 6`
 * （上限 5），zod 校验直接抛 `Received tool input did not match expected schema`，
 * 整个调用作废——**一次无伤大雅的越界就让模型白烧一轮**，而它的本意完全合理。
 *
 * 数值越界不是安全问题（真正的边界由实现侧 clamp 兜住），却是最大的轮次浪费源。
 * 因此这里只校验「是整数」，范围写进描述让模型知道，实际取值由实现收敛，
 * 与 `log-worker.ts` 里的 `Math.min/Math.max` 形成闭环。
 */
const looseInt = (desc: string, min: number, max: number) =>
  z.number().int().optional().describe(`${desc}（${min}–${max}，超出按边界处理）`);

/**
 * 构建工具集。
 *
 * 工具是按会话创建的（依赖 logContent 等上下文），不是全局单例。
 */
export async function buildTools(ctx: ToolContext) {
  // ── 日志工具（仅在有日志时提供）─────────────────────────
  const logTools = [];

  if (ctx.logContent !== null) {
    logTools.push(
      tool(
        async ({ query, case_sensitive, context_lines, max_matches }) => {
          const r = await grepLog(ctx.logContent!, {
            pattern: query,
            caseSensitive: case_sensitive,
            contextLines: context_lines,
            maxMatches: max_matches,
          });
          return r.text;
        },
        {
          name: 'grep_log_file',
          description:
            '在日志中按正则或关键词检索，返回带行号与上下文的匹配行。' +
            '用于定位具体报错、追踪 Caused by 异常链、查找模组加载信息。' +
            '优先于通读日志。检索词直接使用日志中的原文信号（异常类名、错误消息、配置项名）。',
          schema: z.object({
            query: z.string().describe('检索词或正则表达式。直接使用日志原文中的异常类名、错误消息、模组 ID 等'),
            case_sensitive: z.boolean().optional().describe('是否区分大小写，默认否'),
            context_lines: looseInt('命中行的上下文行数，默认 1', 0, 5),
            max_matches: looseInt('最大返回匹配数，默认 10', 1, 50),
          }),
        },
      ),
    );

    logTools.push(
      tool(
        async ({ line_start, line_end }) => {
          const r = await readLog(ctx.logContent!, {
            lineStart: line_start,
            lineEnd: line_end,
          });
          return r.text;
        },
        {
          name: 'read_log_file',
          description:
            '读取日志的指定行区间。通常先用 grep_log_file 确认行号，再用本工具定向读取上下文。' +
            '读取崩溃点前后区间（如报错前 50 行至后 30 行）有助于发现前置诱因。',
          schema: z.object({
            line_start: z.number().int().describe('起始行号（从 1 开始，小于 1 按 1 处理）'),
            line_end: z.number().int().optional().describe('结束行号（含）。省略则读到末尾或字节上限'),
          }),
        },
      ),
    );
  }

  // ── 知识库工具 ────────────────────────────────────────
  const ragTools = [
    tool(
      async ({ query, topic, k }) => {
        ctx.counters.rag++;
        const r = await ragSearch({ query, k: k ?? 5, topic: topic ?? null });
        const notice = budgetNotice('知识库检索', ctx.counters.rag, BUDGET.rag);
        return r.text + (notice ?? '');
      },
      {
        name: 'rag_search',
        description:
          '在内置知识库中检索已验证的故障模式与修复方案。' +
          '覆盖：原生库/ABI 不匹配、Java 运行时、渲染器兼容、SDL3 迁移、模组依赖失败、光影冲突、' +
          'PC 启动器与服务端常见问题。' +
          '检索词直接使用日志中的原文信号（如 UnsatisfiedLinkError、liblwjgl.so、HARD_DEP_NO_CANDIDATE）。' +
          '若首次无结果，改用 Caused by 后的类名重试（顶层异常名往往不在文档里）。',
        schema: z.object({
          query: z.string().describe('检索词。优先使用英文异常类名、错误消息原文、原生库名、配置项名'),
          topic: z.string().optional().describe('可选，限定主题目录（patterns / ecosystem / launcher / server）'),
          k: looseInt('返回条数，默认 5', 1, 10),
        }),
      },
    ),
    tool(
      async () => listTopics(),
      {
        name: 'list_topics',
        description:
          '列出知识库的主题目录与规模。不确定检索方向时可调用；但通常直接检索更高效。',
        schema: z.object({}),
      },
    ),
  ];

  // ── 领域知识工具 ──────────────────────────────────────
  //
  // 工具名 `expert_knowledge` 是**数据驱动**的选择，不是随手取的：
  // 线上 9353 条分析记录中，模型自发调用过 3 次 `expert_knowledge` 与 23 次
  // `knowledge_search`——这两个名字在系统里都不存在，每次都以报错告终。
  // 既然模型天然会往这个名字上想，就顺势用真实能力接住它，而不是让它浪费轮次改口。
  //
  // 只在**确有启用条目**时才注册：空工具会在清单里占位、诱导无意义的调用。
  const knowledgeTools = [];
  /*
   * 只在确有启用条目时注册：空工具会在清单里占位、诱导无意义的调用。
   *
   * 这里**不能**在构建工具集时查库——`createToolContext` 是同步的（6 个测试与
   * 调用方都按同步用），改成 async 会波及一大片。而「有没有条目」只影响
   * 工具是否出现在清单里，可以在**第一次调用时**再判断：调用本身是 async，
   * 拿不到条目就直接返回「没有匹配」。
   */
  /*
   * 领域知识只是提示词增强，**查不到不该让整个工具集构建失败**：
   * 库未配置/连接失败时按「没有条目」处理，工具集照常可用。
   * 这与其他存储路径的处理不同（会话读写失败必须报错），因为
   * 「少一段先验知识」是可降级的，而「建不了会话」不是。
   */
  let hasDomainEntries = false;
  if (domainKnowledgeCfg.enabled) {
    try {
      hasDomainEntries = (await listDomainKnowledge({ enabledOnly: true, limit: 1 })).length > 0;
    } catch {
      hasDomainEntries = false;
    }
  }
  if (hasDomainEntries) {
    knowledgeTools.push(
      tool(
        async ({ query }) => {
          const hits = await searchDomainKnowledge(query ?? '', 20);
          if (hits.length === 0) {
            return (
              '领域知识中没有与检索词匹配的条目。' +
              '这不代表该问题无解——领域知识只收录「模型无法从日志推断的长期事实」，' +
              '具体故障模式请改用 rag_search 检索知识库。'
            );
          }

          const lines = hits.map((e) => `- ${e.content}${e.tags.length > 0 ? `（标签：${e.tags.join('、')}）` : ''}`);
          return (
            `领域知识命中 ${hits.length} 条：\n${lines.join('\n')}\n\n` +
            '这些是运维确认过的先验，请据此判断；如与日志证据直接矛盾，请指出矛盾。'
          );
        },
        {
          name: 'expert_knowledge',
          description:
            '检索运维团队维护的**已知领域知识**（短小的事实性先验，如某 GPU 不支持某特性、某版本已变更某依赖）。' +
            '这些条目多数已直接注入你的系统提示词；本工具用于两种情况：' +
            '（1）提示词中提到「另有若干条因预算未列出」时，用它找出未列出的部分；' +
            '（2）想确认是否存在与当前问题相关的先验结论。' +
            '**它不替代 rag_search**：详细故障模式与修复步骤在知识库里，请用 rag_search。',
          schema: z.object({
            query: z
              .string()
              .describe('检索词，如设备 SoC 名、渲染器名、模组名、错误关键词。留空则返回全部条目'),
          }),
        },
      ),
    );
  }

  // ── GitHub 工具（受配置开关控制）──────────────────────
  const githubTools = [];

  if (githubCfg.enabled) {
    githubTools.push(
      tool(
        async ({ query, repo, type, state, max_results }) => {
          ctx.counters.github++;
          const r = await ghSearch(query, {
            repo,
            type,
            state,
            maxResults: max_results,
          });
          const notice = budgetNotice('GitHub 检索', ctx.counters.github, BUDGET.github);
          return r.text + (notice ?? '');
        },
        {
          name: 'github_search',
          description:
            '检索 GitHub 上的 Issues / PRs / Discussions，查找报错的已知解决方案。' +
            '**repo 参数可省略**：不知道模组或启动器在哪个仓库时，省略它做全站检索——' +
            '这通常比猜测仓库名更有效（一次全站检索可同时命中多个启动器的同类解法）。' +
            '已知仓库时传入可提高精度（支持别名如 fcl、zalith、mobileglues，或 owner/repo）。',
          schema: z.object({
            query: z.string().describe('检索关键词。使用异常类名、错误消息、版本号等具体信号'),
            repo: z
              .string()
              .optional()
              .describe('可选。仓库名、别名或 owner/repo。省略则全站检索'),
            type: z.enum(['all', 'issue', 'pr', 'discussion']).optional().describe('检索范围，默认 all'),
            state: z.enum(['all', 'open', 'closed']).optional().describe('状态，默认 all。已解决的优先看 closed'),
            max_results: looseInt('最大返回数，默认 5', 1, 10),
          }),
        },
      ),
    );

    githubTools.push(
      tool(
        async ({ repo, number }) => {
          ctx.counters.github++;
          const r = await ghGetContent({ repo, number });
          return r.text;
        },
        {
          name: 'github_get_content',
          description:
            '读取指定 Issue 或 PR 的完整内容（正文 + 解决方案）。' +
            '在 github_search 找到相关条目后调用，用于获取具体的修复步骤。',
          schema: z.object({
            repo: z.string().describe('仓库名、别名或 owner/repo'),
            number: z.number().int().describe('Issue 或 PR 编号（从 1 开始）'),
          }),
        },
      ),
    );

    githubTools.push(
      tool(
        async ({ keyword }) => {
          const r = await ghSearchRepos(keyword, 5);
          return r.text;
        },
        {
          name: 'github_search_repos',
          description:
            '按关键词搜索 GitHub 仓库。当不知道某个模组/启动器的仓库名时，用它找到 owner/repo。',
          schema: z.object({
            keyword: z.string().describe('仓库关键词，如模组名、启动器名'),
          }),
        },
      ),
    );
  }

  // ── Web 搜索（MCP）──────────────────────────────────
  const webTools = [];

  if (webSearchCfg.enabled) {
    webTools.push(
      tool(
        async ({ query }) => {
          ctx.counters.web++;
          if (ctx.counters.web > BUDGET.web) {
            return `网络搜索次数已达上限（${BUDGET.web} 次）。请基于已有证据收敛输出结论。`;
          }
          return callWebSearch(query);
        },
        {
          name: 'web_search',
          description:
            '通用网络搜索。**最后手段**——知识库与 GitHub 都未覆盖时使用。' +
            '结果通常不如 GitHub Issue 具体，优先尝试前两者。',
          schema: z.object({
            query: z.string().describe('搜索关键词'),
          }),
        },
      ),
    );
  }

  return [
    ...logTools,
    ...ragTools,
    ...knowledgeTools,
    ...githubTools,
    ...webTools,
    buildAskTool(ctx.ask),
  ];
}

/**
 * 调用 Web 搜索 MCP（Exa）。
 *
 * 用最小实现的 MCP 客户端：initialize → tools/call。
 */
async function callWebSearch(query: string): Promise<string> {
  const url = webSearchCfg.url;

  try {
    const initRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lograg-plus', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!initRes.ok) {
      return `网络搜索不可用（HTTP ${initRes.status}）。请基于已有证据输出结论。`;
    }

    const sessionId = initRes.headers.get('mcp-session-id');

    const callRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'web_search_exa', arguments: { query } },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!callRes.ok) {
      return `网络搜索失败（HTTP ${callRes.status}）。`;
    }

    const text = await callRes.text();
    return extractMcpText(text);
  } catch (e) {
    return `网络搜索异常：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 从 MCP 响应中提取文本内容（兼容 JSON 与 SSE 两种传输） */
function extractMcpText(raw: string): string {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  let payload = tryParse(raw);

  // SSE 形式：拼接 data: 行
  if (payload === null) {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    payload = tryParse(data);
  }

  const obj = payload as { result?: { content?: Array<{ type?: string; text?: string }> } } | null;
  const content = obj?.result?.content;
  if (!Array.isArray(content)) {
    return raw.slice(0, 1000);
  }

  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n\n')
    .slice(0, 8000);
}
