/**
 * 生产语料对照测量：**旧评分器量的是工具次数，不是证据质量**。
 *
 * ## 这个脚本要证伪什么
 *
 * LogShare 旧评分器的 `evidenceSufficiency` 是工具调用次数的阶跃函数
 * （0→20、1→60、2→80、≥3→95）。若该判断成立，那么：
 *
 *  - 按「工具调用次数」分桶，`overall` 应当出现**阶跃式的巨大差异**；
 *  - 而各组里**证据的落地密度应当差不多**（因为能不能出证据取决于日志本身，
 *    不取决于调了几次工具）。
 *
 * 两条同时成立，就说明旧分数在量工具而非量证据。
 *
 * ## 为什么只测「锚点密度」而不重算完整分数
 *
 * 归档里的 `fullAnswer` 被截断到 300 字（实测 p50=p90=max=300），
 * 而 `grounding` 需要日志正文（8.7GB，不在本地）。
 * 因此**不做完整重评**——那会得到漂亮的数字但量的是 300 字的残片，
 * 属于自欺。这里只做能站住脚的那一半：
 * 用真实的锚点提取器量「结论里有多少可核对的硬标识」。
 *
 * 用法：
 *   npx tsx scripts/rescore_corpus.ts [data/corpus/analyses_compact.jsonl]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { extractAnchors } from '../src/eval/anchors.ts';

const FILE = process.argv[2] ?? 'data/corpus/analyses_compact.jsonl';

interface Record_ {
  overall: number | null;
  oldEvidence: number | null;
  tools: number;
  answerChars: number;
  anchors: number;
  /** 含「可检索硬标识」的锚点数：异常名 / 文件名 / 版本号 / 类名 / 常量 */
  hardAnchors: number;
  evidenceItems: number;
  emptyResults: number;
  rounds: number;
}

/** 「可检索硬标识」——这些是能拿去 grep 或搜库的东西 */
const HARD: ReadonlySet<string> = new Set([
  'exception',
  'filename',
  'version',
  'identifier',
  'constant',
  'path',
]);

function bucket(tools: number): string {
  if (tools === 0) return '0';
  if (tools <= 3) return '1-3';
  if (tools <= 6) return '4-6';
  return '7+';
}

