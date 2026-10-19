<script setup lang="ts">
/**
 * 日志面板。
 *
 * 排版意图：这是**原始材料**，所以它看起来该像一份打印件——
 * 等宽的连续行、右侧行号、按严重度上色但克制（INFO 一律不上色）。
 * 一行一个高度，不用卡片分隔；分节用栏目标记，不用标签云。
 */
import { parseLog, nextError, prevError, sliceLines } from '../lib/logdoc'
import type { LogDoc } from '../lib/types'

const props = defineProps<{
  doc: LogDoc | null
  logId: string
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  quote: [{ label: string; text: string }]
  unbind: []
}>()

/** 一次渲染 120 行：够看上下文，又不至于把手机拖死 */
const WINDOW = 120

const parsed = computed(() => (props.doc === null ? null : parseLog(props.doc.content)))
const from = ref(1)
const pickStart = ref<number | null>(null)
const pickEnd = ref<number | null>(null)

const total = computed(() => parsed.value?.lines.length ?? 0)
const windowEnd = computed(() => Math.min(total.value, from.value + WINDOW - 1))

const visible = computed(() => {
  const p = parsed.value
  if (p === null) return []
  const out: Array<{ no: number; text: string; severity: string }> = []
  for (let i = from.value; i <= windowEnd.value; i++) {
    out.push({ no: i, text: p.lines[i - 1] ?? '', severity: p.severity[i - 1] ?? 'plain' })
  }
  return out
})

const pickRange = computed(() => {
  const a = pickStart.value
  const b = pickEnd.value
  if (a === null) return null
  const to = b ?? a
  return { from: Math.min(a, to), to: Math.max(a, to) }
})

// 打开就跳到最该看的位置：崩溃现场 > 第一处错误 > 开头
watch(
  parsed,
  (p) => {
    pickStart.value = null
    pickEnd.value = null
    if (p === null) {
      from.value = 1
      return
    }
    const crash = p.sections.find((s) => s.role === '崩溃现场')
    if (crash !== undefined) {
      from.value = Math.max(1, crash.start)
      return
    }
    const first = p.errors[0]
    from.value = first === undefined ? 1 : Math.max(1, first - 10)
  },
  { immediate: true },
)

function jump(to: number): void {
  from.value = Math.max(1, Math.min(total.value - 1, to))
}

function goError(dir: 1 | -1): void {
  const p = parsed.value
  if (p === null) return
  const target =
    dir === 1 ? nextError(p.errors, from.value + WINDOW - 1) : prevError(p.errors, from.value)
  if (target !== null) jump(target - 10)
}

function pickLine(no: number): void {
  if (pickStart.value === null || pickEnd.value !== null) {
    pickStart.value = no
    pickEnd.value = null
    return
  }
  pickEnd.value = no
}

function sendQuote(): void {
  const r = pickRange.value
  const p = parsed.value
  if (r === null || p === null) return
  emit('quote', {
    label: `${props.doc?.name ?? 'main.log'}:${r.from}-${r.to}`,
    text: sliceLines(p, r.from, r.to),
  })
  pickStart.value = null
  pickEnd.value = null
}

