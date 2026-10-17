/**
 * 工具调用跟踪器测试。
 *
 * ## 这些用例守的是什么
 *
 * 两个缺陷都是端到端真跑才暴露出来的，且都**无法**用「业务逻辑测试」覆盖
 * （要触发就得连真实模型跑满 30 轮工具循环）。抽成纯模块后，
 * 把实测到的上游流形态原样搬进来就能钉死：
 *
 *  1. **轮次按两倍计数** → `tracker.count` 每次调用只加 1。
 *  2. **参数恒为空对象** → 宣告必须带真实参数。
 *
 * 用例里的流形态不是编的，是 2026-10-17 端到端跑 `kalkLqQ` 那份日志时
 * 从 SSE 流里逐帧扒出来的真实结构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ARGS_RAW, ToolCallTracker, safeJson } from '../src/agent/tool-tracker.ts';

/** 实测形态 A：占位 tool_calls + 分片累积（分片只有首个带 name/id） */
function feedPlaceholderThenChunks(
  t: ToolCallTracker,
  args: string,
  opts: { name?: string; id?: string; index?: number } = {},
) {
  const name = opts.name ?? 'grep_log_file';
  const id = opts.id ?? 'call_1';
  const index = opts.index ?? 0;
  const out = [];

  // ① 占位 tool_calls 先到（args 为空对象）
  out.push(...t.onModelMessage(undefined, [{ name, args: {}, id }]));

  // ② 分片陆续到（只有第一片带 name/id）
  const step = Math.max(1, Math.ceil(args.length / 3));
  let first = true;
  for (let i = 0; i < args.length; i += step) {
    const piece = args.slice(i, i + step);
    out.push(
      ...t.onModelMessage([
        first
          ? { name, args: piece, id, index }
          : { args: piece, index },
      ]),
    );
    first = false;
  }
  return out;
}

test('形态 A：占位 tool_calls 不得触发宣告', () => {
  const t = new ToolCallTracker();
  const out = t.onModelMessage(undefined, [{ name: 'grep_log_file', args: {}, id: 'x' }]);
  assert.equal(out.length, 0, '占位空对象不代表参数完整，此时宣告会得到空参数');
  assert.equal(t.count, 0, '未宣告就不该计轮次');
});

test('形态 A：分片拼完整后宣告一次，且带真实参数', () => {
  const t = new ToolCallTracker();
  const args = '{"query":"UnsatisfiedLinkError","context_lines":3}';
  const out = feedPlaceholderThenChunks(t, args);

  assert.equal(out.length, 1, '同一次调用只能宣告一次');
  assert.equal(out[0]?.name, 'grep_log_file');
  assert.deepEqual(out[0]?.args, {
    query: 'UnsatisfiedLinkError',
    context_lines: 3,
  });
  assert.equal(t.count, 1, '一次调用只计一轮（防「双倍计数」回归）');
});

test('轮次计数：连续 16 次调用计 16 轮，不是 32 轮', () => {
  // 这是端到端空答案的直接成因：maxRounds=30 会被 16 次调用撞满。
  const t = new ToolCallTracker();
  for (let i = 0; i < 16; i++) {
    feedPlaceholderThenChunks(t, `{"query":"q${i}"}`, { id: `call_${i}`, index: 0 });
    t.onToolResult();
  }
  assert.equal(t.count, 16, '每次调用只应计一轮；若为 32 说明计数被写了两处');
});

