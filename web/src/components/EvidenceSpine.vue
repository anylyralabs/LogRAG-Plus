<script setup lang="ts">
/**
 * 结论脊柱 —— 把「判定 / 处置 / 依据」画成一条有节点的竖线。
 *
 * ## 为什么不是一张卡片
 *
 * 上一版把结论做成一张圆角卡片，问题是卡片和其它任何东西都长得一样：它没有
 * 表达「判定是结论、步骤是动作、依据是支撑」这三者的关系。这里用一条连续的
 * 竖线把三者串起来——**判定在上，处置居中，依据在其后并可折叠**，
 * 节点的大小与字级不同，读者不用读字也知道谁是主、谁是附。
 *
 * ## 顺序为什么是「判定 → 处置 → 依据」而不是「依据在前」
 *
 * 玩家要的是先知道「该做什么」。依据放在后面、默认折叠，是为了不挡路；
 * 要核实的人点一下就在。正文里本来就有推理过程，依据块再抄一遍没有意义。
 *
 * ## 置信度为什么既给「高/中/低」又给数字
 *
 * 「中」是人能用的信息，「0.72」是能核对的信息。只给前者显得像拍脑袋，
 * 只给后者要求读者把小数换算成态度。两个都给，成本是一条 mono 文本。
 */

import { computed, ref } from 'vue';
import type { Conclusion } from '../api/types.ts';
import Icon from './Icon.vue';

const props = defineProps<{
  conclusion: Conclusion | null;
}>();

const openEvidence = ref(false);

const rootCause = computed(() => {
  const v = props.conclusion?.['rootCause'];
  return typeof v === 'string' ? v.trim() : '';
});

/**
 * 置信度容错：规范写的是 0–1 的数，但模型偶尔给字符串（「高」/「75%」）。
 * 容错放在展示层——放进数据契约会让契约慢慢退化成 any。
 */
const confidence = computed(() => {
  // 显式标成 unknown：契约里它是 number，但运行时可能来字符串；
  // 若按契约类型收窄，下面那个 `typeof v === 'string'` 分支会被推成 never。
  const v: unknown = props.conclusion?.['confidence'];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1.5 ? v / 100 : v; // 有的模型给 75 而不是 0.75
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^(高|high)/i.test(t)) return 0.85;
    if (/^(中|medium|moderate)/i.test(t)) return 0.6;
    if (/^(低|low)/i.test(t)) return 0.3;
    const n = Number.parseFloat(t.replace('%', ''));
    if (Number.isFinite(n)) return n > 1.5 ? n / 100 : n;
  }
  return null;
});

const level = computed(() => {
  const c = confidence.value;
  if (c === null) return null;
  if (c >= 0.75) return '高';
  if (c >= 0.5) return '中';
  return '低';
});

const steps = computed(() => {
  const v = props.conclusion?.['steps'];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
});

const evidence = computed(() => {
  const v = props.conclusion?.['evidence'];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
});

const empty = computed(() => rootCause.value === '' && steps.value.length === 0 && evidence.value.length === 0);
</script>