const severityClass: Record<string, string> = {
  error: 'text-[var(--ui-error)]',
  warn: 'text-[var(--ui-warning)]',
  dim: 'text-[var(--ui-text-dimmed)]',
  plain: 'text-[var(--ui-text-toned)]',
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 材料标识 -->
    <div class="flex items-baseline gap-2 border-b border-[var(--ui-border)] px-4 py-2.5">
      <span class="dossier-label border-0 pb-0">材料</span>
      <span class="truncate font-mono text-[11px] text-[var(--ui-text-muted)]">
        {{ doc?.name ?? logId }}
      </span>
      <div class="flex-1" />
      <UButton
        v-if="logId !== ''"
        icon="i-lucide-unlink"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="解除绑定"
        @click="emit('unbind')"
      />
    </div>

    <!-- 分节：节名即文件名，把日志本来的结构还回去 -->
    <div
      v-if="parsed !== null && parsed.sections.length > 1"
      class="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[var(--ui-border)] px-4 py-2"
    >
      <button
        v-for="s in parsed.sections"
        :key="s.start"
        type="button"
        class="font-mono text-[10px] text-[var(--ui-text-muted)] underline-offset-4 transition hover:text-[var(--ui-primary)] hover:underline focus-visible:underline"
        @click="jump(s.start)"
      >
        {{ s.role }}
        <span class="text-[var(--ui-text-dimmed)]">{{ s.start }}</span>
      </button>
    </div>

    <!-- 导航与计数 -->
    <div v-if="parsed !== null" class="flex items-center gap-1 border-b border-[var(--ui-border)] px-4 py-1.5">
      <UButton
        icon="i-lucide-chevron-up"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="上一处错误"
        @click="goError(-1)"
      />
      <UButton
        icon="i-lucide-chevron-down"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="下一处错误"
        @click="goError(1)"
      />
      <span class="ml-1.5 font-mono text-[10px] text-[var(--ui-text-dimmed)]">
        <span class="text-[var(--ui-error)]">{{ parsed.counts.error }}</span>
        <span class="mx-0.5">错</span>
        <span class="text-[var(--ui-warning)]">{{ parsed.counts.warn }}</span>
        <span class="ml-0.5">警</span>
      </span>
      <div class="flex-1" />
      <span class="font-mono text-[10px] text-[var(--ui-text-dimmed)]">
        {{ from }}–{{ windowEnd }} / {{ total }}
      </span>
    </div>

    <!-- 正文 -->
    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="loading" class="flex items-center justify-center py-16">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-[var(--ui-text-dimmed)]" />
      </div>
      <div v-else-if="error !== ''" class="px-4 py-10">
        <p class="text-[13px] text-[var(--ui-warning)]">{{ error }}</p>
      </div>
      <div v-else-if="doc === null" class="px-4 py-10">
        <p class="text-[13px] text-[var(--ui-text-dimmed)]">还没有材料。</p>
      </div>
      <table v-else class="w-full border-collapse font-mono text-[11px] leading-[1.6]">
        <tbody>
          <tr
            v-for="line in visible"
            :key="line.no"
            class="cursor-pointer align-top outline-none"
            :class="
              pickRange !== null && line.no >= pickRange.from && line.no <= pickRange.to
                ? 'bg-[var(--ui-primary)]/15'
                : 'hover:bg-[var(--ui-bg-muted)] focus-visible:bg-[var(--ui-bg-muted)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--ui-primary)]'
            "
            tabindex="0"
            @click="pickLine(line.no)"
            @keydown.enter.prevent="pickLine(line.no)"
            @keydown.space.prevent="pickLine(line.no)"
          >
            <td
              class="line-no w-px min-w-[3.2em] select-none border-r border-[var(--ui-border-muted)] px-2.5 text-right text-[10px]"
            >
              {{ line.no }}
            </td>
            <td class="px-2.5 whitespace-pre-wrap break-words" :class="severityClass[line.severity]">
              {{ line.text }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 选区动作 -->
    <div
      v-if="pickRange !== null"
      class="flex items-center gap-3 border-t border-[var(--ui-border)] px-4 py-2"
    >
      <span class="font-mono text-[10px] text-[var(--ui-text-muted)]">
        {{ pickRange.from }}–{{ pickRange.to }} 行
      </span>
      <div class="flex-1" />
      <UButton color="neutral" variant="link" size="xs" class="!p-0 !text-[11px]" @click="pickStart = null; pickEnd = null">
        取消
      </UButton>
      <UButton color="primary" size="xs" @click="sendQuote">引用这几行</UButton>
    </div>

    <p
      v-if="doc !== null && doc.truncated"
      class="border-t border-[var(--ui-border)] px-4 py-1.5 font-mono text-[10px] text-[var(--ui-warning)]"
    >
      面板只显示前 2MB，分析时送入完整正文。
    </p>
  </div>
</template>
