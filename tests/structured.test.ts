/**
 * 结构化输出提取测试。
 *
 * 测试用例来自生产实测的**真实失败样本**（logshare.cn 的 1572 条分析记录中
 * 有 12% 的 rootCause 为空）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractConclusion } from '../src/agent/structured.ts';

test('标准末尾代码块', () => {
  const answer = `## 结论

问题是模组缺失前置。

\`\`\`json
{"rootCause": "缺少 fabric-language-kotlin", "confidence": 0.9, "evidence": ["main:42"], "steps": ["装前置"]}
\`\`\``;

  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'trailing-code-block');
  assert.equal(r.rootCause, '缺少 fabric-language-kotlin');
  assert.equal(r.confidence, 0.9);
  assert.deepEqual(r.evidence, ['main:42']);
  assert.deepEqual(r.steps, ['装前置']);
});

test('无语言标记的代码块也能解析', () => {
  const answer = `结论如下。

\`\`\`
{"rootCause": "内存不足", "confidence": 0.8, "evidence": [], "steps": []}
\`\`\``;
  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.rootCause, '内存不足');
});

test('大写下标 JSON 标记', () => {
  const answer = 'text\n```JSON\n{"rootCause": "x"}\n```';
  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.rootCause, 'x');
});

test('尾随逗号容错', () => {
  const answer = 'text\n```json\n{"rootCause": "y", "evidence": ["a",], "steps": [],}\n```';
  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.rootCause, 'y');
  assert.deepEqual(r.evidence, ['a']);
});

test('JSON 内注释容错', () => {
  const answer = `text
\`\`\`json
{
  // 根因说明
  "rootCause": "z",
  /* 证据 */
  "evidence": ["e1"]
}
\`\`\``;
  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.rootCause, 'z');
});

test('字段名变体（root_cause / 根因）', () => {
  for (const key of ['root_cause', 'rootCause', 'rootcause', 'cause', '根因']) {
    const r = extractConclusion(`text\n\`\`\`json\n{"${key}": "变体测试"}\n\`\`\``);
    assert.equal(r.ok, true, `${key} 应被识别`);
    assert.equal(r.rootCause, '变体测试');
  }
});

test('confidence 为字符串时归一化', () => {
  const r = extractConclusion('```json\n{"rootCause":"x","confidence":"0.85"}\n```');
  assert.equal(r.confidence, 0.85);
});

test('confidence 越界时裁剪到 [0,1]', () => {
  const r1 = extractConclusion('```json\n{"rootCause":"x","confidence":1.5}\n```');
  assert.equal(r1.confidence, 1);
  const r2 = extractConclusion('```json\n{"rootCause":"x","confidence":-0.3}\n```');
  assert.equal(r2.confidence, 0);
});

test('step 单数字段名', () => {
  const r = extractConclusion('```json\n{"rootCause":"x","step":"只做一件事"}\n```');
  assert.deepEqual(r.steps, ['只做一件事']);
});

test('裸 JSON（模型未加代码块）', () => {
  const answer = `分析结果如下：

{"rootCause": "裸 JSON 测试", "confidence": 0.7, "evidence": [], "steps": []}`;
  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'raw-json');
  assert.equal(r.rootCause, '裸 JSON 测试');
});

test('代码块被内嵌 ``` 截断时仍能提取', () => {
  // 证据里含 ``` 会导致朴素正则提前结束
  const answer = `text
\`\`\`json
{"rootCause": "截断测试", "evidence": ["代码 \`\`\` 片段"]}
\`\`\``;
  const r = extractConclusion(answer);
  // 无论走哪个策略，rootCause 都应拿到
  assert.equal(r.rootCause, '截断测试');
});

test('取最后一个代码块（前面还有示例块）', () => {
  const answer = `示例：
\`\`\`json
{"rootCause": "这是示例不该选"}
\`\`\`

实际结论：
\`\`\`json
{"rootCause": "这才是结论"}
\`\`\``;
  const r = extractConclusion(answer);
  assert.equal(r.rootCause, '这才是结论');
});

test('无 rootCause 视为提取失败（但可降级）', () => {
  const r = extractConclusion('text\n```json\n{"evidence": ["x"]}\n```');
  // 缺关键字段 → 不应当作成功
  assert.equal(r.ok, false);
  // 但降级策略会从正文取一段，避免前端空白
  assert.ok(r.rootCause.length > 0);
  assert.equal(r.strategy, 'degraded-from-text');
});

test('完全无 JSON 时降级为正文推断', () => {
  // 生产样本 EX8k9og 的形态：答案完整但无 JSON 块
  const answer = `## 排障结论

### 崩溃现象
游戏在启动阶段、加载原生库的第一步（SDL）即崩溃，退出码 -3。`;

  const r = extractConclusion(answer);
  assert.equal(r.ok, false, '无 JSON 块不算成功提取');
  assert.equal(r.strategy, 'degraded-from-text');
  assert.ok(r.rootCause.includes('游戏在启动阶段'), '降级应从正文取到根因');
  assert.ok(r.error?.includes('未输出结构化 JSON'));
});

test('降级优先取叙述性正文（跳过标题与纯列表段）', () => {
  const answer = `# 标题

- 列表项一
- 列表项二

这是真正的第一段正文内容，应当被取作根因。`;

  const r = extractConclusion(answer);
  assert.equal(r.strategy, 'degraded-from-text');
  // 设计意图：列表项是碎片，叙述段才是根因表达
  assert.ok(
    r.rootCause.startsWith('这是真正的第一段正文内容'),
    `应取叙述性段落，实际取到：${r.rootCause}`,
  );
});

test('降级：纯列表无叙述段时取列表首项', () => {
  const answer = `- 唯一内容项`;
  const r = extractConclusion(answer);
  assert.equal(r.strategy, 'degraded-from-text');
  assert.equal(r.rootCause, '唯一内容项');
});

test('空答复', () => {
  const r = extractConclusion('');
  assert.equal(r.ok, false);
  assert.equal(r.error, '答复为空');
});

test('纯空白答复', () => {
  const r = extractConclusion('   \n\n  ');
  assert.equal(r.ok, false);
});

test('JSON 数组不算结论', () => {
  const r = extractConclusion('```json\n["a","b"]\n```');
  assert.equal(r.ok, false);
});

test('非法 JSON 不崩溃', () => {
  const r = extractConclusion('```json\n{rootCause: 无引号}\n```');
  assert.equal(r.ok, false);
});

test('生产样本 KUetpQq 形态：框架消息 + 正常结论', () => {
  // 该样本的答案含框架泄漏消息（另见 sanitize 测试）
  const answer = `我需要先查看日志后半部分，确认真正的错误在哪里。

[system: empty tool message processed, continue]

\`\`\`json
{"rootCause": "JVM 原生层 SIGSEGV，崩溃点在 libinstrument.so", "confidence": 0.85, "evidence": ["hs_err:42"], "steps": ["更换 Java 运行时"]}
\`\`\``;

  const r = extractConclusion(answer);
  assert.equal(r.ok, true);
  assert.ok(r.rootCause.includes('SIGSEGV'));
});
