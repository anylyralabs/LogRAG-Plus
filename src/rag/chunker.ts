/**
 * 知识库分块 —— 从 LogShare `App\Rag\Chunker` 移植（保持检索质量不回退）。
 *
 * ## 为什么按 `##` 二级标题切分
 * 知识条目按「签名 / 含义 / 修复步骤 / 置信度线索」组织，每个小节是独立的检索单元。
 * 检索命中时返回整个小节，而非任意字符窗口——保证上下文完整。
 *
 * ## 实测发现的结构性问题
 * `日志分析/` 目录的 17 个条目**每个只切出 1 个 chunk**（因缺少 `##` 结构），
 * 导致检索时每个文件最多只占 1 个结果位，极易被多 chunk 文件挤出。
 * → 新建知识条目**必须使用 `##` 二级标题**。
 */

export interface Chunk {
  /** 来源路径（相对知识库根） */
  source: string;
  /** 标题（H1 + 小节名，用于 BM25 的 title 列加权） */
  title: string;
  /** 正文 */
  body: string;
  /** 估算 token 数（供审计） */
  tokenCount: number;
}

/** 单 chunk 最大字符数；超出则做滑窗二次切分 */
const MAX_CHUNK_CHARS = 1600;

/** 滑窗重叠字符数（避免边界上下文丢失） */
const OVERLAP_CHARS = 150;

/** 粗略 token 估算：中文按 1.5 字符/token，英文按 4 字符/token */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 提取 H1 标题（`# ` 开头） */
export function h1Title(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/**
 * 按 `##` 二级标题切分 Markdown。
 *
 * 保留 H1 标题作为 chunk 标题前缀（提升 BM25 命中率——实测中 title 权重 10 倍）。
 */
export function chunkMarkdown(source: string, content: string): Chunk[] {
  const pageTitle = h1Title(content) ?? basename(source);
  const lines = content.split('\n');

  interface Section {
    heading: string | null;
    lines: string[];
  }

  const sections: Section[] = [];
  let current: Section = { heading: null, lines: [] };
  let inCodeBlock = false;

  for (const line of lines) {
    // 代码块内的 `##` 不是标题（避免把代码注释误当标题）
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      current.lines.push(line);
      continue;
    }

    if (!inCodeBlock && /^##\s+/.test(line)) {
      if (current.lines.length > 0 || current.heading !== null) {
        sections.push(current);
      }
      current = { heading: line.replace(/^##\s+/, '').trim(), lines: [] };
      continue;
    }

    current.lines.push(line);
  }
  if (current.lines.length > 0 || current.heading !== null) {
    sections.push(current);
  }

  const chunks: Chunk[] = [];

  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    // 跳过纯 H1 前言（无实质内容）与空段
    if (body === '' && section.heading === null) continue;

    const title = section.heading !== null ? `${pageTitle} > ${section.heading}` : pageTitle;

    if (body.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        source,
        title,
        body: body === '' ? `# ${pageTitle}` : body,
        tokenCount: estimateTokens(body),
      });
      continue;
    }

    // 超长小节：滑窗二次切分（带重叠）
    for (const piece of slidingWindow(body, MAX_CHUNK_CHARS, OVERLAP_CHARS)) {
      chunks.push({
        source,
        title,
        body: piece,
        tokenCount: estimateTokens(piece),
      });
    }
  }

  // 无 `##` 结构的短文件：整体作为单 chunk（但会被标记，便于治理）
  if (chunks.length === 0 && content.trim() !== '') {
    chunks.push({
      source,
      title: pageTitle,
      body: content.trim(),
      tokenCount: estimateTokens(content),
    });
  }

  return chunks;
}

/** 滑窗切分：优先在行边界断开 */
function slidingWindow(text: string, size: number, overlap: number): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push(buffer.join('\n'));
  };

  for (const line of lines) {
    const lineLen = line.length + 1;

    if (bufferLen + lineLen > size && buffer.length > 0) {
      flush();
      // 保留尾部若干行作为重叠
      const keep: string[] = [];
      let keepLen = 0;
      for (let i = buffer.length - 1; i >= 0 && keepLen < overlap; i--) {
        keep.unshift(buffer[i]!);
        keepLen += buffer[i]!.length + 1;
      }
      buffer = keep;
      bufferLen = keepLen;
    }

    buffer.push(line);
    bufferLen += lineLen;
  }
  flush();

  return out.filter((s) => s.trim() !== '');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** 分块统计（供治理报告） */
export interface ChunkStats {
  files: number;
  chunks: number;
  /** 每个文件的 chunk 数分布（用于发现「只有 1 chunk」的文件） */
  singleChunkFiles: string[];
  /** 平均 chunk 字符数 */
  avgChars: number;
}

export function computeStats(all: Chunk[]): ChunkStats {
  const bySource = new Map<string, number>();
  for (const c of all) {
    bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  }

  const totalChars = all.reduce((sum, c) => sum + c.body.length, 0);

  return {
    files: bySource.size,
    chunks: all.length,
    singleChunkFiles: [...bySource.entries()]
      .filter(([, n]) => n === 1)
      .map(([s]) => s)
      .sort(),
    avgChars: all.length > 0 ? Math.round(totalChars / all.length) : 0,
  };
}
