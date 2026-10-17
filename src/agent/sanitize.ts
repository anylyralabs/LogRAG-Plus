/**
 * 输出净化 —— 过滤泄漏到用户可见答案中的框架内部消息。
 *
 * ## 实测缺陷依据
 * 生产日志复核发现：`KUetpQq`（overall=94）的答案正文中出现了
 * `[system: empty tool message processed, continue]`——这是 Agent 循环的
 * **内部续跑信号**（工具返回空内容时框架自动继续），却被渲染成了答案的一部分。
 *
 * 用户会看到裸的框架内部文本，是明显的体验缺陷。
 *
 * ## 处理策略
 * **过滤而非报错**：这些消息不改变语义，只是噪音。直接移除即可，
 * 但要**记录日志**以便发现上游模式变化（新的泄漏形态）。
 */

/**
 * 流式输出的净化器。
 *
 * ## 为什么需要缓冲
 * SSE 是**逐块输出**的（实测中正文按 token 分片，如 `"回"`、`"显结果"`）。
 * 一个框架内部标记（如 `[system: empty tool message processed, continue]`）
 * 会被拆到多个块中，逐块过滤**无法匹配**。
 *
 * 因此采用**滞后缓冲**：保留尾部一小段不出（因为可能是标记的开头），
 * 确认安全后再输出。缓冲上限 `HOLD_BACK` 保证不会无限积压。
 */
export class StreamingSanitizer {
  /** 滞后缓冲上限：足以覆盖最长标记 */
  private static readonly HOLD_BACK = 160;

  private pending = '';
  private removedAny = false;

  /**
   * 推入一个增量，返回**可以安全输出**的部分。
   *
   * @returns 净化后的安全文本（可能为空，表示需要继续缓冲）
   */
  push(delta: string): string {
    if (delta === '') return '';
    this.pending += delta;

    // 找到「可能是标记开头」的位置：最后一个未闭合的 '['
    const holdFrom = this.findHoldPosition();

    let safe: string;
    if (holdFrom >= 0) {
      safe = this.pending.slice(0, holdFrom);
      this.pending = this.pending.slice(holdFrom);
    } else if (this.pending.length > StreamingSanitizer.HOLD_BACK) {
      // 无潜在标记：可以全部输出（但保留少量尾部以防标记刚好在边界）
      const cut = this.pending.length - 40;
      safe = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
    } else {
      return '';
    }

    const { text, removed } = sanitizeOutput(safe);
    if (removed.length > 0) this.removedAny = true;
    return text;
  }

  /**
   * 冲刷剩余缓冲（流结束时调用）。
   */
  flush(): string {
    if (this.pending === '') return '';
    const { text, removed } = sanitizeOutput(this.pending);
    if (removed.length > 0) this.removedAny = true;
    this.pending = '';
    return text;
  }

  /** 本次流是否移除过框架消息（供监控） */
  get didRemove(): boolean {
    return this.removedAny;
  }

  /**
   * 找出必须滞留的位置：
   * 从尾部往前找最后一个 '['，若其后可能仍是标记（未遇到 ']' 或长度未超上限），
   * 则从该位置起滞留。
   */
  private findHoldPosition(): number {
    const lookback = Math.min(this.pending.length, StreamingSanitizer.HOLD_BACK);
    const start = this.pending.length - lookback;

    // 从后往前找 '['，但只找**不含 ']' 的尾部片段**
    let searchEnd = this.pending.length;
    for (let i = this.pending.length - 1; i >= start; i--) {
      const ch = this.pending[i];
      if (ch === ']') {
        // 已闭合，继续往前找新的起点
        searchEnd = i;
        continue;
      }
      if (ch === '[') {
        // 是否与已知标记前缀匹配
        const fragment = this.pending.slice(i, searchEnd).toLowerCase();
        if (this.looksLikeMarkerStart(fragment)) {
          return i;
        }
      }
    }
    return -1;
  }

  /** 判断片段是否可能是某个内部标记的开头 */
  private looksLikeMarkerStart(fragment: string): boolean {
    const candidates = [
      '[system:',
      '[tool',
      '[aimessage',
      '[humanmessage',
      '[langgraph',
      '[node',
    ];
    const lower = fragment.toLowerCase();
    for (const c of candidates) {
      // 片段是候选前缀，或候选是片段前缀（标记比当前片段长）
      if (c.startsWith(lower) || lower.startsWith(c)) return true;
    }
    return false;
  }
}

