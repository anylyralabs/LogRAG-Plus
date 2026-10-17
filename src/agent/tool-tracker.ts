/**
 * 工具调用跟踪器 —— 把模型流里的工具调用片段还原成有序、参数正确的调用记录。
 *
 * ## 为什么必须单独成模块
 *
 * 这段逻辑此前内联在 `runner.ts` 的流处理循环里，直接导致过两个线上级缺陷，
 * 而两者都无法被任何测试覆盖（要触发就得连真实模型跑一次完整的 30 轮工具循环）：
 *
 * 1. **轮次按两倍计数**：计数同时写在「宣告函数内部」与「三个调用点」上，
 *    于是 `maxRounds: 30` 实际只允许 15 次工具调用。实测中 16 次调用就撞顶，
 *    用户拿到的是空答案。
 * 2. **工具参数永远显示为空对象**：`tool_calls` 字段会先以 `args: {}` 占位出现，
 *    旧实现就在这里宣告，于是 16 次调用全部显示 `arguments: {}`，
 *    前端看不到任何检索词。这条缺陷有**两层**，第一层是宣告时机，第二层是
 *    「占位值污染分片累积缓冲区」——只修第一层症状不变（详见 `onModelMessage`
 *    里 `index !== undefined` 分支的注释）。
 *
 * 抽出来之后，这两个缺陷都能用纯数据用例钉死（见 `tests/tool-tracker.test.ts`），
 * 不再依赖真模型。模块本身不碰 SSE、不碰网络，只做状态还原。
 *
 * ## 上游流的两种形态（实测）
 *
 * ```
 * 形态 A（占位 + 分片）：
 *   tool_calls:       [{name:'grep_log_file', args:{},  id:'x'}]   ← args 是占位空对象
 *   tool_call_chunks: [{name:'grep_log_file', args:'',  id:'x', index:0}]
 *                     [{                     args:'{"que',      index:0}]
 *                     [{                     args:'ry":"a"}',    index:0}]
 * ```
 * 关键点：**后续分片不带 id、只带 index**，且 `index` 在不同轮次间会重用。
 *
 * 形态 B（只发完整 tool_calls）：直接给出解析后的 `args`。
 *
 * ## 宣告时机
 *
 * 宣告（发 `tool` 帧）必须等到参数**确实完整**：
 *  - 分片拼成完整 JSON 且不等于 `{}` → 此时宣告；
 *  - `{}` 一律延后——它无法区分「真·无参调用」与「占位空对象」；
 *  - 参数至今未宣告的调用，在其**工具结果到达时**补宣告 —— 那一刻参数必然已定，
 *    因为工具已经拿着它执行完了。这条兜底保证「有结果必有调用」，前端不会看到
 *    只有结果没有调用的错位帧。
 */

/** 参数原文累积上限（字符） */
export const MAX_ARGS_RAW = 64_000;

/** 一次已定型的工具调用 */
export interface TrackedCall {
  id: string;
  name: string;
  /** 参数原文（分片拼接结果） */
  argsRaw: string;
  /** 最终参数（宣告后填充，供结果配对时复用，避免二次解析） */
  args: unknown;
  /** 是否已宣告（即是否已发过 `tool` 帧） */
  announced: boolean;
  /** 是否见过分片 */
  sawChunks: boolean;
}

/** 一次宣告（调用方据此发 `tool` 帧并计数） */
export interface Announcement {
  name: string;
  args: unknown;
}

/** 模型侧的一条工具调用片段 */
export interface ChunkInput {
  name?: string;
  args?: string;
  id?: string;
  index?: number;
}

/** 模型侧的一条完整工具调用 */
export interface FullCallInput {
  name?: string;
  args?: unknown;
  id?: string;
}

/** 尝试解析 JSON；`null` 表示尚不可解析 */
export function safeJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 稳定序列化：键按字典序排列。
 *
 * 为什么不能用 `JSON.stringify` 直接比：同一组参数在不同轮次里键序可能不同
 * （`{"a":1,"b":2}` 与 `{"b":2,"a":1}`），语义相同但字符串不同，
 * 于是「原地打转」永远检测不出来——这正是那种「看起来守住了、其实没有」的坑。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}


