/**
 * 证据锚点（anchor）提取与「能否在语料里找到」的校验。
 *
 * ## 为什么要这么一层
 *
 * 生产评分体系最致命的缺陷是：**把「调用过几次工具」当成「证据是否充分」**。
 * 线上 9353 条分析记录里，`evidenceSufficiency` 是工具调用次数的阶跃函数：
 *
 * | 工具调用次数 | evidenceSufficiency |
 * |---|---|
 * | 0 | 恒 20 |
 * | 1 | 60 |
 * | 2 | 80 |
 * | ≥3 | 95 |
 *
 * 后果是**有确定证据、结论正确的分析被系统性压分**：
 * 全量中「0 次工具 + 结论完整（有根因且有步骤）」的记录共 253 条，
 * `overall` **全部恰好等于 68**；而「1–3 次工具 + 同样结论完整」的 1478 条均值是 93.3。
 * 两组结论质量没有差别，分差 25 分完全来自「调没调工具」。
 *
 * 正确的度量方式必须落在**文本**上：结论里出现的每一个可核实的标识
 * （异常类名、文件名、版本号、配置项、被引用的原文片段），
 * 能否在实际可用的语料（日志正文 + 工具返回）里找到。
 * 找得到就是有证据，找不到就是没证据——与调没调工具无关。
 *
 * ## 只提取「可核实」的锚点
 *
 * 中文叙述、形容词、连接词都不可核实，不能计入证据。
 * 因此只提取那些**在日志里必然以字面形式出现**的东西。
 * 这也反过来给模型一个明确信号：想拿证据分，就得引用具体标识。
 */

/** 锚点类型（用于诊断与提示词反馈） */
export type AnchorKind =
  /** 反引号包裹的片段（模型显式标注的「原文」） */
  | 'quoted'
  /** 点分标识符，如 `net.minecraft.client.Minecraft` */
  | 'identifier'
  /** 文件名，如 `sodium-fabric-0.6.0.jar` */
  | 'filename'
  /** 版本号，如 `1.21.1`、`0.19.5` */
  | 'version'
  /** 异常类名，如 `NoSuchMethodError` */
  | 'exception'
  /** 常量，如 `HARD_DEP` */
  | 'constant'
  /** 路径片段 */
  | 'path';

export interface Anchor {
  /** 原文形态（用于展示） */
  text: string;
  /** 归一化形态（用于比对） */
  key: string;
  kind: AnchorKind;
}

/**
 * 过于通用的标识。
 *
 * 这些词在任何一份 Minecraft 日志里都出现，因此「命中」不构成证据。
 * 例如结论说「`java.lang.Exception` 导致崩溃」——它一定能在日志里找到，
 * 但这句话什么也没证明。把它们排除可以显著提高证据分的判别力。
 */
const TOO_GENERIC: ReadonlySet<string> = new Set([
  // 包名根
  'java', 'javax', 'com', 'org', 'net', 'io', 'cn', 'me', 'it', 'uk',
  // 领域通用词
  'minecraft', 'mods', 'mod', 'config', 'log', 'logs', 'jar', 'json',
  'true', 'false', 'null', 'none', 'version', 'main', 'data', 'assets',
  'java.lang', 'java.util', 'java.io',
  // 过短的通用名
  'a', 'b', 'c', 'd', 'error', 'exception',
]);

/** 单条锚点最长字符数（超长的多半是模型整段转述，不是标识） */
const MAX_ANCHOR_CHARS = 80;

function normalizeKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    // 去掉包裹性标点，避免「'foo'」与「foo」被当成不同锚点
    .replace(/^[`'"(（[【]+/, '')
    .replace(/[`'")）\]】,;:。，；：]+$/, '')
    .trim();
}

function isUsable(key: string): boolean {
  if (key.length < 3) return false;
  if (key.length > MAX_ANCHOR_CHARS) return false;
  if (TOO_GENERIC.has(key)) return false;
  // 纯整数（如「245」「512」）没有判别力——日志里到处都是数字。
  // 但**带点的版本号必须保留**（`1.21.1`、`0.19.5`）：版本号是最常见的证据，
  // 若把「只由数字和点组成」一律当作无判别力，就会把最有力的证据全部丢掉。
  if (/^\d+$/.test(key)) return false;
  // 纯标点
  if (/^[.\-_+]+$/.test(key)) return false;
  return true;
}

/** 已提取锚点的原始文本占位（避免同一段文字被多种模式重复计入） */
interface Collector {
  byKey: Map<string, Anchor>;
  taken: Array<[number, number]>;
}

function addAnchor(c: Collector, raw: string, kind: AnchorKind, start = -1, end = -1): void {
  const key = normalizeKey(raw);
  if (!isUsable(key)) return;
  if (c.byKey.has(key)) return;
  // 已被更精确的模式（如反引号）覆盖的区间不再重复计入
  if (start >= 0 && end > start && c.taken.some(([s, e]) => start < e && end > s)) return;
  c.byKey.set(key, { text: raw.trim(), key, kind });
  if (start >= 0 && end > start) c.taken.push([start, end]);
}

const PATTERNS: ReadonlyArray<{
  kind: AnchorKind;
  re: RegExp;
  /** 取第几个捕获组（0 表示整体） */
  group: number;
}> = [
  // 反引号：模型自己标注的「原文」，优先识别
  { kind: 'quoted', re: /`([^`\n]{2,80})`/g, group: 1 },
  // 异常 / 错误类名
  { kind: 'exception', re: /\b([A-Z][A-Za-z0-9_$]*(?:Exception|Error|Throwable))\b/g, group: 1 },
  // 文件名（带常见扩展名）
  {
    kind: 'filename',
    re: /\b([\w][\w.+-]*\.(?:jar|json|log|so|dll|toml|cfg|properties|txt|yml|yaml|zip|mcmeta|lzma|jar\.disabled))\b/gi,
    group: 1,
  },
  // 版本号（至少两段，避免把 0/1 当证据）
  { kind: 'version', re: /\b(\d+\.\d+(?:\.\d+){0,2}(?:[-+][\w.]+)?)\b/g, group: 1 },
  // 点分标识符（类名/包名/配置项）
  { kind: 'identifier', re: /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g, group: 1 },
  // 连字符/下划线连接的模组标识（如 fabric-language-kotlin、create-lazytick）。
  // 要求至少两处分隔符，避免把普通的连字符短语（如 "windows-only"）当成标识。
  { kind: 'identifier', re: /\b([a-z0-9]+(?:[-_][a-z0-9]+){2,})\b/g, group: 1 },
  // 全大写常量（如 HARD_DEP、SIGSEGV、GL_FRAMEBUFFER_UNSUPPORTED）
  { kind: 'constant', re: /\b([A-Z][A-Z0-9_]{3,})\b/g, group: 1 },
  // 路径片段
  { kind: 'path', re: /(?:^|\s)(\/[\w./+-]{4,})/g, group: 1 },
];

/**
 * 从一段文字里提取可核实的证据锚点。
 *
 * 顺序有讲究：反引号最先（最可靠），异常类名/文件名/版本号先于通用标识符，
 * 这样 `sodium-fabric-0.6.0.jar` 会被记成 filename 而不是被 identifier 模式
 * 拆成 `sodium-fabric-0` 之类的垃圾。
 */
export function extractAnchors(text: string): Anchor[] {
  if (text.trim() === '') return [];

  const c: Collector = { byKey: new Map(), taken: [] };

  for (const p of PATTERNS) {
    // 每个模式独立重建正则，避免共享 lastIndex 带来的状态污染
    const re = new RegExp(p.re.source, p.re.flags);
    for (const m of text.matchAll(re)) {
      const captured = m[p.group];
      if (captured === undefined) continue;
      const start = m.index ?? -1;
      // 捕获组相对整体匹配的偏移：用整体匹配区间做覆盖判断即可
      const end = start >= 0 ? start + m[0].length : -1;
      addAnchor(c, captured, p.kind, start, end);
    }
  }

  return [...c.byKey.values()];
}

export interface AnchorHit {
  anchor: Anchor;
  found: boolean;
}

export interface VerificationResult {
  /** 总锚点数 */
  total: number;
  /** 命中的锚点数 */
  found: number;
  /** 命中率 0–1；无锚点时为 null（表示「无从核实」而非「没证据」） */
  recall: number | null;
  /** 逐条结果（供诊断/前台展示「哪些引用没在日志里找到」） */
  hits: AnchorHit[];
  /** 未命中的锚点（既是扣分依据，也是「模型可能臆造」的线索） */
  missing: Anchor[];
}

/**
 * 校验锚点能否在语料里找到。
 *
 * `corpus` 是**实际可用的全部文本**：日志正文 + 所有工具返回。
 * 传空字符串会得到 recall = 0（有锚点但一个都没找到），这是正确的——
 * 但调用方若根本没有日志，应传 `null` 表示「无法核实」，而不是空串。
 */
export function verifyAnchors(anchors: Anchor[], corpus: string): VerificationResult {
  if (anchors.length === 0) {
    return { total: 0, found: 0, recall: null, hits: [], missing: [] };
  }

  const hay = corpus.toLowerCase();

  const hits: AnchorHit[] = anchors.map((a) => ({
    anchor: a,
    found: hay.includes(a.key),
  }));

  const found = hits.filter((h) => h.found).length;

  return {
    total: anchors.length,
    found,
    recall: found / anchors.length,
    hits,
    missing: hits.filter((h) => !h.found).map((h) => h.anchor),
  };
}

/**
 * 抽取一条断言的锚点，并按「是否可核实」分类。
 *
 * 返回 `anchors.length === 0` 表示这条断言全是叙述性文字，没有任何可核实内容。
 * 这不是中性的——一条自称是「证据」却没有引用任何具体标识的断言，
 * 在证据分里应当**比引用了具体标识但没找到的更差**：
 * 前者根本无法被检验，后者至少给出了可证伪的引用。
 */
export function anchorsOfClaim(claim: string): Anchor[] {
  return extractAnchors(claim);
}
