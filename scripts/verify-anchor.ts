/**
 * 用真实的 27 份移动端日志验证窗口锚点修复效果。
 *
 * 对照组：LogShare 现有实现（首次匹配 Tier1/Tier2）的实测结果 —— 覆盖 3/17，错过 14。
 *
 * 用法: npx tsx scripts/verify-anchor.ts <日志目录>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildLogWindow } from '../src/text/window.ts';

/** 真崩溃位置的判据（与实测报告一致） */
const REAL_CRASH = /A fatal error has been detected|Minecraft Crash Report|ZalithLauncher Crash Report|Minecraft has crashed!|Failed to load a library|Could not create the Java Virtual Machine|Could not find Java SE Runtime Environment/i;

function realCrashLine(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (REAL_CRASH.test(lines[i]!)) return i + 1; // 1-based
  }
  return null;
}

interface Row {
  file: string;
  totalLines: number;
  anchorLine: number | null;
  matchedBy: string | null;
  structural: boolean;
  realCrash: number | null;
  verdict: string;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: npx tsx scripts/verify-anchor.ts <日志目录>');
    process.exit(1);
  }

  const files = readdirSync(dir).filter((f) => {
    const p = join(dir, f);
    return statSync(p).isFile() && /\.(log|txt)$/i.test(f);
  });

  const rows: Row[] = [];
  let covered = 0;
  let missed = 0;
  let noAnchor = 0;

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf8');
    const lines = content.split('\n');
    const window = buildLogWindow(content, { maxBytes: 12000 });
    const real = realCrashLine(lines);

    let verdict = '-';
    // 短日志走「全量返回」路径：内容整体进入上下文，天然覆盖真崩溃
    const isFullWindow =
      window.startLine === 1 && window.endLine === lines.length;
    if (isFullWindow) {
      verdict = '全量';
      if (real !== null) covered++;
    } else if (window.anchorLine !== null && real !== null) {
      if (real >= window.startLine && real <= window.endLine) {
        verdict = 'OK';
        covered++;
      } else {
        verdict = `错过 ${Math.abs(real - window.anchorLine)} 行`;
        missed++;
      }
    } else if (window.anchorLine === null && real !== null) {
      verdict = '未定位';
      noAnchor++;
    }

    rows.push({
      file,
      totalLines: lines.length,
      anchorLine: window.anchorLine,
      matchedBy: window.matchedBy,
      structural: window.structural,
      realCrash: real,
      verdict,
    });
  }

  console.log('═══ 窗口锚点修复验证（27 份真实日志）═══\n');
  console.log(
    `${'文件'.padEnd(44)} ${'总行'.padStart(6)} ${'锚点'.padStart(6)} ${'真崩溃'.padStart(6)}  ${'命中来源'.padEnd(22)} 判定`,
  );
  console.log('-'.repeat(120));

  for (const r of rows.sort((a, b) => a.file.localeCompare(b.file))) {
    const structuralMark = r.structural ? '★' : ' ';
    console.log(
      `${r.file.slice(0, 42).padEnd(44)} ${String(r.totalLines).padStart(6)} ${String(r.anchorLine ?? '-').padStart(6)} ${String(r.realCrash ?? '-').padStart(6)}  ${(structuralMark + (r.matchedBy ?? '-')).padEnd(22)} ${r.verdict}`,
    );
  }

  const total = covered + missed + noAnchor;
  console.log('\n─── 汇总 ───');
  console.log(`含真崩溃标记的日志: ${total} 份`);
  console.log(`  窗口覆盖: ${covered}`);
  console.log(`  错过:     ${missed}`);
  console.log(`  未定位:   ${noAnchor}`);
  if (total > 0) {
    console.log(`  错过率:   ${((missed / total) * 100).toFixed(0)}%`);
  }
  console.log('\n对照（LogShare 现有实现）: 覆盖 3 / 错过 14 / 平均偏差 917 行');
  console.log('★ = 结构性标记命中（高置信，不存在误判）');
}

main();
