/**
 * 知识库边界守门 —— 防止「方法论」重新混入 RAG。
 *
 * ## 为什么需要这个测试
 * 知识库回答「这是什么故障、怎么修」（随生态变化）；
 * 方法论回答「怎么搜、怎么定位、用哪个工具」（跨故障通用，固定不变）。
 *
 * 方法论若混入知识库，会被当作事实检索出来——模型可能把「排查流程」当成「答案」
 * 输出给用户；且方法论的高频通用词会稀释 BM25 信号。
 *
 * 实测教训：初版知识条目里混入了 `## 通用排查流程`、`## 判定依据速查`、
 * `## 诊断辅助`、`## 为什么必须区分` 等小节，本测试用于防止回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KNOWLEDGE_DIR = new URL('../knowledge/', import.meta.url).pathname;

/** 允许的小节名（领域知识） */
const ALLOWED_SECTIONS = [
  /^签名\s*\(Signature\)$/,
  /^含义$/,
  /^常见触发$/,
  /^触发\s+[A-Z]：/, // 「触发 A：xxx」
  /^修复步骤$/,
  /^置信度线索$/,
  /^背景[:：]/, // 必要的背景说明（如 SDL3 迁移）
  /^主流渲染器对照$/, // 对照表属事实性内容
  /^MC 版本 ↔ Java 版本对应/, // 版本矩阵属事实性内容
  /^移动端的 Java 运行时是/, // 背景说明
  /^为什么移动端特别容易踩/, // 背景说明
  /^版本\s*↔\s*Java/, // 版本矩阵
  /^日志字段与流程阶段的对照$/, // 格式文档：字段 → 流程阶段（事实性对照，非判据）
];

/** 禁止的小节名（方法论——应在 prompts/ 中） */
const FORBIDDEN_SECTIONS = [
  /^通用排查流程$/,
  /^判定依据速查$/,
  /^判定要点$/,
  /^诊断辅助/,
  /^为什么必须区分$/,
  /^渲染器问题的通用排查法$/,
  /^处理步骤$/, // 方法论式的「处理步骤」应写作「修复步骤」
  /^相关连带问题$/,
  /^检索/,
  /^怎么搜/,
  /^工具选择/,
  /^预算/,
  /^输出规格/,
  /^分层展示/,
];

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function sections(content: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = line.match(/^##\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

test('知识库条目不含方法论小节（边界守门）', () => {
  const files = listMarkdown(KNOWLEDGE_DIR);
  assert.ok(files.length > 0, '知识库不应为空');

  const violations: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const section of sections(content)) {
      const forbidden = FORBIDDEN_SECTIONS.find((re) => re.test(section));
      if (forbidden) {
        violations.push(`${file.replace(KNOWLEDGE_DIR, '')} → 「## ${section}」`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `以下小节属方法论，应移至 prompts/：\n${violations.join('\n')}`,
  );
});

test('知识库条目的小节名在白名单内', () => {
  const files = listMarkdown(KNOWLEDGE_DIR);
  const unknown: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const section of sections(content)) {
      const allowed = ALLOWED_SECTIONS.some((re) => re.test(section));
      if (!allowed) {
        unknown.push(`${file.replace(KNOWLEDGE_DIR, '')} → 「## ${section}」`);
      }
    }
  }

  assert.deepEqual(
    unknown,
    [],
    `以下小节名不在白名单内（新增类型请先更新 ALLOWED_SECTIONS 并确认属领域知识）：\n${unknown.join('\n')}`,
  );
});

test('每个知识条目都有 H1 标题与签名小节', () => {
  for (const file of listMarkdown(KNOWLEDGE_DIR)) {
    const content = readFileSync(file, 'utf8');
    const rel = file.replace(KNOWLEDGE_DIR, '');

    assert.match(content, /^#\s+.+$/m, `${rel} 缺少 H1 标题`);

    const hasSignature = /^##\s+签名/m.test(content);
    const hasMeaning = /^##\s+含义/m.test(content);
    assert.ok(
      hasSignature || hasMeaning,
      `${rel} 应含「## 签名」或「## 含义」小节（检索单元的基本结构）`,
    );
  }
});

test('方法论文件存在于 prompts/ 且不在 knowledge/', () => {
  const promptsDir = new URL('../prompts/', import.meta.url).pathname;
  const promptFiles = listMarkdown(promptsDir).map((f) => f.replace(promptsDir, ''));
  assert.ok(promptFiles.includes('retrieval-strategy.md'), 'prompts/ 应含检索策略');
  assert.ok(promptFiles.includes('output-spec.md'), 'prompts/ 应含输出规格');

  // 反向：knowledge/ 下不应有同名文件
  const knowledgeFiles = listMarkdown(KNOWLEDGE_DIR).map((f) => f.replace(KNOWLEDGE_DIR, ''));
  for (const p of promptFiles) {
    assert.ok(!knowledgeFiles.includes(p), `${p} 不应同时存在于 knowledge/`);
  }
});
