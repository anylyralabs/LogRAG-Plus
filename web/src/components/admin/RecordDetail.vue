<script setup lang="ts">
/**
 * 分析记录详情抽屉。
 *
 * 记录里没有完整答案（服务端刻意不存正文），因此这里展示的是**结构**：
 * 根因、分数、工具链、扣分与未命中锚点。想回看完整对话请用会话回放。
 */
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import ModalShell from '@/components/ui/ModalShell.vue'
import type { AnalysisRecord } from '@/lib/types'

const props = defineProps<{ record: AnalysisRecord | null }>()
const emit = defineEmits<{ close: [] }>()

const dimensions = computed(() => {
  const r = props.record
  if (r === null) return []
  return [
    { label: '证据', value: r.grounding, hint: '引用能否在日志中核对' },
    { label: '核实', value: r.verification, hint: '核实动作与未核实项标注' },
    { label: '可行', value: r.actionability, hint: '用户能否照做' },
    { label: '效率', value: r.economy, hint: '空检索与重复检索' },
  ]
})

const time = computed(() => {
  const r = props.record
  if (r === null) return ''
  return new Date(r.created * 1000).toLocaleString('zh-CN')
})

function tone(value: number | null): string {
  if (value === null) return 'var(--rule-strong)'
  if (value >= 80) return 'var(--ok)'
  if (value >= 60) return 'var(--warn)'
  return 'var(--danger)'
}
</script>

<template>
  <ModalShell
    :open="record !== null"
    variant="detail"
    title="分析记录详情"
    description="记录只保存结构，不含完整答案；回看原文请用会话回放。"
    @update:open="record !== null && emit('close')"
  >
    <div v-if="record !== null" class="detail__head">
      <code class="detail__id">{{ record.id }}</code>
      <button type="button" class="btn btn--ghost btn--icon btn--sm" aria-label="关闭" @click="emit('close')">
        <X :size="15" aria-hidden="true" />
      </button>
    </div>

    <div v-if="record !== null" class="detail__body">
      <div class="score-row">
        <span class="num detail__overall">{{ record.overall }}</span>
        <span class="badge" :class="record.deliverable ? 'badge--ok' : 'badge--warn'">
          {{ record.deliverable ? '可交付' : '需复核' }}
        </span>
        <span class="num detail__time">{{ time }}</span>
      </div>

      <div class="dims">
        <div v-for="dim in dimensions" :key="dim.label" class="dim">
          <div class="dim__head">
            <span>{{ dim.label }}</span>
            <span class="num">{{ dim.value ?? '—' }}</span>
          </div>
          <div class="dim__bar">
            <div
              class="dim__fill"
              :style="{
                width: dim.value === null ? '0%' : `${Math.max(2, dim.value)}%`,
                background: tone(dim.value),
              }"
            />
          </div>
          <p class="dim__hint">{{ dim.hint }}</p>
        </div>
      </div>

      <section class="block">
        <div class="label">根因</div>
        <p class="root">{{ record.rootCause === '' ? '（未提取到结构化根因）' : record.rootCause }}</p>
        <p v-if="record.confidence !== null" class="num confidence">置信度 {{ record.confidence }}</p>
      </section>

      <section class="block">
        <div class="label">规模</div>
        <dl class="facts">
          <div><dt>会话</dt><dd class="mono">{{ record.sessionId }}</dd></div>
          <div><dt>日志</dt><dd class="mono">{{ record.logId ?? '—' }}</dd></div>
          <div><dt>模型</dt><dd class="mono">{{ record.model }}</dd></div>
          <div><dt>轮次</dt><dd class="num">{{ record.rounds }}</dd></div>
          <div><dt>工具调用</dt><dd class="num">{{ record.toolCalls }}</dd></div>
          <div><dt>空结果</dt><dd class="num">{{ record.emptyCalls }}</dd></div>
          <div><dt>失败调用</dt><dd class="num">{{ record.failedCalls }}</dd></div>
          <div><dt>证据 / 步骤</dt><dd class="num">{{ record.evidenceCount }} / {{ record.stepsCount }}</dd></div>
          <div><dt>答案字数</dt><dd class="num">{{ record.answerChars }}</dd></div>
          <div><dt>证据召回</dt><dd class="num">{{ record.groundingRecall ?? '—' }}</dd></div>
        </dl>
      </section>

      <section v-if="record.toolNames.length > 0" class="block">
        <div class="label">用到的工具</div>
        <div class="chips">
          <code v-for="name in record.toolNames" :key="name" class="chip">{{ name }}</code>
        </div>
      </section>

      <section v-if="record.deductions.length > 0" class="block">
        <div class="label">扣分理由</div>
        <ul class="list">
          <li v-for="(item, i) in record.deductions" :key="i">{{ item }}</li>
        </ul>
      </section>

      <section v-if="record.missingAnchors.length > 0" class="block">
        <div class="label">未核对到的锚点</div>
        <ul class="list list--warn">
          <li v-for="(item, i) in record.missingAnchors" :key="i"><code>{{ item }}</code></li>
        </ul>
      </section>
    </div>
  </ModalShell>
</template>

<style scoped>
/* 容器/遮罩/标题由 ModalShell 提供 */

.detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px 14px;
  border-bottom: 1px solid var(--rule);
}

.detail__id {
  color: var(--ink-3);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.score-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.detail__overall {
  color: var(--ink);
  font-size: var(--fs-display);
  line-height: 1;
}

.detail__time {
  margin-left: auto;
  color: var(--ink-4);
  font-size: 10px;
}

.dims {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-3);
}

.dim__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.dim__bar {
  height: 3px;
  margin: 4px 0;
  background: var(--paper-inset);
}

.dim__fill {
  height: 100%;
}

.dim__hint {
  color: var(--ink-4);
  font-size: 10px;
  line-height: 1.5;
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.root {
  line-height: 1.7;
  color: var(--ink);
}

.confidence {
  color: var(--ink-4);
  font-size: 10px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 5px var(--sp-3);
}

.facts > div {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  border-bottom: 1px dotted var(--rule);
  padding-bottom: 3px;
}

.facts dt {
  color: var(--ink-4);
}

.facts dd {
  color: var(--ink-2);
  overflow-wrap: anywhere;
  text-align: right;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.chip {
  padding: 2px 5px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-sunken);
  color: var(--ink-3);
  font-size: 10px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 1.2em;
  list-style: disc;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  line-height: 1.65;
}

.list--warn {
  color: var(--warn);
}

.list--warn code {
  overflow-wrap: anywhere;
}
</style>
