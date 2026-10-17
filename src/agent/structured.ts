/**
 * 结构化输出提取 —— 从模型答复末尾的 ```json 块中解析结论。
 *
 * ## 为什么需要独立模块（实测缺陷依据）
 * 生产日志复核发现：**200 条分析记录中 23 条（12%）的 `rootCause` 为空**，
 * 但 `fullAnswer` 里明明有完整结论。
 *
 * 典型案例 `EX8k9og`（overall=98，工具调用 6 次）：
 * ```
 * ## 排障结论
 * ### 崩溃现象
 * 游戏在启动阶段、加载原生库的第一步（SDL）即崩溃，退出码 -3：
 * java.lang.NoClassDefFoundError: org/lwjgl/sdl/SDL
 * ```
 * 答案完整、分数很高，但 `rootCause` 字段空。
 *
 * 根因是**正文末尾的 JSON 块未被成功提取**。可能的失败原因：
 *  1. 模型未输出该块（长答案时容易遗漏）
 *  2. 正则不匹配（语言标记不是 `json`、或 JSON 内含 ``` 导致边界误判）
 *  3. 结构化块不在末尾（多轮对话时位置漂移）
 *  4. JSON 格式瑕疵（尾随逗号、注释、未转义字符）
 *
 * 因此本模块做**多策略容错提取**，而非单一正则匹配。
 */

export interface StructuredConclusion {
  /** 一句话根因 */
  rootCause: string;
  /** 0–1 置信度 */
  confidence: number | null;
  /** 支撑根因的证据 */
  evidence: string[];
  /** 解决步骤 */
  steps: string[];
  /** 提取是否成功 */
  ok: boolean;
  /** 提取策略（用于诊断；失败时为 null） */
  strategy: string | null;
  /** 失败原因 */
  error?: string;
}

const EMPTY: StructuredConclusion = {
  rootCause: '',
  confidence: null,
  evidence: [],
  steps: [],
  ok: false,
  strategy: null,
};

/**
 * 从答复文本中提取结构化结论。
 *
 * 按可靠性递降尝试多种策略：
 *  1. 末尾的 ```json 代码块（最常见）
 *  2. 任意位置的 ```json 块（取最后一个）
 *  3. 裸 JSON 对象（模型有时不加代码块）
 *  4. 从正文推断（兜底：把首段当作根因）—— 标记为 `degraded`
 */
export function extractConclusion(answer: string): StructuredConclusion {
  if (answer.trim() === '') {
    return { ...EMPTY, error: '答复为空' };
  }

  // 策略 1 & 2：代码块（贪婪匹配最外层，避免被内嵌 ``` 截断）
  const fromBlock = tryCodeBlocks(answer);
  if (fromBlock !== null) return fromBlock;

  // 策略 3：裸 JSON 对象
  const fromRaw = tryRawJson(answer);
  if (fromRaw !== null) return fromRaw;

  // 策略 4：降级——从正文推断根因（保证前端卡片不至于空白）
  const degraded = degradeFromText(answer);
  if (degraded !== null) return degraded;

  return { ...EMPTY, error: '未能提取出结构化结论' };
}

/** 从代码块提取（支持 ```json / ```JSON / 无语言标记） */
function tryCodeBlocks(answer: string): StructuredConclusion | null {
  // 用非贪婪匹配每一个代码块，逐个尝试解析（从后往前，因为约定放末尾）
  const blocks: string[] = [];
  const re = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    if (m[1] !== undefined) blocks.push(m[1].trim());
  }

  // 从后往前尝试（约定末尾），失败则回退到前面的块
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = parseConclusion(blocks[i]!);
    if (parsed !== null) {
      return { ...parsed, ok: true, strategy: i === blocks.length - 1 ? 'trailing-code-block' : 'earlier-code-block' };
    }
  }

  // 兜底：代码块可能被内嵌 ``` 截断 —— 尝试匹配「最后一个 ```json 之后到文末」
  const lastStart = answer.lastIndexOf('```json');
  if (lastStart >= 0) {
    let body = answer.slice(lastStart + 7);
    // 去掉开头换行
    body = body.replace(/^\s*\n/, '');
    // 截到最后一个 ```（若有）
    const end = body.lastIndexOf('```');
    if (end >= 0) body = body.slice(0, end);
    const parsed = parseConclusion(body.trim());
    if (parsed !== null) {
      return { ...parsed, ok: true, strategy: 'truncated-code-block' };
    }
  }

  return null;
}

