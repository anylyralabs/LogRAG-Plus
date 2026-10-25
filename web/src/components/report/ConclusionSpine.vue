<script setup lang="ts">
/**
 * 结论：判定句 → 处置步骤 → 依据。
 *
 * ## 刻意不画标签
 * 早先有「判定 / 处置 / 依据」三个栏目标记 + 左侧一条脊柱竖线。问题是：
 * 用户先看到三行标签，才看到内容；一屏里标签与线条的数量超过实际结论。
 *
 * 现在靠**排版本身**表达层级：
 *  - 判定句用 19px / 500，是全页最大的字，不需要「判定」二字告诉读者这是判定；
 *  - 步骤是编号列表，序号已经说明这是序列；
 *  - 依据是一行可展开的小字。
 *
 * ## 依据默认收起
 * 玩家先要知道「该做什么」。依据是支撑，不是主角；但它必须**可核对**，
 * 所以保留「依据 N 处」入口，点开后每条都能回跳日志行。
 */
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, MapPin } from 'lucide-vue-next'
import { confidenceLabel, normalizeConfidence, normalizeList } from '@/lib/structured'
import type { Conclusion } from '@/lib/types'

const props = defineProps<{
  conclusion: Conclusion
  /** 未在日志里核对到的锚点（来自自评） */
  missingAnchors?: string[]
  /** 日志面板可回跳时显示「定位」 */
  canLocate?: boolean
}>()

const emit = defineEmits<{
  locate: [text: string]
}>()

const openEvidence = ref(false)

const rootCause = computed(() => {
  const v = props.conclusion.rootCause
  return typeof v === 'string' ? v.trim() : ''
})

const confidence = computed(() => normalizeConfidence(props.conclusion.confidence))
const confidenceText = computed(() => confidenceLabel(confidence.value))
const steps = computed(() => normalizeList(props.conclusion.steps))
const evidence = computed(() => normalizeList(props.conclusion.evidence))

const missing = computed(() => new Set(props.missingAnchors ?? []))

function isMissing(item: string): boolean {
  if (missing.value.size === 0) return false
  for (const anchor of missing.value) {
    if (anchor !== '' && item.includes(anchor)) return true
  }
  return false
}
</script>

<template>
  <section class="verdict">
    <!-- 判定：整页最大的字，不加标签 -->
    <div v-if="rootCause !== ''" class="verdict__head">
      <p class="verdict__root">{{ rootCause }}</p>
      <p v-if="confidenceText !== null" class="verdict__confidence">{{ confidenceText }}</p>
    </div>

    <!-- 处置：编号即序列，不需要「处置」标签 -->
    <ol v-if="steps.length > 0" class="steps">
      <li v-for="(step, i) in steps" :key="i" class="step">
        <span class="step__no num">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="step__text">{{ step }}</span>
      </li>
    </ol>

    <!-- 依据：一行入口，默认收起 -->
    <div v-if="evidence.length > 0" class="evidence">
      <button
        type="button"
        class="evidence__toggle"
        :aria-expanded="openEvidence"
        @click="openEvidence = !openEvidence"
      >
        <ChevronDown v-if="openEvidence" :size="12" aria-hidden="true" />
        <ChevronRight v-else :size="12" aria-hidden="true" />
        依据 {{ evidence.length }} 处
      </button>

      <ul v-if="openEvidence" class="evidence__list">
        <li
          v-for="(item, i) in evidence"
          :key="i"
          class="evidence__item"
          :class="{ 'evidence__item--missing': isMissing(item) }"
        >
          <code class="evidence__text">{{ item }}</code>
          <span v-if="isMissing(item)" class="evidence__missing">未核对到</span>
          <button
            v-else-if="canLocate === true"
            type="button"
            class="evidence__locate"
            :aria-label="`在日志中定位：${item}`"
            @click="emit('locate', item)"
          >
            <MapPin :size="11" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/*
 * 结论是正文的**收束**，不是另一段正文。
 *
 * 用一条极淡的上边距 + 稍大的间距把它从正文里「提出来」，
 * 但不加「结论」标签、不画框——加了标签就等于每段文字前都写一遍「以下是文字」。
 */
.verdict {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 6px;
  padding-top: 22px;
  border-top: 1px solid var(--rule-muted);
}

.verdict__head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/*
 * 判定句：19px / 500 / 行宽 26em。
 * 侧边不再画竖线——那会把结论区切成分栏块；这一句本身就是页面焦点。
 */
.verdict__root {
  max-width: 26em;
  margin: 0;
  font-size: 19px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: -0.01em;
  color: var(--ink);
}

/* 置信度：判定句的脚注，独立一行小字，不挤在句末 */
.verdict__confidence {
  margin: 0;
  color: var(--ink-4);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  counter-reset: none;
}

.step {
  display: grid;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
}

.step__no {
  color: var(--ink-4);
  font-size: var(--fs-micro);
  line-height: var(--lh-body);
}

.step__text {
  max-width: 32em;
  color: var(--ink);
  line-height: var(--lh-body);
}

.evidence {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.evidence__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  min-height: 22px;
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.evidence__toggle:hover {
  color: var(--ink-2);
}

.evidence__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.evidence__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-control);
  background: var(--paper-inset);
}

.evidence__item--missing {
  background: var(--warn-soft);
}

.evidence__text {
  flex: 1;
  color: var(--ink-2);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.evidence__missing {
  flex: none;
  color: var(--warn);
  font-size: 10.5px;
  white-space: nowrap;
}

.evidence__locate {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--ink-4);
}

.evidence__locate:hover {
  background: var(--paper-raised);
  color: var(--accent);
}

@media (max-width: 719px) {
  .verdict {
    gap: 14px;
  }

  .verdict__root {
    font-size: 17px;
    line-height: 1.55;
  }
}
</style>