export class ToolCallTracker {
  /** 分片累积条目，键为 `index`（分片必带）或高位合成的独立键 */
  readonly #pending = new Map<number, TrackedCall>();
  /** id → 键 反查（`tool_calls` 只有 id） */
  readonly #idToIndex = new Map<string, number>();
  /** 按调用顺序排列的全部调用（结果到达时出队） */
  readonly #queue: TrackedCall[] = [];
  /** 独立的合成键序号，避开 `index` 命名空间 */
  #syntheticKey = 1000;
  /** 已宣告的调用次数（即「轮次」） */
  #count = 0;
  /** 已宣告调用的指纹序列（用于识别「原地打转」） */
  readonly #signatures: string[] = [];

  /**
   * 连续重复同一次调用的轮数上限。
   *
   * 依据：生产语料里 `fw79h8D` 用 97 轮、96 次工具调用得出一个 78 分的结论，
   * `L8oLvgg` 51 轮、`uenGF42` 43 轮——851 条低分记录中有 **255 条是轮次 ≥10**，
   * 且 `overall` 清一色钉在 78（效率分 0）。它们不是「想得深」，
   * 而是**在同一个地方反复问同一个问题**。
   *
   * 3 次是保守值：真正需要多次读同一份日志的场景（先 grep 定位、再按行读、
   * 再换关键词 grep）参数一定不同；参数完全相同的第 3 次几乎必然是空转。
   */
  static readonly REPEAT_LIMIT = 3;

  /** 已宣告的调用次数 */
  get count(): number {
    return this.#count;
  }

  /**
   * 是否已「原地打转」：最近连续 `limit` 次调用的指纹完全相同。
   *
   * 判据是**连续**而非累计：同一份日志里分两次读同一段（中间查了别的东西）
   * 是正常行为，只有连续重复才是空转。
   */
  isSpinning(limit = ToolCallTracker.REPEAT_LIMIT): boolean {
    if (this.#signatures.length < limit) return false;
    const tail = this.#signatures.slice(-limit);
    return tail.every((s) => s === tail[0]);
  }

  /** 最近一次调用的指纹（诊断用，如 `grep_log_file:{"pattern":"ERROR"}`） */
  get lastSignature(): string {
    return this.#signatures[this.#signatures.length - 1] ?? '';
  }

  /** 工具名 + 规范化参数的指纹：参数键序不同但语义相同的调用应视为同一调用 */
  static signatureOf(name: string, args: unknown): string {
    return `${name}:${stableStringify(args)}`;
  }

  /** 待配对（结果尚未到达）的调用数量 */
  get outstanding(): number {
    return this.#queue.length;
  }

  /**
   * 处理模型的一条消息里的工具调用信息。
   *
   * 返回值是**本次新产生的宣告**，调用方据此发帧。之所以返回数组而不是自己发，
   * 是为了让本模块与 SSE 完全解耦——测试里可以只断言返回值。
   */
  onModelMessage(chunks?: ChunkInput[], full?: FullCallInput[]): Announcement[] {
    const out: Announcement[] = [];

    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const c of chunks) {
        const index = c.index ?? 0;
        let entry = this.#pending.get(index);
        if (entry === undefined) {
          entry = {
            id: c.id ?? '',
            name: '',
            argsRaw: '',
            args: {},
            announced: false,
            sawChunks: true,
          };
          this.#pending.set(index, entry);
          // 入队即定序：分片按 index 递增到达，与调用顺序一致
          this.#queue.push(entry);
        }
        entry.sawChunks = true;
        if (c.id !== undefined && c.id !== '') {
          entry.id = c.id;
          this.#idToIndex.set(c.id, index);
        }
        if (c.name !== undefined && c.name !== '') entry.name = c.name;
        if (c.args !== undefined && entry.argsRaw.length < MAX_ARGS_RAW) {
          entry.argsRaw += c.args;
        }

        const announced = this.#tryAnnounce(entry);
        if (announced !== null) out.push(announced);
      }
    }