<template>
  <section v-if="!empty" class="spine" aria-label="分析结论">
    <!-- 判定 -->
    <div class="node node--verdict">
      <div class="node__head">
        <span class="node__kind mono">判定</span>
        <span v-if="level !== null" class="conf" :title="`置信度 ${confidence?.toFixed(2)}`">
          <span class="conf__bar" aria-hidden="true">
            <i :style="{ width: `${Math.round((confidence ?? 0) * 100)}%` }" />
          </span>
          <span class="mono conf__text">{{ level }} · {{ (confidence ?? 0).toFixed(2) }}</span>
        </span>
      </div>
      <p class="verdict">{{ rootCause }}</p>
    </div>

    <!-- 处置：这里是真正的序列，编号是有信息的（先做哪一步） -->
    <div v-if="steps.length > 0" class="node">
      <div class="node__head">
        <span class="node__kind mono">处置</span>
        <span class="meta">{{ steps.length }} 步</span>
      </div>
      <ol class="steps">
        <li v-for="(s, i) in steps" :key="i" class="steps__item">
          <span class="steps__no mono">{{ i + 1 }}</span>
          <span class="steps__text">{{ s }}</span>
        </li>
      </ol>
    </div>

    <!-- 依据：默认折叠，不挡路；要核实的人点开就在 -->
    <div v-if="evidence.length > 0" class="node">
      <button class="node__head node__head--btn" type="button" @click="openEvidence = !openEvidence">
        <span class="node__kind mono">依据</span>
        <span class="meta">{{ evidence.length }} 条</span>
        <Icon :name="openEvidence ? 'chevronUp' : 'chevronDown'" :size="14" class="node__chev" />
      </button>
      <ul v-if="openEvidence" class="evi">
        <li v-for="(e, i) in evidence" :key="i" class="evi__item">
          <Icon name="quote" :size="13" class="evi__icon" />
          <span class="evi__text">{{ e }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/**
 * 脊柱本体：一条 1px 竖线。节点用 `::before` 挂在线上，
 * 因此线的位置由 `--spine-x` 一处决定，加节点不用改线。
 */
.spine {
  --spine-x: 5px;
  position: relative;
  padding-left: var(--s5);
}

.spine::before {
  content: '';
  position: absolute;
  left: var(--spine-x);
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: var(--line-2);
}

.node {
  position: relative;
  padding: var(--s4) 0;
}

.node + .node {
  border-top: 1px solid var(--line);
}

.node::before {
  content: '';
  position: absolute;
  left: calc(var(--spine-x) - var(--s5) - 1px);
  top: calc(var(--s4) + 7px);
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  background: var(--line-3);
  box-shadow: 0 0 0 3px var(--bg);
}

/* 判定节点：实心强调色，它是这条线上唯一的「结论」 */
.node--verdict::before {
  background: var(--accent);
  width: 9px;
  height: 9px;
  top: calc(var(--s4) + 6px);
}

.node__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  text-align: left;
}

.node__head--btn {
  cursor: pointer;
}

.node__kind {
  font-size: var(--t-caption);
  color: var(--text-3);
  letter-spacing: 0.08em;
}

.node--verdict .node__kind {
  color: var(--accent);
}

.node__chev {
  margin-left: auto;
  color: var(--text-3);
}

.verdict {
  margin-top: var(--s2);
  font-size: var(--t-h5);
  line-height: 1.5;
  font-weight: 500;
  max-width: var(--measure);
}

/* 置信度：一条细槽 + 数字。不给颜色，避免与严重度色抢含义 */
.conf {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  margin-left: auto;
}

.conf__bar {
  display: inline-block;
  width: 44px;
  height: 3px;
  background: var(--line-2);
  border-radius: var(--r-pill);
  overflow: hidden;
}

.conf__bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}

.conf__text {
  font-size: var(--t-caption);
  color: var(--text-2);
}

.steps {
  list-style: none;
  margin-top: var(--s3);
}

.steps__item {
  display: flex;
  gap: var(--s3);
  padding: var(--s2) 0;
  max-width: var(--measure);
}

.steps__no {
  flex: none;
  width: 1.4em;
  text-align: right;
  font-size: var(--t-small);
  color: var(--accent);
  line-height: var(--lh-prose);
}

.steps__text {
  font-size: var(--t-body);
}

.evi {
  list-style: none;
  margin-top: var(--s3);
}

.evi__item {
  display: flex;
  gap: var(--s3);
  padding: var(--s2) 0;
  max-width: var(--measure);
}

.evi__icon {
  flex: none;
  margin-top: 5px;
  color: var(--text-3);
}

.evi__text {
  font-family: var(--font-log);
  font-size: var(--t-caption);
  line-height: 1.65;
  color: var(--text-2);
}
</style>
