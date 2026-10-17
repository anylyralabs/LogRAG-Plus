/**
 * 评分器与证据锚点测试。
 *
 * ## 本文件守的核心回归
 *
 * 生产评分体系把「调用过几次工具」当成「证据是否充分」，导致
 * **253 条结论完整、答案正确的分析（0 次工具调用）全部得 68 分**，
 * 而同质量的 1–3 次工具调用版本均值 93.3。
 *
 * 因此这里的第一条测试是**硬性回归**：
 * 一份未调用任何工具、但结论准确引用了日志原文的分析，必须拿到 85 分以上。
 * 如果这条测试挂了，说明评分器又退回了「按行为打分」的老路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractAnchors, verifyAnchors } = await import('../src/eval/anchors.ts');
const { scoreAnalysis, buildScoreFeedback } = await import('../src/eval/scorer.ts');
const { extractConclusion } = await import('../src/agent/structured.ts');

/** 一段真实形态的 Fabric 启动失败日志 */
const LOG_TEXT = `
[12:00:01] [main/INFO]: Loading Minecraft 26.2 with Fabric Loader 0.19.3
[12:00:02] [main/ERROR]: Mod resolution encountered an incompatible mod set!
 - Mod 'Fabric Language Kotlin' (fabric-language-kotlin) 1.14.1+kotlin.2.4.20 requires fabricloader 0.19.5 or later, but only 0.19.3 is present.
 - Mod 'Sodium' (sodium) 0.8.15-beta.1+mc1.21.11 is incompatible with iris 1.10.7+mc1.21.11
[12:00:02] [main/ERROR]: HARD_DEP_NO_CANDIDATE fabric-language-kotlin
java.lang.RuntimeException: Could not execute entrypoint stage 'main'
`;

/** 结论准确、未使用工具的分析（对照生产 68 分样本） */
function zeroToolAccurate() {
  const answer = `## 根因分析
Fabric Loader 版本过低：实例使用 \`Fabric Loader 0.19.3\`，但模组 \`fabric-language-kotlin\` 1.14.1+kotlin.2.4.20 要求 \`fabricloader 0.19.5\` 或更高，因此模组解析阶段以 HARD_DEP_NO_CANDIDATE 中止。

\`\`\`json
{
  "rootCause": "Fabric Loader 0.19.3 低于 fabric-language-kotlin 1.14.1 要求的 0.19.5，模组解析阶段硬性中止",
  "confidence": 0.95,
  "evidence": [
    "日志首行显示 Loading Minecraft 26.2 with Fabric Loader 0.19.3",
    "报错行：fabric-language-kotlin 1.14.1+kotlin.2.4.20 requires fabricloader 0.19.5 or later, but only 0.19.3 is present",
    "HARD_DEP_NO_CANDIDATE fabric-language-kotlin"
  ],
  "steps": [
    "打开启动器的模组管理，删除 fabric-language-kotlin 1.14.1+kotlin.2.4.20",
    "下载并安装 fabric-language-kotlin 1.13.0 版本（兼容 Fabric Loader 0.19.3）",
    "重新启动游戏确认报错消失"
  ]
}
\`\`\``;

  return {
    answer,
    conclusion: extractConclusion(answer),
    logText: LOG_TEXT,
    toolCalls: [],
    rounds: 1,
  };
}

// ── 一、硬性回归：不因「没用工具」而扣分 ─────────────────

test('回归：0 次工具调用但引用准确 → 证据分与总分都很高（生产体系给 68）', () => {
  const r = scoreAnalysis(zeroToolAccurate());

  const grounding = r.dimensions.grounding.score;
  assert.ok(grounding !== null && grounding >= 80, `证据落地性应 ≥80，实际 ${grounding}`);

  assert.ok(r.overall >= 85, `总分应 ≥85（生产体系给 68），实际 ${r.overall}`);
  assert.equal(r.dimensions.economy.score, 100, '零调用必须是中性满分');
  assert.equal(r.deliverable, true);
});

test('回归：零调用时明确说明「不因未调用工具而扣分」', () => {
  const r = scoreAnalysis(zeroToolAccurate());
  assert.match(r.dimensions.economy.notes.join('\n'), /不因未调用工具而扣分/);
  assert.match(r.dimensions.grounding.notes.join('\n'), /不因未调用工具而扣分/);
});

// ── 二、证据落地性真的在看文本 ────────────────────────────

