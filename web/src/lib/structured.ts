/**
 * 正文结构化处理。
 *
 * 两件事，都是为了「不拿用户的日志去换好看」：
 *
 * 1. **拆出结论块**。模型会在正文末尾追加一个 ` ```json ` 结构化块
 *    （见 `prompts/output-spec.md`），它是硬性交付物。界面上要把它渲染成卡片，
 *    但**正文里不能留着这段裸 JSON**——玩家看不懂，且会挤掉真正要读的内容。
 * 2. **极简 Markdown 解析**。**刻意不使用 `v-html`**：模型输出里混着用户日志
 *    原文（含 `<`、`&`、乃至用户自己贴的 HTML），任何 `innerHTML` 路径都是
 *    XSS 入口。这里解析成结构化节点后由 Vue 模板渲染，Vue 默认转义，
 *    从机制上消除这一类风险。
 */

import type { Conclusion } from '../api/types.ts';

export interface SplitResult {
  /** 去掉结论块后的正文 */
  body: string;
  /** 解析成功的结论对象 */
  conclusion: Conclusion | null;
  /** 结论块的原始 JSON 文本（解析失败时也保留，便于排查） */
  raw: string | null;
}

/** 结论块必须至少含其中一个字段才被认作结论（否则可能只是模型贴的示例 JSON） */
const CONCLUSION_KEYS = ['rootCause', 'confidence', 'steps', 'evidence'];

/**
 * 从正文中拆出末尾的结构化结论块。
 *
 * 取**最后一个**成功解析且形似结论的块：模型有时会在分析过程中先贴一段
 * 示例/中间 JSON，末尾那个才是最终交付物。
 */
export function splitConclusion(text: string): SplitResult {
  const fence = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: { raw: string; start: number; end: number; parsed: unknown } | null = null;

  while ((match = fence.exec(text)) !== null) {
    const raw = match[1] ?? '';
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        CONCLUSION_KEYS.some((k) => k in (parsed as Record<string, unknown>))
      ) {
        last = { raw: raw.trim(), start: match.index, end: match.index + match[0].length, parsed };
      }
    } catch {
      // 不是合法 JSON，忽略
    }
  }

  if (last === null) return { body: text, conclusion: null, raw: null };

  // 只切这一块，其余正文原样保留（前后可能有其它代码块，不能一并删掉）
  const body = `${text.slice(0, last.start)}${text.slice(last.end)}`.trim();
  return { body, conclusion: last.parsed as Conclusion, raw: last.raw };
}

// ── 极简 Markdown 解析（安全，无 innerHTML）────────────────

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string };

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'h'; level: number; inlines: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; inlines: Inline[] };

/**
 * 渲染用视图模型：**所有字段常驻**（不做可辨识联合）。
 *
 * 原因很实际：Vue 模板里的 `v-if` 链并不能稳定地做类型收窄，
 * 联合类型会一路逼着模板写类型断言。与其在模板里堆 `as`，不如在解析侧
 * 一次性拍平——代价是几个空数组，换来模板零断言、零运行时判空分支。
 */
export interface ViewBlock {
  kind: 'p' | 'ul' | 'ol' | 'h' | 'code' | 'quote';
  /** 代码块内容 */
  text: string;
  /** 代码块语言（仅作展示） */
  lang: string;
  /** 标题级别 */
  level: number;
  /** 段落：每行一组行内节点 */
  lines: Inline[][];
  /** 列表项 */
  items: Inline[][];
  /** 标题/引用：单行行内节点 */
  inlines: Inline[];
}

function emptyView(kind: ViewBlock['kind']): ViewBlock {
  return { kind, text: '', lang: '', level: 0, lines: [], items: [], inlines: [] };
}

/** 把解析结果转成模板友好的扁平视图模型 */
export function toViewBlocks(text: string): ViewBlock[] {
  return parseMarkdown(text).map((b): ViewBlock => {
    if (b.t === 'p') return { ...emptyView('p'), lines: b.lines };
    if (b.t === 'ul') return { ...emptyView('ul'), items: b.items };
    if (b.t === 'ol') return { ...emptyView('ol'), items: b.items };
    if (b.t === 'h') return { ...emptyView('h'), level: b.level, inlines: b.inlines };
    if (b.t === 'code') return { ...emptyView('code'), text: b.text, lang: b.lang };
    return { ...emptyView('quote'), inlines: b.inlines };
  });
}

/** 行内解析：`code`、**strong**、其余按纯文本 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('`')) out.push({ t: 'code', v: token.slice(1, -1) });
    else out.push({ t: 'strong', v: token.slice(2, -2) });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out.length > 0 ? out : [{ t: 'text', v: text }];
}

/**
 * 块级解析。只认模型实际会用的几种形态（标题/列表/代码块/引用/段落），
 * 不做完整 CommonMark——少一层复杂度，也就少一类渲染缺陷。
 */
export function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++; // 跳过结束围栏
      blocks.push({ t: 'code', lang, text: buf.join('\n') });
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h !== null) {
      blocks.push({ t: 'h', level: (h[1] ?? '#').length, inlines: parseInline(h[2] ?? '') });
      i++;
      continue;
    }

    // 引用
    if (line.startsWith('> ')) {
      blocks.push({ t: 'quote', inlines: parseInline(line.slice(2)) });
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')));
        i++;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, '')));
        i++;
      }
      blocks.push({ t: 'ol', items });
      continue;
    }

    // 空行：跳过
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 段落：连续非空行合并
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i] ?? '') &&
      !/^\s*[-*]\s+/.test(lines[i] ?? '') &&
      !/^\s*\d+[.)]\s+/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').trimStart().startsWith('```') &&
      !(lines[i] ?? '').startsWith('> ')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ t: 'p', lines: para.map((l) => parseInline(l)) });
  }

  return blocks;
}
