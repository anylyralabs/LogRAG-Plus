/**
 * 知识库文件加载。
 *
 * 只加载 `.md` / `.txt`，忽略其他文件与隐藏目录。
 * 返回 `source` 为相对知识库根的路径（与 LogShare 的 `docs.source` 口径一致）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface KnowledgeFile {
  /** 相对知识库根的路径，如 `patterns/out-of-memory.md` */
  source: string;
  content: string;
  /** 文件 mtime（毫秒），供增量构建比对 */
  mtime: number;
}

/** 忽略的目录（编辑器产物、版本控制等） */
const IGNORED_DIRS = new Set(['.git', '.obsidian', '.idea', 'node_modules', '__pycache__']);

/** 可索引的扩展名 */
const INDEXABLE = /\.(md|markdown|txt)$/i;

function walk(dir: string, baseDir: string, out: KnowledgeFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);

    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (IGNORED_DIRS.has(entry)) continue;
      walk(full, baseDir, out);
      continue;
    }

    if (!INDEXABLE.test(entry)) continue;
    if (stat.size === 0) continue;

    let content: string;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    // 去掉 UTF-8 BOM（部分编辑器会写入，会污染 FTS5 分词）
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }

    out.push({
      source: relative(baseDir, full).split('\\').join('/'),
      content,
      mtime: Math.floor(stat.mtimeMs),
    });
  }
}

/** 读取知识库全部文件（按 source 排序，保证构建可复现） */
export function readKnowledgeFiles(knowledgeDir: string): KnowledgeFile[] {
  const out: KnowledgeFile[] = [];
  walk(knowledgeDir, knowledgeDir, out);
  return out.sort((a, b) => a.source.localeCompare(b.source));
}
