/**
 * 回归样本守门测试。
 *
 * ## 这份 fixture 之前是「空壳」
 *
 * `tests/fixtures/regression/cases.json` 里 12 条样本的 `expect` 全是
 * `{category:"", keywords:[], notes:"待人工复核…"}`，而且**没有任何测试读它**。
 * 也就是说它既不守门、也不会因为被写坏而报错——唯一的保护是「有人记得复核」。
 * 本测试把这份承诺变成机器可验证的约定：
 *
 *  1. **结构完整**：分类必须在词汇表内、keywords/notes 不得为空。
 *     空壳状态从此无法再通过测试。
 *  2. **证据可达（本测试的核心价值）**：每条样本的诊断依据标识，必须能在
 *     `buildLogWindow()` 产出的**日志窗口**里找到。
 *
 * 第 2 条为什么重要：日志正文是先经过窗口化（12KB 聚焦窗口）才发给模型的。
 * 若窗口化把崩溃现场切掉了，模型再怎么努力也答不对——而这类回归在
 * 「日志很短所以一切正常」的单测里永远暴露不出来。这里用真实的生产样本
 * （其中多条 excerpt 达 23KB 以上，必须走定位逻辑）把这条链路钉住。
 *
 * 本测试**不调用模型**，因此是确定性的、可在 CI 跑的。判断答案措辞、
 * 防幻觉（如 `9BBGhCT` 那条「信息不足」样本）属于现场评审，见 `REVIEW.md`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildLogWindow } from '../src/text/window.ts';

interface CaseExpect {
  category: string;
  keywords: string[];
  evidence: string[];
  must_not_contain: string[];
  notes: string;
}

interface Case {
  id: string;
  tier: 'low' | 'high';
  score: number;
  rounds: number;
  toolCallsCount: number;
  signals: Record<string, string[]>;
  rootCause: string;
  excerpt: string;
  expect: CaseExpect;
}

interface Fixture {
  cases: Case[];
  category_vocabulary?: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/regression/cases.json', import.meta.url), 'utf8'),
) as Fixture;

test('样本集：12 条，低分 6 条 / 高分 6 条', () => {
  assert.equal(fixture.cases.length, 12, '样本集规模变化需同步更新 REVIEW.md');
  assert.equal(fixture.cases.filter((c) => c.tier === 'low').length, 6);
  assert.equal(fixture.cases.filter((c) => c.tier === 'high').length, 6);
});

test('结构完整性：没有「待复核」的空壳', () => {
  for (const c of fixture.cases) {
    assert.ok(c.expect.category !== '', `${c.id} 的 category 为空（即未复核）`);
    assert.ok(
      c.expect.notes !== '' && !c.expect.notes.includes('待人工复核'),
      `${c.id} 的 notes 仍是占位文字`,
    );
    assert.ok(c.expect.keywords.length > 0, `${c.id} 的 keywords 为空`);
  }
});

test('分类取值受词汇表约束（避免同义分类各写各的）', () => {
  const used = new Set(fixture.cases.map((c) => c.expect.category));
  const declared = new Set(fixture.category_vocabulary ?? []);
  assert.ok(declared.size > 0, 'fixture 应声明 category_vocabulary');
  for (const c of used) {
    assert.ok(declared.has(c), `分类 ${c} 不在词汇表内`);
  }
  assert.deepEqual([...used].sort(), [...declared].sort(), '词汇表应与实际使用一致');
});

test('关键词与反例不得重叠（自相矛盾的期望值）', () => {
  for (const c of fixture.cases) {
    for (const bad of c.expect.must_not_contain) {
      assert.ok(
        !c.expect.keywords.includes(bad),
        `${c.id}：${bad} 同时出现在 keywords 与 must_not_contain`,
      );
    }
  }
});

/**
 * 核心守门：诊断依据必须能在日志窗口里找到。
 *
 * 失败通常意味着两种问题之一：
 *  - `window.ts` 的锚点定位/窗口切分退化了（切掉了崩溃现场）→ 真回归；
 *  - 样本的 `evidence` 写错了（标识并未出现在日志里）→ fixture 本身有误。
 * 两者都需要立刻处理，因此这里不做「跳过」处理。
 */
test('诊断依据在日志窗口里可达（窗口化不得切掉证据）', () => {
  const checked: string[] = [];

  for (const c of fixture.cases) {
    if (c.expect.evidence.length === 0) continue;

    const win = buildLogWindow(c.excerpt);
    assert.equal(win.hasWindow, true, `${c.id}：窗口化失败，没有可用的日志正文`);

    // 大小写不敏感：java 异常类名与模组 id 在日志中的大小写写法并不统一
    const haystack = win.body.toLowerCase();
    for (const needle of c.expect.evidence) {
      assert.ok(
        haystack.includes(needle.toLowerCase()),
        `${c.id}：诊断依据「${needle}」不在日志窗口内` +
          `（窗口为第 ${win.startLine}-${win.endLine} 行，锚点 ${win.anchorLine ?? '无'}，` +
          `来源 ${win.matchedBy ?? '无'}）——窗口化可能切掉了崩溃现场`,
      );
    }
    checked.push(c.id);
  }

  assert.ok(checked.length >= 10, `只有 ${checked.length} 条样本参与校验，覆盖不足`);
});

test('长日志样本必须走定位逻辑（否则本测试失去意义）', () => {
  // 若这些样本短于窗口上限，本文件就退化成「字符串包含」测试，
  // 无法再守住窗口化回归。用断言把「样本具备足够长度」固定下来。
  const long = fixture.cases.filter((c) => Buffer.byteLength(c.excerpt, 'utf8') > 12_000);
  assert.ok(
    long.length >= 9,
    `只有 ${long.length} 条样本长于窗口上限（12000 字节），窗口化回归已失去覆盖`,
  );

  for (const c of long) {
    if (c.expect.evidence.length === 0) continue;
    const win = buildLogWindow(c.excerpt);
    assert.notEqual(
      win.anchorLine,
      null,
      `${c.id}：长日志应能定位到崩溃锚点，否则窗口退化为概况+检索指引`,
    );
  }
});

test('高分样本：确实产出过结论（防「把空答案当高分」）', () => {
  for (const c of fixture.cases.filter((x) => x.tier === 'high')) {
    assert.ok(c.rootCause.length > 0, `${c.id} 属高分样本，应有归档结论`);
    assert.ok(c.score >= 90, `${c.id} 应属于高分区间`);
  }
});

test('低分样本：归档结论为空（即旧系统确实没答出来）', () => {
  // 这条守的是「低分=真缺陷」这一前提。若某条低分样本其实有完整结论，
  // 那它的低分更可能是旧评分器的误判，需要重新归类而不是当缺陷样本用。
  for (const c of fixture.cases.filter((x) => x.tier === 'low')) {
    assert.equal(
      c.rootCause,
      '',
      `${c.id} 低分但存在归档结论，应复核是评分误判而非缺陷（见 REVIEW.md）`,
    );
  }
});
