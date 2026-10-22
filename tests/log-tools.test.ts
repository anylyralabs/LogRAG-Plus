/**
 * 日志工具测试 —— 含 worker 线程与事件循环不阻塞的验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closePool, grepLog, readLog } from '../src/agent/tools/log.ts';

const SAMPLE = [
  '[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11',
  '[12:00:01] [main/WARN]: Configuration file is not correct. Correcting',
  '[12:00:02] [main/INFO]: Loading 42 mods',
  '[12:00:03] [main/ERROR]: java.lang.NoSuchMethodError: net.minecraft.client.Minecraft.resize(int, int)',
  '  at com.example.coolmod.CoolMod.onInit(CoolMod.java:42)',
  '  at net.fabricmc.loader.impl.Knot.launch(Knot.java:72)',
  '[12:00:04] [main/INFO]: Stopping',
].join('\n');

test('grep：基本匹配与行号', async () => {
  const r = await grepLog(SAMPLE, { pattern: 'NoSuchMethodError', contextLines: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.totalMatches, 1);
  assert.equal(r.matches[0]?.line, 4);
  assert.ok(r.text.includes('NoSuchMethodError'));
});

test('grep：忽略大小写（默认）', async () => {
  const r = await grepLog(SAMPLE, { pattern: 'nosuchmethoderror' });
  assert.equal(r.totalMatches, 1, '默认应忽略大小写');
});

test('grep：区分大小写', async () => {
  const r = await grepLog(SAMPLE, { pattern: 'nosuchmethoderror', caseSensitive: true });
  assert.equal(r.totalMatches, 0, '区分大小写时不应匹配');
});

test('grep：非法正则按字面量处理（用户常粘贴含特殊字符的报错原文）', async () => {
  // 括号不配对 → 非法正则 → 应按字面量匹配
  const content = 'error at foo(bar.baz';
  const r = await grepLog(content, { pattern: 'foo(bar.baz' });
  assert.equal(r.ok, true);
  assert.equal(r.totalMatches, 1, '非法正则应回退为字面量匹配');
});

test('grep：合法正则按正则处理（如类名中的元字符）', async () => {
  const content = 'at a.b.C.method()\nat x.y.Z.other()';
  // `\w+\.` 是合法正则，应匹配到两行
  const r = await grepLog(content, { pattern: '\\w+\\.\\w+' });
  assert.equal(r.ok, true);
  assert.equal(r.totalMatches, 2);
});

test('grep：命中行标记 > 与上下文行标记空格', async () => {
  const r = await grepLog(SAMPLE, { pattern: 'NoSuchMethodError', contextLines: 1 });
  const lines = r.text.split('\n');
  const hit = lines.find((l) => l.startsWith('>'));
  const ctx = lines.find((l) => l.startsWith(' ') && l.includes('mods'));
  assert.ok(hit, '应有以 > 开头的命中行');
  assert.ok(ctx, '应有以空格开头的上下文行');
});

test('grep：无匹配时返回可操作的提示', async () => {
  const r = await grepLog(SAMPLE, { pattern: 'ZZZ_NOT_EXIST' });
  assert.equal(r.ok, true);
  assert.equal(r.totalMatches, 0);
  assert.ok(r.text.includes('未找到'));
  assert.ok(r.text.includes('提示'));
});

test('grep：空模式被拒绝', async () => {
  const r = await grepLog(SAMPLE, { pattern: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty pattern');
});

test('grep：相邻命中区间合并不重复输出', async () => {
  const content = ['hit1', 'hit2', 'hit3'].join('\n');
  const r = await grepLog(content, { pattern: 'hit', contextLines: 1 });
  assert.equal(r.totalMatches, 3);
  // 三行相邻，应合并为一个区间（只出现一次区间标记）
  const rangeMarkers = r.text.split('\n').filter((l) => l.startsWith('... 第'));
  assert.equal(rangeMarkers.length, 1, '相邻区间应合并');
});

test('read：读取指定行区间', async () => {
  const r = await readLog(SAMPLE, { lineStart: 3, lineEnd: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.startLine, 3);
  assert.equal(r.endLine, 5);
  assert.ok(r.text.includes('Loading 42 mods'));
});

test('read：默认读取全文', async () => {
  const r = await readLog(SAMPLE);
  assert.equal(r.startLine, 1);
  assert.equal(r.endLine, 7);
  assert.equal(r.truncated, false);
});

test('read：起始行越界时明确报错', async () => {
  const r = await readLog(SAMPLE, { lineStart: 999 });
  assert.equal(r.ok, false);
  assert.ok(r.text.includes('超出日志总行数'));
});

test('read：超长内容截断并给出续读位置', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
  const r = await readLog(big, { maxBytes: 2000 });
  assert.equal(r.truncated, true);
  assert.ok(r.nextStart !== undefined);
  assert.ok(r.nextStart! > r.endLine);
  assert.ok(r.text.includes('如需继续'));
});

test('read：行号宽度对齐（大日志）', async () => {
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
  const r = await readLog(big, { lineStart: 1, lineEnd: 3 });
  const lines = r.text.split('\n').filter((l) => /^\s*\d+ \|/.test(l));
  assert.ok(lines.length >= 3);
  // 所有行号前缀宽度一致
  const widths = new Set(lines.map((l) => l.indexOf(' |')));
  assert.equal(widths.size, 1, '行号应右对齐');
});

test('worker 线程：CPU 密集检索不阻塞主线程事件循环', async () => {
  // 构造约 10MB 日志（与实测场景一致）
  const line = '[12:00:00] [main/INFO]: some log line with padding text for bulk\n';
  const big = line.repeat(Math.ceil((10 * 1024 * 1024) / line.length));

  // ## 这条断言改了三次，前两次都是「假断言」——记下来免得后人再走一遍
  //
  // 1. 最初 `maxGap < 500`（未隔离时实测 1423ms）。它测的是**机器负载**：
  //    全量跑时 20 多个 node 进程并行抢 CPU，主线程被延后调度就超 500ms，
  //    而 worker 隔离其实工作正常——实测全量红、单独绿，代码一字未改。
  //
  // 2. 改成「扫描期间心跳 ≥5 次」，**用探针实测过是假的**：把 grep 强制改回
  //    同线程执行，10MB 扫描只要 148ms，10ms 心跳照样跳十几次，断言依然全绿。
  //    「跳多少次」在 150ms 量级的任务上根本不区分隔离与否。
  //
  // 3. 现在用**顺序**判据，与 CPU 快慢无关：
  //    `grepLog()` 同步实现会在调用返回前扫完全文，于是它的 `.then`（微任务）
  //    一定先于下面的 `setTimeout(0)`（宏任务）执行；而 worker 实现的扫描发生在
  //    另一条线程上，调用立即返回，`setTimeout(0)` 先跑、此时扫描尚未完成。
  //    因此「让出一个宏任务后，扫描是否仍未完成」是二值结论：
  //    没让出去 = 它占着主线程，正是 1423ms 停顿的成因。
  // 先预热 worker 池：首次调用要 `new Worker()`，而**创建线程是同步的**，
  // 会占住主线程几百毫秒。并行跑时这点同步开销足以让下面的 `setTimeout(0)`
  // 抢不到执行机会，从而误判成「检索跑在主线程上」——实测全量红、单跑绿。
  // 预热后测的才是「扫描本身是否在另一条线程」，这才是要守的性质。
  await grepLog('warmup', { pattern: 'x', maxMatches: 1 });

  let settled = false;
  const scan = grepLog(big, { pattern: 'padding', maxMatches: 5, contextLines: 0 }).then((r) => {
    settled = true;
    return r;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const mainThreadWasFree = !settled;

  const r = await scan;
  assert.equal(r.ok, true);
  assert.ok(r.totalMatches > 0, '应在 10MB 日志中命中');
  assert.ok(
    mainThreadWasFree,
    '扫描期间主线程必须能被让出；这里扫描在让出前就已完成，说明检索跑在主线程上',
  );
});

test.after(async () => {
  await closePool();
});