/** 已知的框架内部消息模式 */
const INTERNAL_MARKERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // LangChain / LangGraph 的续跑信号
  { name: 'empty-tool-message', pattern: /\[system:\s*empty tool message processed[^\]]*\]/gi },
  { name: 'tool-message-empty', pattern: /\[system:\s*tool message[^\]]*empty[^\]]*\]/gi },

  // 常见的框架调试输出
  { name: 'langgraph-node', pattern: /^\s*\[?(?:langgraph|nodes?)[:_\s][^\n]{0,80}$/gim },
  { name: 'framework-continue', pattern: /\[system:\s*continue[^\]]*\]/gi },

  // 通用 [system: ...] 注入消息（保守：仅匹配 system 前缀，不误伤正常文本）
  { name: 'system-tag', pattern: /\[system:\s*[^\]\n]{0,120}\]/gi },

  // 框架的工具调用回显。
  //
  // ⚠️ 这里曾经写成裸的 `/[ToolMessage|AIMessageChunk|HumanMessage]/`，会把
  // **正文里任何提到这些类名的地方一并删掉**——包括我们自己的排障说明
  // （「`AIMessageChunk.tool_calls` 与 `tool_call_chunks` 的区别」这类内容
  // 正是知识库与报告里要写的东西）。现在只匹配**方括号包裹**的形态，
  // 那是框架真正的回显格式；裸类名保留。
  { name: 'tool-call-echo', pattern: /\[(?:ToolMessage|AIMessageChunk|HumanMessage)\]/g },
];

export interface SanitizeResult {
  /** 净化后的文本 */
  text: string;
  /** 移除了哪些标记（供日志与监控） */
  removed: string[];
}

/**
 * 「把工具调用写成了正文」的检测。
 *
 * ## 依据（生产语料，不是假想）
 *
 * 9353 条分析记录里，**29 条**的 `overall` 落在 56–77，共同特征是答案正文是空的，
 * 或者正文里直接躺着一句工具调用：
 *
 * ```
 * <tool_call> <function=list_log_files/>
 * ```
 *
 * 它们全部是 1–2 轮就结束的短会话——模型把「我要调工具」这句话**说出来了**，
 * 而不是真的去调。用户看到的是一段像是代码的乱码，或者一片空白。
 *
 * `prompts/output-spec.md` 第 4 条已经明确禁止这种写法，但**禁令不能当检测用**：
 * 29 次里一次都没被拦住。提示词是概率性的，输出侧必须是确定性的。
 *
 * ## 与 INTERNAL_MARKERS 的区别
 *
 * 上面那张表是「框架泄漏」（我们自己的噪音）；这里检测的是「模型把动作当文本」，
 * 是模型的错误。两者都要消掉，但**记录方式不同**：后者说明模型没学会用工具通道，
 * 属于需要告警的模式，不应静默吞掉。
 */
const TOOL_CALL_AS_TEXT: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // 完整的假工具调用块（最常见形态）
  { name: 'tool-call-tag', pattern: /<tool_call>[\s\S]{0,400}?<\/tool_call>/gi },
  // 只写了函数标签、没有闭合（实测形态）
  { name: 'tool-call-function', pattern: /<function\s*=\s*[^>\n]{1,80}\s*\/?>/gi },
  // 未闭合的 <tool_call>（流被截断时常见）
  { name: 'tool-call-open', pattern: /<tool_call>[\s\S]{0,200}$/i },
  // 某些模型用 JSON 形态叙述调用
  {
    name: 'tool-call-json',
    pattern: /^\s*\{\s*"name"\s*:\s*"[a-z_]{3,40}"\s*,\s*"parameters"\s*:\s*\{[\s\S]{0,400}?\}\s*\}\s*$/gim,
  },
];

/**
 * 检测并移除「被写成正文的工具调用」。
 *
 * @returns `detected` 为 true 表示模型确实把调用写进了正文（供上层告警/降分）
 */
export function stripToolCallText(text: string): { text: string; detected: boolean; kinds: string[] } {
  if (text === '') return { text: '', detected: false, kinds: [] };

  let out = text;
  const kinds: string[] = [];
  for (const { name, pattern } of TOOL_CALL_AS_TEXT) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      kinds.push(name);
      pattern.lastIndex = 0;
      out = out.replace(pattern, '');
    }
  }

  if (kinds.length === 0) return { text: out, detected: false, kinds: [] };

  // 移除后常见结果是一整段空白（那 29 条里有相当一部分答案原本就只有这一段）
  const trimmed = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: trimmed, detected: true, kinds };
}

/**
 * 净化模型输出，移除框架内部消息。
 *
 * @param text 原始文本（正文或思维链）
 * @param context 用于日志标注的来源（如 'content' / 'reasoning'）
 */
export function sanitizeOutput(text: string, context = 'output'): SanitizeResult {
  if (text === '') return { text: '', removed: [] };

  let out = text;
  const removed: string[] = [];

  for (const { name, pattern } of INTERNAL_MARKERS) {
    // 重置 lastIndex（带 g 标志的正则是有状态的）
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      removed.push(name);
      pattern.lastIndex = 0;
      out = out.replace(pattern, '');
    }
  }

  if (removed.length > 0) {
    // 清理因移除产生的多余空行（连续 3 个以上换行压成 2 个）
    out = out.replace(/\n{3,}/g, '\n\n').trim();

    // 记录到系统日志：既是问题证据，也可发现**新的泄漏形态**
    try {
      // 延迟导入避免循环依赖（syslog 可能在 server 层）
      void context;
      console.error(`[sanitize] 移除了框架内部消息: ${removed.join(', ')}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  return { text: out, removed };
}

/**
 * 判断文本是否含框架内部消息（供测试与监控使用）。
 */
export function hasInternalMarkers(text: string): boolean {
  for (const { pattern } of INTERNAL_MARKERS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
