/**
 * 索引构建 —— 从知识库 Markdown 生成 SQLite FTS5 索引。
 *
 * ## 与 LogShare 的兼容性
 * 表结构与 LogShare 的 `rag/index.db` **完全一致**（docs FTS5 虚表 + chunk_meta +
 * doc_embeddings），因此：
 *  - 本服务构建的索引可被 LogShare 读取（过渡期）
 *  - 也可直接复用 LogShare 构建的索引（迁移期）
 *
 * ## 原子性
 * 构建到临时文件，成功后 rename 替换——失败不会破坏线上索引。
 */

import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type Chunk, chunkMarkdown, computeStats } from './chunker.ts';
import { readKnowledgeFiles } from './loader.ts';

/** FTS5 分词器：porter（英文词干）+ unicode61（Unicode 感知），与 LogShare 一致 */
const TOKENIZER = 'porter unicode61';

export interface BuildResult {
  ok: boolean;
  files: number;
  chunks: number;
  /** 只有 1 个 chunk 的文件（结构问题，需治理） */
  singleChunkFiles: string[];
  avgChars: number;
  dbPath: string;
  error?: string;
}

/** 建表：与 LogShare 的 schema 保持一致 */
function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    title,
    body,
    source,
    tokenize = '${TOKENIZER}'
  )`);

  // chunk 元数据侧表（docs 是 FTS5 虚表，不能 ADD COLUMN）
  db.exec(`CREATE TABLE IF NOT EXISTS chunk_meta(
    rowid INTEGER PRIMARY KEY,
    token_count INTEGER NOT NULL DEFAULT 0,
    parent_rowid INTEGER,
    source_mtime INTEGER
  )`);

  // 语义向量（可选，未启用 embedding 时为空）
  db.exec(`CREATE TABLE IF NOT EXISTS doc_embeddings(
    rowid INTEGER PRIMARY KEY,
    vec BLOB NOT NULL
  )`);
}

/**
 * 构建索引。
 *
 * @param knowledgeDir 知识库根目录
 * @param dbPath 目标索引路径
 */
export function buildIndex(knowledgeDir: string, dbPath: string): BuildResult {
  const files = readKnowledgeFiles(knowledgeDir);

  if (files.length === 0) {
    return {
      ok: false,
      files: 0,
      chunks: 0,
      singleChunkFiles: [],
      avgChars: 0,
      dbPath,
      error: `知识库目录为空或不存在: ${knowledgeDir}`,
    };
  }

  // 分块
  const all: Chunk[] = [];
  for (const file of files) {
    all.push(...chunkMarkdown(file.source, file.content));
  }

  const stats = computeStats(all);

  // 构建到临时文件（原子替换）
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmpPath = join(dirname(dbPath), `.build-${process.pid}-${Date.now()}.db`);
  rmSync(tmpPath, { force: true });

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(tmpPath);
    ensureSchema(db);

    const insertDoc = db.prepare('INSERT INTO docs(title, body, source) VALUES (?, ?, ?)');
    const insertMeta = db.prepare(
      'INSERT INTO chunk_meta(rowid, token_count, parent_rowid, source_mtime) VALUES (?, ?, ?, ?)',
    );

    const mtimeBySource = new Map(files.map((f) => [f.source, f.mtime]));

    db.exec('BEGIN');
    for (const chunk of all) {
      const info = insertDoc.run(chunk.title, chunk.body, chunk.source);
      const rowid = Number(info.lastInsertRowid);
      insertMeta.run(rowid, chunk.tokenCount, null, mtimeBySource.get(chunk.source) ?? 0);
    }
    db.exec('COMMIT');

    // 优化 FTS5 索引（合并段，加速查询）
    db.exec("INSERT INTO docs(docs) VALUES('optimize')");

    db.close();
    db = null;

    // 原子替换
    renameSync(tmpPath, dbPath);

    return {
      ok: true,
      files: stats.files,
      chunks: stats.chunks,
      singleChunkFiles: stats.singleChunkFiles,
      avgChars: stats.avgChars,
      dbPath,
    };
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpPath, { force: true });
    return {
      ok: false,
      files: files.length,
      chunks: all.length,
      singleChunkFiles: stats.singleChunkFiles,
      avgChars: stats.avgChars,
      dbPath,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 生成构建报告（供治理用） */
export function formatReport(result: BuildResult): string {
  if (!result.ok) {
    return `索引构建失败：${result.error}`;
  }

  const lines = [
    '索引构建完成',
    `  知识库文件: ${result.files}`,
    `  分块总数:   ${result.chunks}`,
    `  平均块大小: ${result.avgChars} 字符`,
    `  索引路径:   ${result.dbPath}`,
  ];

  if (result.singleChunkFiles.length > 0) {
    lines.push('');
    lines.push(`  ⚠ ${result.singleChunkFiles.length} 个文件只切出 1 个分块（缺少 ## 结构，检索时易被挤出）：`);
    for (const f of result.singleChunkFiles.slice(0, 20)) {
      lines.push(`      ${f}`);
    }
    if (result.singleChunkFiles.length > 20) {
      lines.push(`      ... 另有 ${result.singleChunkFiles.length - 20} 个`);
    }
  }

  return lines.join('\n');
}