/** 尝试解析裸 JSON 对象（模型有时不加代码块） */
function tryRawJson(answer: string): StructuredConclusion | null {
  const start = answer.lastIndexOf('{"rootCause"');
  const startAlt = start >= 0 ? start : answer.indexOf('{');
  if (startAlt < 0) return null;

  // 从 startAlt 起尝试逐步缩短，找到可解析的最长前缀
  const tail = answer.slice(startAlt);
  const candidates = [tail, tail.slice(0, tail.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue;
    const parsed = parseConclusion(candidate);
    if (parsed !== null) {
      return { ...parsed, ok: true, strategy: 'raw-json' };
    }
  }
  return null;
}

/**
 * 解析 JSON 并规范化为 StructuredConclusion。
 *
 * 容错处理（生产数据中实际出现过）：
 *  - 尾随逗号
 *  - JSON 中的注释
 *  - 字段名变体（root_cause / rootcause / cause）
 *  - confidence 为字符串
 */
function parseConclusion(raw: string): Omit<StructuredConclusion, 'ok' | 'strategy'> | null {
  const cleaned = sanitizeJson(raw);
  if (cleaned === '') return null;

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  const rootCause = pickString(rec, ['rootCause', 'root_cause', 'rootcause', 'cause', '根因']);
  // 没有 rootCause 就不算成功（这是最关键字段）
  if (rootCause === '') return null;

  return {
    rootCause,
    confidence: pickNumber(rec, ['confidence', '置信度']),
    evidence: pickStringArray(rec, ['evidence', '证据']),
    steps: pickStringArray(rec, ['steps', 'step', '解决步骤', 'steps_to_fix']),
  };
}

/** 清理常见 JSON 瑕疵 */
function sanitizeJson(raw: string): string {
  let s = raw.trim();

  // 去掉 BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  // 去掉行注释（// ...）与块注释（/* ... */）——仅当在字符串外
  s = removeJsonComments(s);

  // 去掉尾随逗号（}, 或 ],）
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // 截取最外层花括号
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    s = s.slice(first, last + 1);
  }

  return s.trim();
}

/** 移除 JSON 中的注释（保护字符串内部） */
function removeJsonComments(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    // 行注释
    if (ch === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl - 1;
      continue;
    }

    // 块注释
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function pickString(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(0, Math.min(1, v));
    }
    if (typeof v === 'string') {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
  }
  return null;
}

function pickStringArray(rec: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
    }
    // 单个字符串也接受
    if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  }
  return [];
}

/**
 * 降级策略：从正文推断根因。
 *
 * 当模型完全没输出 JSON 块时（长答案容易发生），至少给前端一个可展示的根因，
 * 而不是空白卡片。标记为 `degraded` 便于识别。
 *
 * **优先级**（实测两类样本需要不同处理）：
 *  1. **叙述性段落**（非列表、非标题）—— 这是根因的正常表达形式
 *  2. **列表段落** —— 仅当没有叙述段时使用（如极短答案只有一行列表）
 */
function degradeFromText(answer: string): StructuredConclusion | null {
  const lines = answer.split('\n');

  interface Para {
    text: string;
    isList: boolean;
  }
  const paragraphs: Para[] = [];
  let buf: string[] = [];
  let isList = false;

  const flush = (): void => {
    if (buf.length === 0) return;
    paragraphs.push({ text: buf.join(' '), isList });
    buf = [];
    isList = false;
  };

  for (const line of lines) {
    const t = line.trim();
    // 分隔符：空行、标题、代码块围栏、表格
    if (t === '' || t.startsWith('#') || t.startsWith('```') || t.startsWith('|')) {
      flush();
      continue;
    }

    const isListItem = /^[-*>]\s+/.test(t) || /^\d+\.\s+/.test(t);
    if (isListItem) {
      // 列表与叙述不混段
      if (!isList && buf.length > 0) flush();
      isList = true;
      buf.push(t.replace(/^[-*>]\s+/, '').replace(/^\d+\.\s+/, ''));
      continue;
    }

    if (isList && buf.length > 0) flush();
    buf.push(t);
  }
  flush();

  const build = (text: string): StructuredConclusion => ({
    rootCause: text.slice(0, 300),
    confidence: null,
    evidence: [],
    steps: [],
    ok: false, // 明确标记为未成功提取
    strategy: 'degraded-from-text',
    error: '模型未输出结构化 JSON 块，根因由正文推断（可能不精确）',
  });

  // ① 优先叙述性段落
  for (const p of paragraphs) {
    if (p.isList) continue;
    const cleaned = p.text.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 4) return build(cleaned);
  }

  // ② 退回列表段落（极短答案的常见形态）
  for (const p of paragraphs) {
    if (!p.isList) continue;
    const cleaned = p.text.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 4) return build(cleaned);
  }

  return null;
}
