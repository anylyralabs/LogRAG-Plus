<script setup lang="ts">
/**
 * 自检面板。
 *
 * ## 视觉权重刻意压低
 * 它是**复核者**才需要的信息，不是给玩家的结论。之前用带边框的整块 + 徽章 +
 * 四维条形，视觉重量与「处置」步骤相当，读者会误以为它和结论同等重要。
 *
 * 现在：一行 10.5px 的浅灰文字 + 极小的分数，无边框、无徽章、默认收起。
 * 需要看时点开，展开后仍保留四维条形与未命中锚点——信息不减，只是不抢戏。
 */
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import type { ScorePayload } from '@/lib/types'

const props = defineProps<{ score: ScorePayload; canLocate?: boolean }>()
const emit = defineEmits<{ locate: [text: string] }>()

const open = ref(false)

interface Dimension {
  key: string
  label: string
  hint: string
  value: number | null
}

const dimensions = computed<Dimension[]>(() => [
  {
    key: 'grounding',
    label: '证据',
    hint: '结论里的引用能否在日志/检索结果中核对到',
    value: props.score.dimensions.grounding,
  },
  {
    key: 'verification',
    label: '核实',
    hint: '是否说明了核实动作与未核实项',
    value: props.score.dimensions.verification,
  },
  {
    key: 'actionability',
    label: '可行',
    hint: '用户能否照着操作',
    value: props.score.dimensions.actionability,
  },
  {
    key: 'economy',
    label: '效率',
    hint: '是否有空检索与重复检索',
    value: props.score.dimensions.economy,
  },
])

const tone = computed(() => {
  if (props.score.deliverable) return 'ok'
  return props.score.overall >= 70 ? 'warn' : 'danger'
})

function barColor(value: number | null): string {
  if (value === null) return 'var(--rule-strong)'
  if (value >= 80) return 'var(--ok)'
  if (value >= 60) return 'var(--warn)'
  return 'var(--danger)'
}
</script>

<template>
  <div class="score">
    <button type="button" class="score__toggle" :aria-expanded="open" @click="open = !open">
      <ChevronDown v-if="open" :size="11" aria-hidden="true" />
      <ChevronRight v-else :size="11" aria-hidden="true" />
      <span class="score__label">自检</span>
      <span class="num score__overall" :class="`score__overall--${tone}`">{{ score.overall }}</span>
      <span class="score__verdict">{{ score.deliverable ? '可交付' : '需复核' }}</span>
    </button>

    <div v-if="open" class="score__body">
      <div class="dims">
        <div v-for="dim in dimensions" :key="dim.key" class="dim">
          <div class="dim__head">
            <span class="dim__label">{{ dim.label }}</span>
            <span class="num dim__value">{{ dim.value === null ? '—' : dim.value }}</span>
          </div>
          <div class="dim__bar" :title="dim.hint">
            <div
              class="dim__fill"
              :style="{
                width: dim.value === null ? '0%' : `${Math.max(2, dim.value)}%`,
                background: barColor(dim.value),
              }"
            />
          </div>
          <p class="dim__hint">{{ dim.hint }}</p>
          <p v-if="dim.value === null" class="dim__na">本次没有可核实的语料，不参与评分</p>
        </div>
      </div>

      <div v-if="score.deductions.length > 0" class="score__section">
        <div class="label">扣分理由</div>
        <ul class="deductions">
          <li v-for="(item, i) in score.deductions" :key="i">{{ item }}</li>
        </ul>
      </div>

      <div v-if="score.missingAnchors.length > 0" class="score__section">
        <div class="label">未在日志中核对到</div>
        <ul class="missing">
          <li v-for="(item, i) in score.missingAnchors" :key="i">
            <code>{{ item }}</code>
            <button
              v-if="canLocate === true"
              type="button"
              class="btn btn--ghost btn--sm"
              @click="emit('locate', item)"
            >
              试试定位
            </button>
          </li>
        </ul>
        <p class="field-help">
          这些是模型声称有依据、但系统在日志正文与工具结果里没有找到的条目。可以据此判断哪些结论需要人工确认。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 无边框、无底色、无徽章：只有一行小字。
 * 与「调查过程」那一行视觉同级，明显弱于结论与处置。
 */
.score {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.score__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  min-height: 22px;
  color: var(--ink-4);
  font-size: 10.5px;
  line-height: 1.4;
}

.score__toggle:hover {
  color: var(--ink-3);
}

.score__label {
  letter-spacing: 0.02em;
}

.score__overall {
  color: var(--ink-4);
  font-size: 10.5px;
}

/* 状态只用字色区分，不加底色与边框 */
.score__overall--ok {
  color: var(--ok);
}

.score__overall--warn {
  color: var(--warn);
}

.score__overall--danger {
  color: var(--danger);
}

.score__verdict {
  color: var(--ink-4);
}

.score__verdict::before {
  content: '·';
  margin-right: 4px;
  color: var(--rule-strong);
}

.score__body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-2) 0 var(--sp-1);
}

.dims {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: var(--sp-3);
}

.dim__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.dim__label {
  font-size: 10px;
  color: var(--ink-3);
}

.dim__value {
  font-size: 10px;
  color: var(--ink-4);
}

.dim__bar {
  height: 2px;
  margin: 4px 0;
  background: var(--paper-inset);
  overflow: hidden;
}

.dim__fill {
  height: 100%;
  transition: width 240ms var(--ease);
}

.dim__hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--ink-4);
}

.dim__na {
  margin-top: 2px;
  font-size: 10px;
  color: var(--warn);
}

.score__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 展开区里的栏目标记也降一档，避免小面板内部再出现强层级 */
.score__section :deep(.label) {
  font-size: 10px;
  line-height: 14px;
  color: var(--ink-4);
}

.deductions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 1.2em;
  list-style: disc;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  line-height: 1.65;
}

.missing {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.missing li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.missing code {
  padding: 2px 5px;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