test('证据：引用日志里不存在的标识 → 证据分被扣（不会被工具次数蒙混）', () => {
  const base = zeroToolAccurate();
  const answer = base.answer.replace(
    '"rootCause": "',
    '"rootCause": "模组 fancylib-9.9.9.jar 与 NeoForge 88.8.8 冲突，报错 NoSuchFieldError com.example.Fake。',
  );

  const r = scoreAnalysis({
    ...base,
    answer,
    conclusion: extractConclusion(answer),
    // 加了一堆工具调用，也救不回来——证据分只看文本
    toolCalls: [
      { round: 1, name: 'grep_log_file', args: { query: 'x' }, result: 'x'.repeat(500), ok: true },
      { round: 2, name: 'rag_search', args: { query: 'y' }, result: 'y'.repeat(500), ok: true },
      { round: 3, name: 'grep_log_file', args: { query: 'z' }, result: 'z'.repeat(500), ok: true },
    ],
    rounds: 3,
  });

  assert.ok(r.dimensions.grounding.score !== null);
  assert.ok(
    r.dimensions.grounding.score < 80,
    `臆造的引用应拉低证据分，实际 ${r.dimensions.grounding.score}`,
  );
  assert.ok(r.groundingDetail.anchors.missing.length > 0, '应记录未命中的锚点');
});

test('证据：全是叙述性断言、没有任何具体标识 → 证据分为 0', () => {
  const answer = `## 分析
这应该是模组之间不兼容导致的问题，建议检查一下依赖关系。

\`\`\`json
{"rootCause":"模组之间不兼容","confidence":0.5,"evidence":["大概是有模组冲突"],"steps":["检查依赖"]}
\`\`\``;

  const r = scoreAnalysis({
    answer,
    conclusion: extractConclusion(answer),
    logText: LOG_TEXT,
    toolCalls: [],
    rounds: 1,
  });

  assert.equal(r.dimensions.grounding.score, 0, '无锚点断言按 0 分计入');
  assert.equal(r.deliverable, false);
});

test('证据：没有日志也没有工具返回 → 该维度不适用（null），不拖总分', () => {
  const answer = `你问的是启动器怎么选 Java 版本。一般建议与游戏版本对应。

\`\`\`json
{"rootCause":"Java 版本需与游戏版本匹配","confidence":0.8,"evidence":[],"steps":["在启动器设置里选择 Java 17"]}
\`\`\``;

  const r = scoreAnalysis({
    answer,
    conclusion: extractConclusion(answer),
    logText: null,
    toolCalls: [],
    rounds: 1,
  });

  assert.equal(r.dimensions.grounding.score, null, '无语料时证据维度必须不适用');
  assert.ok(r.overall > 0);
  assert.match(r.dimensions.grounding.notes.join('\n'), /不参与评分/);
});

test('证据：锚点提取能识别反引号、异常类名、文件名、版本号、常量', () => {
  const anchors = extractAnchors(
    '见 `Fabric Loader 0.19.5`，抛出 NoSuchMethodError，文件 sodium-fabric-0.6.0.jar，版本 1.21.1，常量 HARD_DEP_NO_CANDIDATE',
  );
  const keys = anchors.map((a) => a.key);

  assert.ok(keys.includes('nosuchmethoderror'), '应识别异常类名');
  assert.ok(keys.includes('sodium-fabric-0.6.0.jar'), '应识别文件名');
  assert.ok(keys.includes('1.21.1'), '应识别版本号');
  assert.ok(keys.includes('hard_dep_no_candidate'), '应识别常量');
  assert.ok(anchors.some((a) => a.kind === 'quoted'), '反引号内容应被识别');
});

test('证据：过于通用的标识被排除（否则「java.lang.Exception」永远命中）', () => {
  const anchors = extractAnchors('java.lang.Exception 与 minecraft、mods、config 都出现了');
  const keys = anchors.map((a) => a.key);
  assert.ok(!keys.includes('java.lang'), 'java.lang 过于通用，不能算证据');
  assert.ok(!keys.includes('minecraft'));
  assert.ok(!keys.includes('mods'));
});

test('证据：verifyAnchors 对空语料给出 recall=0（有锚点但一个都没找到）', () => {
  const anchors = extractAnchors('报错 NoSuchMethodError 见 sodium-fabric-0.6.0.jar');
  const v = verifyAnchors(anchors, '');
  assert.equal(v.found, 0);
  assert.equal(v.recall, 0);
});

// ── 三、工具经济性：区分探索与打转 ───────────────────────

test('效率：完全相同参数的重复调用被扣分（确证的浪费）', () => {
  const base = zeroToolAccurate();
  const dup = { name: 'grep_log_file', args: { query: 'sodium' }, result: 'a'.repeat(200), ok: true };

  const r = scoreAnalysis({
    ...base,
    toolCalls: [
      { round: 1, ...dup },
      { round: 2, ...dup },
      { round: 3, ...dup },
    ],
    rounds: 3,
  });

  assert.ok(r.dimensions.economy.score !== null && r.dimensions.economy.score <= 50);
  assert.match(r.dimensions.economy.notes.join('\n'), /重复调用/);
});

