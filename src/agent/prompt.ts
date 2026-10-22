/**
 * 系统提示词装配。
 *
 * ## 设计原则
 * 提示词由三部分组装：
 *  1. **身份与核心约束**（本文件内置）
 *  2. **方法论**（从 `prompts/` 读取——检索策略、输出规格）
 *  3. **动态注入**（知识库主题概览、日志窗口、用户上下文）
 *
 * 方法论放文件而非硬编码，便于迭代；但它**不进 RAG 索引**（见 AGENTS.md 边界约定）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderDomainKnowledgeSection } from '../knowledge/domain.ts';

export interface PromptContext {
  /** 知识库主题概览（list_topics 的静态摘要） */
  topicsOverview?: string;
  /** 日志概况（有日志时） */
  logSummary?: string;
  /** 是否有日志上下文（决定是否强调日志工具） */
  hasLog?: boolean;
  /**
   * 用户补充的领域知识（管理员维护的先验规则）。
   *
   * 一般不用传——不传时提示词会直接从领域知识存储读取并渲染
   * （这样在线增删改可毫秒级生效，无需重启）。传入时以传入值为准，
   * 供测试与特殊注入场景使用。
   */
  domainKnowledge?: string;
  /**
   * 本轮实际可用的工具名清单。
   *
   * 由调用方从 `buildTools()` 结果取出后传入。用途是**消灭工具名幻觉**：
   * 线上 9353 条分析记录里有 92 次调用指向不存在的工具名，其中夹杂大量
   * 近形拼写（`Read_log_file`、`ggrep_log_file`、`greplog`、`grep_log_log_file`）。
   * 把「精确清单 + 不存在即报错」写进提示词，比事后纠正便宜得多。
   */
  toolNames?: string[];
  /**
   * 快速模式（配额耗尽时的降级）。
   *
   * 不硬拒用户，而是约束模型不走多轮检索——与 LogShare 的「快速分析」同思路。
   * 这样 CGNAT 场景下的真实用户仍能得到基础答案，而非被 429 拦住。
   */
  fastMode?: boolean;
}

const PROMPTS_DIR = process.env.PROMPTS_DIR ?? './prompts';

/** 进程级缓存（提示词文件在运行期不变） */
const fileCache = new Map<string, string>();

function loadPromptFile(name: string): string {
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;

  try {
    const content = readFileSync(join(PROMPTS_DIR, name), 'utf8');
    fileCache.set(name, content);
    return content;
  } catch {
    fileCache.set(name, '');
    return '';
  }
}

/** 供测试与热更新清空缓存 */
export function clearPromptCache(): void {
  fileCache.clear();
}

/** 核心身份与不可协商的约束 */
const IDENTITY = `你是 LogRAG+，一个 Minecraft 日志排障助手。你的职责是分析玩家提交的游戏日志，定位问题根因，并给出**玩家能照着操作**的解决方案。

你的分析对象涵盖：
- 移动端（Android）：ZalithLauncher2、FoldCraftLauncher、Pojav 系启动器
- PC 端：HMCL、PrismLauncher、MultiMC、ATLauncher、PCL2 等
- 服务端：Paper、Purpur、Folia、Velocity、Geyser、Fabric/NeoForge 服务端
- 模组生态：Fabric / Forge / NeoForge 加载器与各类模组

核心原则：
1. **准确优先于速度**：宁可标注「未核实」，也不要臆测。所有结论必须有日志证据或检索来源支撑。
2. **面向玩家交付**：用户多数不是开发者。输出必须是可执行的操作，不是诊断报告。
3. **信息不足时反问**：日志缺少关键信息（设备型号、渲染器、Java 版本、模组列表）时，直接问用户，不要猜。
4. **禁止 emoji**：全程不使用表情符号。`;

/** 工具使用约束 */
const TOOL_RULES = `工具使用：
- 日志内容已在你的上下文中（见用户消息）。需要更多上下文时用 grep_log_file / read_log_file 定向获取，不要通读。
- 知识库检索用 rag_search，检索词直接取日志中的原文信号（异常类名、错误消息、配置项名），不要翻译或改写。
- 不知道模组/启动器在哪个仓库时，github_search 的 repo 参数**可以省略**，会走 GitHub 全站检索。
- 检索无结果不计入预算；但同一信息缺口反复失败时应换方向而非重试。
- 引用来源：知识库结论标注文件路径；GitHub 结论注明仓库与条目编号。`;

/**
 * 组装系统提示词。
 */