    if (Array.isArray(full) && full.length > 0) {
      for (const c of full) {
        const id = c.id ?? '';
        const index = id !== '' ? this.#idToIndex.get(id) : undefined;

        // 已由分片路径接管 → 参数原文以分片为准，**不在此宣告**
        //
        // 为什么不能在这里宣告：该字段会先以 `args:{}` 占位出现，真实参数随后
        // 才由分片补齐。实测中在这个位置宣告会让每一次调用的 SSE 帧都带上空参数。
        //
        // 为什么连「补全参数原文」都必须加条件（2026-10-17 二次实测，见
        // `tests/agent-loop.test.ts`）：此处原本无条件写入，于是第 1 个分片同时
        // 带来 `tool_calls[0].args = {}` 时，`{}` 被写进 `argsRaw`，后续分片只能
        // 追加成 `{}{"query":"ERROR","context_lines":1}` —— **永远不可解析**，
        // 宣告因此永不发生，最终走结果兜底宣告成 `{}`。
        // 也就是说：只堵「宣告时机」是不够的，占位值本身会污染累积缓冲区。
        // 症状与修复前完全一样（每次调用都显示空参数），极易被误判为「已修好」。
        if (index !== undefined) {
          const entry = this.#pending.get(index);
          if (entry !== undefined) {
            const raw =
              c.args === undefined
                ? null
                : typeof c.args === 'string'
                  ? c.args
                  : JSON.stringify(c.args);
            const isEmptyObject =
              c.args !== undefined &&
              typeof c.args === 'object' &&
              c.args !== null &&
              Object.keys(c.args).length === 0;

            if (!entry.sawChunks && entry.argsRaw === '' && raw !== null) {
              // 该供应商只发完整 `tool_calls`（无分片）：此处即权威参数
              entry.argsRaw = raw.slice(0, MAX_ARGS_RAW);
            } else if (
              entry.sawChunks &&
              raw !== null &&
              !isEmptyObject &&
              safeJson(entry.argsRaw) === null
            ) {
              // 分片路径存在但拼不出参数，而这里给的是**非空**权威值 → 救回
              // （空对象不救，那是占位，会重新引入上面那个缺陷）
              entry.argsRaw = raw.slice(0, MAX_ARGS_RAW);
              const salvaged = this.#tryAnnounce(entry);
              if (salvaged !== null) out.push(salvaged);
            }
          }
          continue;
        }

        // 未见过分片：该供应商只发完整 tool_calls，此时 args 已是权威解析结果
        const args = c.args ?? {};
        const empty = typeof args === 'object' && args !== null && Object.keys(args).length === 0;
        const name = c.name ?? '';
        const key = this.#syntheticKey++;
        const entry: TrackedCall = {
          id,
          name,
          argsRaw: empty ? '' : JSON.stringify(args),
          args: {},
          announced: false,
          sawChunks: false,
        };
        this.#pending.set(key, entry);
        this.#queue.push(entry);
        if (id !== '') this.#idToIndex.set(id, key);
        if (!empty && name !== '') out.push(this.#announce(entry, args));
      }
    }

    return out;
  }

  /**
   * 处理一条工具结果。
   *
   * 返回配对的调用与该调用的**补宣告**（若此前尚未宣告）。补宣告在返回值里
   * 位于 `announced` 字段，调用方应先发它再发结果帧，保证顺序合理。
   */
  onToolResult(): { call: TrackedCall | undefined; announced: Announcement | null } {
    const call = this.#queue.shift();

    let announced: Announcement | null = null;
    if (call !== undefined && !call.announced && call.name !== '') {
      announced = this.#announce(call, safeJson(call.argsRaw) ?? {});
    }

    // 本批工具已全部返回 → 清空分片索引追踪
    //
    // 为什么必须清空：`index` 在**不同轮次间会重用**（每轮都从 0 开始）。
    // 若跨轮次保留，下一轮的 index=0 会命中上一轮的残留条目（name 已填、
    // announced 已置位），导致新调用**永远不被宣告**。
    if (this.#queue.length === 0) {
      this.#pending.clear();
      this.#idToIndex.clear();
    }

    return { call, announced };
  }

  /** 参数已完整就宣告；返回本次产生的宣告或 `null` */
  #tryAnnounce(entry: TrackedCall): Announcement | null {
    if (entry.announced || entry.name === '' || entry.argsRaw === '') return null;
    // 占位空对象与真·无参调用不可区分，统一延后到结果到达时宣告（两种情况下都正确）
    if (entry.argsRaw === '{}') return null;
    const parsed = safeJson(entry.argsRaw);
    if (parsed === null) return null;
    return this.#announce(entry, parsed);
  }

  #announce(entry: TrackedCall, args: unknown): Announcement {
    entry.announced = true;
    entry.args = args;
    this.#count++;
    this.#signatures.push(ToolCallTracker.signatureOf(entry.name, args));
    return { name: entry.name, args };
  }
}
