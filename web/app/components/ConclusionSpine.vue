<script setup lang="ts">
/**
 * 结论：判定 → 处置 → 依据。
 *
 * 这里是全页唯一用力过猛的地方。用一条竖线把三者串起来，节点的分量不同：
 * 判定最重（等宽编号 + 大字），处置是编号序列（内容本身真是序列，编号才成立），
 * 依据最轻且默认收起——玩家先要「该做什么」，依据是支撑不是主角。
 */
import type { Conclusion } from '../lib/types'

const props = defineProps<{ conclusion: Conclusion }>()

const openEvidence = ref(false)

const rootCause = computed(() => {
  const v = props.conclusion.rootCause
  return typeof v === 'string' ? v.trim() : ''
})

/** 置信度容错：规范是 0–1，模型偶尔给「75」或「高」 */
const confidence = computed<number | null>(() => {
  const v: unknown = props.conclusion.confidence
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1.5 ? v / 100 : v
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^(高|high)/i.test(t)) return 0.85
    if (/^(中|medium|moderate)/i.test(t)) return 0.6
    if (/^(低|low)/i.test(t)) return 0.3
    const n = Number.parseFloat(t.replace('%', ''))
    if (Number.isFinite(n)) return n > 1.5 ? n / 100 : n
  }
  return null
})

const confidenceText = computed(() => {
  const c = confidence.value
  if (c === null) return null
  if (c >= 0.75) return '把握较大'
  if (c >= 0.5) return '把握一般'
  return '把握不大'
})

const steps = computed<string[]>(() => {
  const raw = props.conclusion.steps
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => {
      if (typeof s === 'string') return s.trim()
      if (s !== null && typeof s === 'object' && typeof s.action === 'string') return s.action.trim()
      return ''
    })
    .filter((s) => s !== '')
})

const evidence = computed<string[]>(() => {
  const raw = props.conclusion.evidence
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => {
      if (typeof e === 'string') return e.trim()
      if (e !== null && typeof e === 'object' && typeof e.quote === 'string') {
        const src = typeof e.source === 'string' ? `  ${e.source}` : ''
        return `${e.quote.trim()}${src}`
      }
      return ''
    })
    .filter((s) => s !== '')
})
</script>

<template>
  <section class="flex flex-col">
    <!-- 判定 -->
    <div v-if="rootCause !== ''" class="flex gap-4 border-l-2 border-[var(--ui-primary)] py-1 pl-4">
      <div class="min-w-0">
        <div class="mb-1.5 flex items-baseline gap-2.5">
          <span class="dossier-label border-0 pb-0">判定</span>
          <span v-if="confidenceText !== null" class="font-mono text-[10px] text-[var(--ui-text-dimmed)]">
            {{ confidenceText }}
          </span>
        </div>
        <p class="max-w-[24em] text-[15px] leading-relaxed font-medium text-[var(--ui-text-highlighted)]">
          {{ rootCause }}
        </p>
      </div>
    </div>

    <!-- 处置：真序列，编号才成立 -->
    <div v-if="steps.length > 0" class="mt-5">
      <div class="dossier-label mb-3">处置</div>
      <ol class="flex flex-col">
        <li
          v-for="(s, i) in steps"
          :key="i"
          class="grid grid-cols-[2rem_1fr] items-baseline gap-1 border-b border-[var(--ui-border-muted)] py-2.5 last:border-b-0"
        >
          <span class="line-no font-mono text-[11px]">
            {{ String(i + 1).padStart(2, '0') }}
          </span>
          <span class="max-w-[26em] text-[13px] leading-relaxed text-[var(--ui-text)]">{{ s }}</span>
        </li>
      </ol>
    </div>

    <!-- 依据：默认收起 -->
    <div v-if="evidence.length > 0" class="mt-5">
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        :trailing-icon="openEvidence ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="!p-0 !text-[11px]"
        @click="openEvidence = !openEvidence"
      >
        依据 {{ evidence.length }} 处
      </UButton>
      <ul v-if="openEvidence" class="mt-3 flex flex-col gap-2.5">
        <li v-for="(e, i) in evidence" :key="i" class="evidence">{{ e }}</li>
      </ul>
    </div>
  </section>
</template>