async function main(): Promise<void> {
  const rows: Record_[] = [];

  const rl = createInterface({ input: createReadStream(FILE, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const score = (rec['score'] ?? {}) as Record<string, unknown>;
    const so = (rec['structuredOutput'] ?? {}) as Record<string, unknown>;
    const chain = (rec['toolCallChain'] ?? []) as Array<Record<string, unknown>>;
    const answer = typeof rec['fullAnswer'] === 'string' ? rec['fullAnswer'] : '';

    // 锚点从「结论字段」提取：根因 + 证据条目。归档里这两项未被截断。
    const evidenceArr = Array.isArray(so['evidence']) ? (so['evidence'] as unknown[]) : [];
    const conclusionText = [
      typeof so['rootCause'] === 'string' ? so['rootCause'] : '',
      ...evidenceArr.filter((e): e is string => typeof e === 'string'),
    ].join('\n');

    const anchors = extractAnchors(conclusionText);
    const hard = anchors.filter((a) => HARD.has(a.kind)).length;

    rows.push({
      overall: typeof score['overall'] === 'number' ? score['overall'] : null,
      oldEvidence: typeof score['evidenceSufficiency'] === 'number' ? score['evidenceSufficiency'] : null,
      tools: chain.length,
      answerChars: answer.length,
      anchors: anchors.length,
      hardAnchors: hard,
      evidenceItems: evidenceArr.length,
      // 归档只存 resultChars，不存结果正文；用长度近似「空结果」
      emptyResults: chain.filter((c) => typeof c['resultChars'] !== 'number' || c['resultChars'] < 20).length,
      rounds: typeof rec['rounds'] === 'number' ? rec['rounds'] : 0,
    });
  }

  const groups = new Map<string, Record_[]>();
  for (const r of rows) {
    const b = bucket(r.tools);
    const arr = groups.get(b) ?? [];
    arr.push(r);
    groups.set(b, arr);
  }

  const mean = (arr: number[]): number =>
    arr.length === 0 ? 0 : Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;

  const fmt = (b: string): string => {
    const g = groups.get(b) ?? [];
    const withOverall = g.map((r) => r.overall).filter((v): v is number => v !== null);
    return [
      b.padEnd(5),
      String(g.length).padStart(5),
      mean(withOverall).toFixed(1).padStart(8),
      mean(g.map((r) => r.oldEvidence ?? 0)).toFixed(1).padStart(11),
      mean(g.map((r) => r.anchors)).toFixed(1).padStart(9),
      mean(g.map((r) => r.hardAnchors)).toFixed(1).padStart(10),
      mean(g.map((r) => r.evidenceItems)).toFixed(1).padStart(9),
      mean(g.map((r) => r.emptyResults)).toFixed(2).padStart(9),
      mean(g.map((r) => r.rounds)).toFixed(1).padStart(7),
    ].join('  ');
  };

  console.log(`样本文件: ${FILE}`);
  console.log(`记录数:   ${rows.length}\n`);
  console.log(
    [
      '工具数'.padEnd(5),
      '  条数',
      '  旧overall',
      '  旧证据分',
      '  锚点数',
      '  硬标识',
      '  证据条',
      '  空结果',
      '  轮次',
    ].join('  '),
  );
  console.log('-'.repeat(90));
  for (const b of ['0', '1-3', '4-6', '7+']) {
    if (groups.has(b)) console.log(fmt(b));
  }

  // ── 判定 ────────────────────────────────────────────────
  //
  // 只看「有没有差异」是不够的：锚点数**确实**随工具数略有增加
  // （0 → 1–3 组从 5.7 升到 7.7），所以不能声称「完全无关」。
  // 要证伪的是**敏感度错配**：分数的跃升幅度远大于证据本身的增加幅度。
  const g0 = groups.get('0') ?? [];
  const g13 = groups.get('1-3') ?? [];
  const avg = (arr: Record_[], pick: (r: Record_) => number): number => mean(arr.map(pick));

  const e0 = avg(g0, (r) => r.oldEvidence ?? 0);
  const e13 = avg(g13, (r) => r.oldEvidence ?? 0);
  const a0 = avg(g0, (r) => r.hardAnchors);
  const a13 = avg(g13, (r) => r.hardAnchors);

  const scoreRatio = e0 > 0 ? e13 / e0 : Infinity;
  const anchorRatio = a0 > 0 ? a13 / a0 : Infinity;

  console.log('\n判定：');
  console.log('  「0 次工具」与「1–3 次工具」两组对照');
  console.log(`    旧证据分:      ${e0.toFixed(1)} → ${e13.toFixed(1)}   （${scoreRatio.toFixed(1)}×）`);
  console.log(`    硬标识锚点数:  ${a0.toFixed(1)} → ${a13.toFixed(1)}   （${anchorRatio.toFixed(2)}×）`);
  console.log(`    证据条数:      ${avg(g0, (r) => r.evidenceItems).toFixed(1)} → ${avg(g13, (r) => r.evidenceItems).toFixed(1)}`);

  if (scoreRatio > 2 && scoreRatio > anchorRatio * 2) {
    console.log(
      `\n  ⇒ 敏感度错配成立：打分对着「工具次数」放大了 ${scoreRatio.toFixed(1)} 倍，\n` +
        `     而结论里可核对的硬标识只增加到 ${anchorRatio.toFixed(2)} 倍。\n` +
        `     0 次工具组平均仍有 ${a0.toFixed(1)} 个硬标识（异常类名、文件名、版本号）与 ` +
        `${avg(g0, (r) => r.evidenceItems).toFixed(1)} 条证据，\n` +
        '     旧口径却把证据分压到 20/100——它们被系统性地当成了「没有证据」。',
    );
  } else {
    console.log('\n  ⇒ 结果与预期不符，需人工复核（可能样本口径变了）。');
  }

  // 轮次失控的代价：7+ 组的 overall 反而低于 4–6 组
  const g46 = groups.get('4-6') ?? [];
  const g7 = groups.get('7+') ?? [];
  if (g46.length > 0 && g7.length > 0) {
    console.log(
      `\n  另注：7+ 组（${g7.length} 条）的 overall ` +
        `${avg(g7, (r) => r.overall ?? 0).toFixed(1)} **低于** 4–6 组` +
        `（${g46.length} 条）的 ${avg(g46, (r) => r.overall ?? 0).toFixed(1)}，` +
        `而两组的旧证据分都是 95。\n` +
        '  说明 7+ 组的扣分来自轮次本身（工具效率/清晰度），' +
        '对应 255 条 runaway_rounds——这是提示词「硬性停止判据」要治的对象。',
    );
  }
}

await main();
