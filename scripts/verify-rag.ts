/**
 * RAG 检索真实索引验证 —— 复现并验证同源重叠缺陷的修复。
 *
 * 用法: RAG_INDEX_PATH=/path/to/rag/index.db npx tsx scripts/verify-rag.ts
 */
import { applySourceQuota, listTopics, search, stats } from '../src/rag/search.ts';

async function main(): Promise<void> {
  console.log('═══ RAG 检索验证（复用 LogShare 现有索引）═══\n');

  const s = stats();
  console.log(`索引统计: ${s ? `${s.files} 个文件 / ${s.chunks} 个分块` : '不可用'}\n`);

  // ── 缺陷 1 复现：同源重叠 ──
  console.log('【缺陷 1】同源重叠（实测：rag_search("Mixin") 返回 5 条全部来自同一文件）');
  console.log('修复前: 重叠率 38%，每次仅 1.20 个不同来源\n');

  for (const q of ['Mixin', 'OutOfMemoryError', 'Java version']) {
    const r = await search({ query: q, k: 5 });
    console.log(`  rag_search("${q}") → ${r.hits.length} 条，来自 ${r.distinctSources} 个不同文件`);
    for (const h of r.hits) {
      console.log(`      · ${h.source}`);
    }
    console.log('');
  }

  // ── 模拟"围绕同一问题反复换词" ──
  console.log('【缺陷 1 强化】模拟模型围绕同一问题换词（实测重叠率 38%）');
  const variants = ['Mixin', 'mixin 注入', 'MixinTransformerError', 'MixinApplyError'];
  const allSources: string[] = [];
  for (const q of variants) {
    const r = await search({ query: q, k: 5 });
    allSources.push(...r.hits.map((h) => `${h.source}#${h.title}`));
    console.log(`  "${q}" → ${r.distinctSources} 个来源`);
  }
  const unique = new Set(allSources);
  const overlap = allSources.length > 0 ? (1 - unique.size / allSources.length) * 100 : 0;
  console.log(`\n  合计 ${allSources.length} 个结果位，去重 ${unique.size} 个`);
  console.log(`  重叠率: ${overlap.toFixed(0)}%（修复前实测 38%）\n`);

  // ── 缺陷 2：embedding 降级显式化 ──
  console.log('【缺陷 2】embedding 降级应显式告知（实测：paraphrase 93.3%→7% 且无告警）');
  const r = await search({ query: '内存不足', k: 3 });
  console.log(`  semanticAvailable = ${r.semanticAvailable}`);
  const hasNotice = r.text.includes('语义检索当前不可用');
  console.log(`  结果中含降级提示: ${hasNotice ? '是 ✓' : '否'}\n`);

  // ── 中文检索（LIKE 兜底） ──
  console.log('【中文检索】FTS5 不处理中文，需 LIKE 兜底');
  for (const q of ['内存不足', '启动闪退', '渲染器崩溃']) {
    const rr = await search({ query: q, k: 3 });
    console.log(`  "${q}" → ${rr.hits.length} 条，${rr.distinctSources} 个来源`);
  }
  console.log('');

  // ── 主题列表 ──
  console.log('【主题目录】');
  console.log(listTopics());

  // ── 同源配额单元验证 ──
  console.log('【同源配额】applySourceQuota 行为');
  const fake = [
    { title: 'a1', body: '', source: 'A', score: -1, snippet: '' },
    { title: 'a2', body: '', source: 'A', score: -2, snippet: '' },
    { title: 'a3', body: '', source: 'A', score: -3, snippet: '' },
    { title: 'b1', body: '', source: 'B', score: -4, snippet: '' },
  ];
  console.log(`  quota=1 → ${applySourceQuota(fake, 1).map((h) => h.title).join(', ')}`);
  console.log(`  quota=2 → ${applySourceQuota(fake, 2).map((h) => h.title).join(', ')}`);
}

void main();