export function buildSystemPrompt(ctx: PromptContext = {}): string {
  const parts: string[] = [IDENTITY, TOOL_RULES];

  // 工具名精确清单（消灭工具名幻觉）
  if (ctx.toolNames !== undefined && ctx.toolNames.length > 0) {
    parts.push(
      `\n\n${'='.repeat(60)}\n` +
        `【本轮可用工具——名称必须完全一致】\n` +
        ctx.toolNames.map((n) => `- ${n}`).join('\n') +
        `\n\n清单之外**不存在**其它工具。调用清单外的名字会直接报错并浪费一轮；` +
        `若你需要的能力不在清单里，说明本服务不提供该能力，请改用清单内工具或基于已有证据作答。` +
        `特别注意不要写近形名（例如把 ignore 写成 igonre 那样的拼写变体）。`,
    );
  }

  // 方法论（从 prompts/ 加载）
  const retrieval = loadPromptFile('retrieval-strategy.md');
  if (retrieval !== '') {
    parts.push(`\n\n${'='.repeat(60)}\n${retrieval}`);
  }

  const outputSpec = loadPromptFile('output-spec.md');
  if (outputSpec !== '') {
    parts.push(`\n\n${'='.repeat(60)}\n${outputSpec}`);
  }

  // 管理员维护的领域知识（强制先验）
  //
  // 默认从存储实时读取——这样运维在后台改一条，下一次分析就生效，不需要重启。
  // 读库失败不能让整次分析挂掉（提示词少一段，分析仍可进行），故兜底为空。
  const injectedDomainKnowledge = ((): string => {
    if (ctx.domainKnowledge !== undefined && ctx.domainKnowledge.trim() !== '') {
      return ctx.domainKnowledge.trim();
    }
    try {
      return renderDomainKnowledgeSection().text;
    } catch {
      return '';
    }
  })();

  if (injectedDomainKnowledge !== '') {
    parts.push(`\n\n${'='.repeat(60)}\n${injectedDomainKnowledge}`);
  }

  // 知识库主题概览（帮助模型判断是否需要检索）
  if (ctx.topicsOverview !== undefined && ctx.topicsOverview.trim() !== '') {
    parts.push(`\n\n${'='.repeat(60)}\n${ctx.topicsOverview.trim()}`);
  }

  // 日志上下文提示
  if (ctx.logSummary !== undefined && ctx.logSummary.trim() !== '') {
    parts.push(`\n\n${'='.repeat(60)}\n【本次日志概况】\n${ctx.logSummary.trim()}`);
  }

  if (ctx.hasLog === true) {
    parts.push(
      `\n\n${'='.repeat(60)}\n注意：本次分析有日志上下文，你可以使用日志工具。日志内容已在用户消息中给出（可能经过窗口截取，非全文）。`,
    );
  } else if (ctx.hasLog === false) {
    parts.push(
      `\n\n${'='.repeat(60)}\n注意：本次对话**没有日志上下文**。若用户询问具体报错，请让他提供日志或粘贴报错片段。`,
    );
  }

  // 反问指引（信息不足时的正确动作）
  parts.push(
    `\n\n${'='.repeat(60)}\n` +
      `【信息不足时反问】\n` +
      `以下信息通常**不在日志里**，但直接决定结论方向。缺失且影响判断时，用 ask_user 工具提问，不要臆测：\n` +
      `- 设备型号 / SoC（移动端渲染器兼容性依赖它）\n` +
      `- 渲染器名称与版本（移动端崩溃的首要原因）\n` +
      `- Java 运行时版本\n` +
      `- 模组列表（依赖冲突无法从崩溃栈完整推断）\n` +
      `- 崩溃前的操作（区分「一直如此」与「刚改过配置」）\n` +
      `- 是否必现（偶发多为资源竞争，必现多为配置/兼容性）\n` +
      `- 启动器版本（兼容性修复通常随启动器更新发布）\n` +
      `\n` +
      `提问要求：具体、可回答（「你的手机是什么型号？」而非「请提供更多信息」）；` +
      `一次最多 3 个；说明为什么要问；并告知拿到信息后会怎么判断。\n` +
      `**问完就停**：调用 ask_user 之后，本轮**不再调用任何工具**（不要「顺便再查一下」），` +
      `因为用户此时正在等回答，你继续检索只会让他干等。\n` +
      `**正文只写两三句**：说明缺什么信息、为什么要、拿到后怎么判断。\n` +
      `**不要复述问题**——问题已由 ask_user 的结构化字段下发，界面会渲染成输入框；` +
      `正文再写一遍就是同一件事说两次。\n` +
      `**不要给结论，也不要输出结构化 JSON 块**：这一轮没有结论。\n` +
      `**注意**：反问不是推卸。若已能给出有价值的部分结论，应先给结论再补充提问。`,
  );

  // 快速模式（配额耗尽降级）
  if (ctx.fastMode === true) {
    parts.push(
      `\n\n${'='.repeat(60)}\n` +
        `【快速模式】本次为快速回答：**不要调用任何工具**，直接基于用户提供的信息给出简明判断。\n` +
        `若信息不足以判断，直接说明还需要哪些信息，并请用户提供。不要臆测。\n` +
        `正文照常自由分析（不要套模板），结尾仍追加结构化 JSON 块。`,
    );
  }

  return parts.join('');
}
