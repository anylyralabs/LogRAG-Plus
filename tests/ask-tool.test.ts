/**
 * 反问工具测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HIGH_VALUE_QUESTIONS, buildAskTool, describeHighValueQuestions } from '../src/agent/tools/ask.ts';

/** 调用工具的底层 run 方法（LangChain tool 的 invoke 需要 tool_call 结构） */
async function runAsk(
  ctx: { asked: string[] },
  args: { questions: string[]; reason?: string },
): Promise<string> {
  const t = buildAskTool(ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (t as any).invoke(args)) as string;
}

test('基本提问：返回可读的问题列表', async () => {
  const ctx = { asked: [] as string[] };
  const out = await runAsk(ctx, {
    questions: ['你的手机是什么型号？'],
    reason: '判断渲染器与 GPU 兼容性',
  });

  assert.ok(out.includes('你的手机是什么型号？'));
  assert.ok(out.includes('判断渲染器与 GPU 兼容性'));
  assert.equal(ctx.asked.length, 1, '应记录已问过的问题');
});

test('去重：同一问题不重复追问', async () => {
  const ctx = { asked: [] as string[] };
  await runAsk(ctx, { questions: ['你的手机是什么型号？'] });
  const second = await runAsk(ctx, { questions: ['你的手机是什么型号？'] });

  assert.ok(second.includes('此前已问过'), '重复提问应被拦截');
  assert.equal(ctx.asked.length, 1, '不应重复记录');
});

test('部分重复：只问新的', async () => {
  const ctx = { asked: [] as string[] };
  await runAsk(ctx, { questions: ['A 问题'] });
  const out = await runAsk(ctx, { questions: ['A 问题', 'B 问题'] });

  assert.ok(out.includes('B 问题'));
  assert.ok(!out.includes('A 问题：') && out.includes('已向用户提出 1 个问题'));
  assert.deepEqual(ctx.asked, ['A 问题', 'B 问题']);
});

test('数量上限：schema 层拒绝超过 3 个（校验前置）', async () => {
  const ctx = { asked: [] as string[] };
  const t = buildAskTool(ctx);

  // LangChain 的 zod schema 会在进入实现前校验，超限直接抛错
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => (t as any).invoke({ questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] }),
    (e: unknown) => e instanceof Error && /Too big|<=3/.test(e.message),
    'schema 应拦截超过 3 个问题',
  );
  assert.equal(ctx.asked.length, 0, '被拦截时不应记录');
});

test('恰好 3 个问题可通过', async () => {
  const ctx = { asked: [] as string[] };
  const out = await runAsk(ctx, { questions: ['Q1', 'Q2', 'Q3'] });
  assert.ok(out.includes('已向用户提出 3 个问题'));
  assert.equal(ctx.asked.length, 3);
});

test('追问不是推卸：提示应先给部分结论', async () => {
  const ctx = { asked: [] as string[] };
  const out = await runAsk(ctx, { questions: ['你的手机型号？'] });

  assert.ok(
    out.includes('不要说是「调用工具」'),
    '应告知模型这是面向用户的提问，而非工具调用',
  );
  assert.ok(out.includes('不要臆测'));
});

test('空问题列表被拒绝', async () => {
  const ctx = { asked: [] as string[] };
  const out = await runAsk(ctx, { questions: ['   '] });
  assert.ok(out.includes('未提供有效问题'));
});

test('高价值追问清单覆盖实测发现的缺口', () => {
  const fields = HIGH_VALUE_QUESTIONS.map((q) => q.field).join('|');

  // 依据 27 份实测：这些信息缺失即无法判定，且通常不在日志里
  assert.ok(fields.includes('设备型号'), '应含设备型号（实测：麒麟 SoC 判定依赖它）');
  assert.ok(fields.includes('渲染器'), '应含渲染器（移动端崩溃首要原因）');
  assert.ok(fields.includes('Java'), '应含 Java 版本');
  assert.ok(fields.includes('模组列表'), '应含模组列表（实测：模型明说无法核实）');
  assert.ok(fields.includes('操作'), '应含崩溃前操作');
});

test('高价值清单的示例都是可回答的具体问题', () => {
  for (const q of HIGH_VALUE_QUESTIONS) {
    assert.ok(q.example.length > 5, `${q.field} 的示例应具体`);
    // 示例应含疑问标记或明确请求
    assert.ok(
      /[?？]|请|能/.test(q.example),
      `${q.field} 的示例应是提问式而非陈述式：${q.example}`,
    );
  }
});

test('describeHighValueQuestions 输出可读文本', () => {
  const text = describeHighValueQuestions();
  assert.ok(text.includes('设备型号'));
  assert.ok(text.includes('示例'));
});