test('效率：多数调用毫无命中 → 判定为方向性错误', () => {
  const base = zeroToolAccurate();
  const empty = (n: number) => ({
    round: n,
    name: 'grep_log_file',
    args: { query: `word${n}` },
    result: '未找到匹配的行',
    ok: true,
  });

  const r = scoreAnalysis({
    ...base,
    toolCalls: [empty(1), empty(2), empty(3), empty(4)],
    rounds: 4,
  });

  assert.ok(r.dimensions.economy.score !== null && r.dimensions.economy.score < 100);
  assert.match(r.dimensions.economy.notes.join('\n'), /检索方向/);
});

test('效率：一两次无命中的探索不被重罚（那是正常试错）', () => {
  const base = zeroToolAccurate();
  const r = scoreAnalysis({
    ...base,
    toolCalls: [
      { round: 1, name: 'grep_log_file', args: { query: 'a' }, result: '未找到匹配的行', ok: true },
      { round: 2, name: 'grep_log_file', args: { query: 'b' }, result: '日志第 2 行命中 sodium'.repeat(5), ok: true },
    ],
    rounds: 2,
  });

  assert.equal(r.dimensions.economy.score, 100, '少量试错不应扣分');
});

// ── 四、可操作性 ─────────────────────────────────────────

test('可操作性：有具体对象与动作的步骤得分高，纯描述得分低', () => {
  const withSteps = zeroToolAccurate();
  const high = scoreAnalysis(withSteps);

  const vagueAnswer = `## 结论
应该是模组冲突。

\`\`\`json
{"rootCause":"模组冲突","confidence":0.4,"evidence":[],"steps":["检查一下模组"]}
\`\`\``;

  const low = scoreAnalysis({
    answer: vagueAnswer,
    conclusion: extractConclusion(vagueAnswer),
    logText: LOG_TEXT,
    toolCalls: [],
    rounds: 1,
  });

  assert.ok(
    (high.dimensions.actionability.score ?? 0) > (low.dimensions.actionability.score ?? 0),
    '具体步骤应显著高于「检查一下模组」',
  );
  assert.match(low.dimensions.actionability.notes.join('\n'), /没有给出任何解决步骤|停留在描述问题/);
});

// ── 五、声明可核实性：奖励诚实 ────────────────────────────

test('可核实性：置信度给满但证据为 0 → 扣分（断言与支撑不自洽）', () => {
  const answer = `\`\`\`json
{"rootCause":"内存不足","confidence":1.0,"evidence":[],"steps":["调大内存"]}
\`\`\``;
  const r = scoreAnalysis({
    answer,
    conclusion: extractConclusion(answer),
    logText: LOG_TEXT,
    toolCalls: [],
    rounds: 1,
  });
  assert.match(r.dimensions.verification.notes.join('\n'), /不自洽/);
  assert.ok((r.dimensions.verification.score ?? 100) < 80);
});

test('可核实性：显式标注不确定 → 记为期望行为而非缺陷', () => {
  const answer = `\`\`\`json
{"rootCause":"可能是渲染器问题，尚未确认","confidence":0.6,"evidence":["日志显示 GL_FRAMEBUFFER_UNSUPPORTED"],"steps":["切换到 GL4ES 渲染器"]}
\`\`\``;
  const r = scoreAnalysis({
    answer: `根据日志，可能是渲染器问题，尚需确认。\n${answer}`,
    conclusion: extractConclusion(answer),
    logText: `${LOG_TEXT}\nGL_FRAMEBUFFER_UNSUPPORTED`,
    toolCalls: [],
    rounds: 1,
  });
  assert.match(r.dimensions.verification.notes.join('\n'), /显式标注/);
});

test('可核实性：结构化结论提取失败 → 低分并说明前台无法渲染', () => {
  const r = scoreAnalysis({
    answer: '这是一段没有任何 JSON 块的普通回答。',
    conclusion: extractConclusion('这是一段没有任何 JSON 块的普通回答。'),
    logText: LOG_TEXT,
    toolCalls: [],
    rounds: 1,
  });
  assert.ok((r.dimensions.verification.score ?? 100) <= 30);
  assert.match(r.dimensions.verification.notes.join('\n'), /未能提取结构化结论/);
});

// ── 六、反馈生成 ─────────────────────────────────────────

test('反馈：低证据分时给出「哪些引用没找到」的定向提示', () => {
  const base = zeroToolAccurate();
  const answer = base.answer.replace('"evidence": [', '"evidence": ["见 NoSuchFieldError com.fake.Missing，文件 ghost-1.2.3.jar", "');
  const r = scoreAnalysis({
    ...base,
    answer,
    conclusion: extractConclusion(answer),
  });

  const feedback = buildScoreFeedback(r);
  assert.match(feedback, /自评/);
  assert.ok(feedback.length > 20);
});