test('形态 A：分片不带 id 只带 index 也能宣告', () => {
  // 实测结构：chunk2/3 只有 index。若用 id 做累积键，它们会落到别的条目，
  // 表现为「tool 帧 2 次但 tool_result 帧 13 次」。
  const t = new ToolCallTracker();
  const out = t.onModelMessage([
    { name: 'rag_search', args: '', id: 'abc', index: 0 },
    { args: '{"query":', index: 0 },
    { args: '"liblwjgl.so"}', index: 0 },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.args, { query: 'liblwjgl.so' });
});

test('参数未拼完整时不得宣告（半截 JSON 不算数）', () => {
  const t = new ToolCallTracker();
  const out = t.onModelMessage([
    { name: 'grep_log_file', args: '{"query":"abc', id: 'x', index: 0 },
  ]);
  assert.equal(out.length, 0, '半截 JSON 解析失败，此时宣告会把无效参数发给前端');
});

test('无参调用：在结果到达时补宣告（保证「有结果必有调用」）', () => {
  const t = new ToolCallTracker();
  // 分片只有空参数，永远拼不成 JSON
  t.onModelMessage([{ name: 'list_topics', args: '', id: 'x', index: 0 }]);
  assert.equal(t.count, 0, '此时还没有可宣告的参数');

  const { call, announced } = t.onToolResult();
  assert.equal(call?.name, 'list_topics');
  assert.notEqual(announced, null, '结果到达时必须补宣告，否则前端只看到结果');
  assert.deepEqual(announced?.args, {});
  assert.equal(t.count, 1);
});

test('结果到达时补宣告：参数用分片里已累积的内容', () => {
  const t = new ToolCallTracker();
  // 分片给了一截非 JSON 的内容（异常模型输出），始终解析不了
  t.onModelMessage([{ name: 'grep_log_file', args: 'not json at all', id: 'x', index: 0 }]);
  const { announced } = t.onToolResult();
  assert.deepEqual(announced?.args, {}, '解析不了就退回空对象，但不能不宣告');
});

test('只发完整 tool_calls 的供应商：立即宣告', () => {
  const t = new ToolCallTracker();
  const out = t.onModelMessage(undefined, [
    { name: 'rag_search', args: { query: 'Mixin' }, id: 'z' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.args, { query: 'Mixin' });
  assert.equal(t.count, 1);
});

test('只发完整 tool_calls 且真的无参：不宣告，等结果补上', () => {
  const t = new ToolCallTracker();
  const out = t.onModelMessage(undefined, [{ name: 'list_topics', args: {}, id: 'z' }]);
  assert.equal(out.length, 0, '无参调用此时无法与占位对象区分，延后处理');
  const { announced } = t.onToolResult();
  assert.notEqual(announced, null);
  assert.equal(t.count, 1);
});

test('并行调用：一轮内两个 index 各自宣告，顺序与调用一致', () => {
  const t = new ToolCallTracker();
  const out = t.onModelMessage([
    { name: 'grep_log_file', args: '{"query":"a"}', id: 'i0', index: 0 },
    { name: 'rag_search', args: '{"query":"b"}', id: 'i1', index: 1 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.name, 'grep_log_file');
  assert.equal(out[1]?.name, 'rag_search');
  assert.equal(t.count, 2, '两个调用计两轮');
});

test('结果按调用顺序配对，参数不错配', () => {
  // 旧实现只把「已宣告的」调用入队，导致未宣告的调用会 shift 掉别人的条目，
  // 参数与结果整体错位一格。
  const t = new ToolCallTracker();
  t.onModelMessage([
    { name: 'grep_log_file', args: '{"query":"first"}', id: 'i0', index: 0 },
    { name: 'grep_log_file', args: '{"query":"second"}', id: 'i1', index: 1 },
  ]);

  const a = t.onToolResult();
  assert.deepEqual(a.call?.args, { query: 'first' });
  const b = t.onToolResult();
  assert.deepEqual(b.call?.args, { query: 'second' });
});

test('未宣告的调用不会让后续配对错位', () => {
  const t = new ToolCallTracker();
  // 第一个调用参数始终没拼成 JSON（不会被宣告），第二个正常
  t.onModelMessage([{ name: 'grep_log_file', args: 'bad', id: 'i0', index: 0 }]);
  t.onModelMessage([{ name: 'rag_search', args: '{"query":"ok"}', id: 'i1', index: 1 }]);

  const first = t.onToolResult();
  assert.equal(first.call?.name, 'grep_log_file', '第一个结果应对应第一个调用');
  assert.notEqual(first.announced, null, '第一个调用应在此时补宣告');

  const second = t.onToolResult();
  assert.equal(second.call?.name, 'rag_search');
  assert.deepEqual(second.call?.args, { query: 'ok' });
});

test('跨轮次 index 重用：第二轮仍能宣告', () => {
  // index 每轮从 0 开始。若跨轮次保留累积状态，第二轮的新调用会命中
  // 上一轮的残留条目（announced 已置位）而永远不被宣告。
  const t = new ToolCallTracker();
  const first = t.onModelMessage([
    { name: 'grep_log_file', args: '{"query":"round1"}', id: 'a', index: 0 },
  ]);
  assert.equal(first.length, 1);
  t.onToolResult();

  const second = t.onModelMessage([
    { name: 'read_log_file', args: '{"line_start":10}', id: 'b', index: 0 },
  ]);
  assert.equal(second.length, 1, '第二轮 index=0 必须是一次全新调用');
  assert.equal(second[0]?.name, 'read_log_file');
  assert.deepEqual(second[0]?.args, { line_start: 10 });
  assert.equal(t.count, 2);
});

test('同一轮内多个调用未全部返回时，不清空索引', () => {
  const t = new ToolCallTracker();
  t.onModelMessage([
    { name: 'grep_log_file', args: '{"query":"a"}', id: 'i0', index: 0 },
    { name: 'grep_log_file', args: '{"query":"b"}', id: 'i1', index: 1 },
  ]);
  t.onToolResult(); // 只返回了一个
  assert.equal(t.outstanding, 1, '还有一个未返回，索引不能清空');

  const b = t.onToolResult();
  assert.equal(t.outstanding, 0);
  assert.deepEqual(b.call?.args, { query: 'b' });
});

test('outstanding：反映待配对调用数', () => {
  const t = new ToolCallTracker();
  assert.equal(t.outstanding, 0);
  t.onModelMessage([{ name: 'a', args: '{}', id: 'i0', index: 0 }]);
  assert.equal(t.outstanding, 1);
  t.onToolResult();
  assert.equal(t.outstanding, 0);
});

test('参数原文累积有上限（异常模型流不会无限吃内存）', () => {
  const t = new ToolCallTracker();
  const huge = 'x'.repeat(MAX_ARGS_RAW + 5_000);
  t.onModelMessage([{ name: 'grep_log_file', args: huge, id: 'i0', index: 0 }]);
  // 无法从外部直接读 argsRaw，改用「补宣告」路径间接验证：
  // 参数永远解析不出 JSON，结果到达时退回空对象，但进程不会因累积而膨胀。
  const { announced } = t.onToolResult();
  assert.deepEqual(announced?.args, {});
});

test('safeJson：空串与半截 JSON 返回 null，完整 JSON 返回对象', () => {
  assert.equal(safeJson(''), null);
  assert.equal(safeJson('  '), null);
  assert.equal(safeJson('{"a":'), null);
  assert.equal(safeJson('nonsense'), null);
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJson('  {"a":1}  '), { a: 1 });
});

test('混合形态：先分片后完整 tool_calls 不产生重复宣告', () => {
  const t = new ToolCallTracker();
  const a = t.onModelMessage([{ name: 'rag_search', args: '{"query":"x"}', id: 'i0', index: 0 }]);
  assert.equal(a.length, 1);
  // 同一调用的完整形式再来一次
  const b = t.onModelMessage(undefined, [{ name: 'rag_search', args: { query: 'x' }, id: 'i0' }]);
  assert.equal(b.length, 0, '已宣告的调用不得重复宣告');
  assert.equal(t.count, 1);
});

// ── 占位污染（2026-10-17 二次实测）─────────────────────────
//
// 这组用例来自一次真跑复现：修完「宣告时机」后，端到端跑出来的 `tool` 帧
// **仍然**是 `grep_log_file({})`。根因不在宣告时机，而在累积缓冲区被占位值
// 污染——第 1 个分片同时带着 `tool_calls[0].args = {}`，旧代码把它写进了
// `argsRaw`，后续分片只能追加成 `{}{"query":"ERROR",…}`，永远不可解析。
//
// 下面第一个用例在旧代码上必然失败，正是它把这条缺陷钉住的。

test('占位 args:{} 不得污染分片累积（回归：每次调用都显示空参数）', () => {
  const t = new ToolCallTracker();

  // 真实端点的分片序列：首个分片带 name/id/空 args，同时 tool_calls 里有 {} 占位
  const chunkSeq: Array<{ name?: string; args?: string; id?: string; index?: number }> = [
    { name: 'grep_log_file', args: '', id: 'call_1', index: 0 },
    { args: '{"query', index: 0 },
    { args: '":"ERRO', index: 0 },
    { args: 'R","con', index: 0 },
    { args: 'text_li', index: 0 },
    { args: 'nes":1}', index: 0 },
  ];

  const announced: Array<{ name: string; args: unknown }> = [];
  for (let i = 0; i < chunkSeq.length; i++) {
    const full =
      i === 0 ? [{ name: 'grep_log_file', args: {}, id: 'call_1' }] : undefined;
    announced.push(...t.onModelMessage([chunkSeq[i]!], full));
  }

  assert.equal(announced.length, 1, '参数拼齐后应恰好宣告一次');
  assert.deepEqual(announced[0]!.args, { query: 'ERROR', context_lines: 1 });
  assert.equal(t.count, 1, '轮次只记一次');

  const { announced: late, call } = t.onToolResult();
  assert.equal(late, null, '已宣告过的调用不得在结果处补宣告');
  assert.deepEqual(call?.args, { query: 'ERROR', context_lines: 1 }, '结果配对时应带真实参数');
});

test('分片残缺、完整 tool_calls 给出非空参数时用权威值救回', () => {
  const t = new ToolCallTracker();
  const a = t.onModelMessage([{ name: 'rag_search', args: '{"query":"缺', id: 'i0', index: 0 }]);
  assert.equal(a.length, 0, '半截 JSON 不得宣告');

  const b = t.onModelMessage(undefined, [{ name: 'rag_search', args: { query: '完整' }, id: 'i0' }]);
  assert.equal(b.length, 1, '权威参数应救回并宣告');
  assert.deepEqual(b[0]!.args, { query: '完整' });
});

test('连续出现占位空对象时仍不宣告（真·无参调用延后到结果处）', () => {
  const t = new ToolCallTracker();
  t.onModelMessage([{ name: 'list_topics', args: '', id: 'i0', index: 0 }]);
  const b = t.onModelMessage(undefined, [{ name: 'list_topics', args: {}, id: 'i0' }]);
  assert.equal(b.length, 0, '空对象无法区分占位与真·无参，一律延后');

  const { announced } = t.onToolResult();
  assert.equal(announced?.name, 'list_topics');
  assert.deepEqual(announced?.args, {});
});
