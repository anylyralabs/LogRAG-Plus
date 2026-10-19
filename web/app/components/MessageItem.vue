<script setup lang="ts">
/**
 * 一条记录。
 *
 * 排版意图：像卷宗里的一页。
 * 用户的那一条是缩进到右侧的短行（自己说的话不必占满）；助手这一条是**左侧留白 + 栏目标记**
 * 的正交布局，读起来像文件而不是气泡。
 */
import type { ChatMessage } from '../lib/types'

const props = defineProps<{ message: ChatMessage }>()

const openThinking = ref(true)
const copied = ref(false)

const isUser = computed(() => props.message.role === 'user')

const statusText = computed(() => {
  const m = props.message
  if (m.role !== 'assistant') return null
  if (m.status === 'streaming') return '分析中'
  if (m.status === 'error') return '未完成'
  if (m.status === 'aborted') return '已停止'
  // 成功但没正文：这是「伪装成功」的形态，必须标出来
  if (m.content.trim() === '' && m.conclusion === null) return '无结论'
  return null
})

watch(
  () => props.message.status,
  (s) => {
    if (s !== 'streaming') openThinking.value = false
  },
)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.content)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // 非安全上下文不可用：静默失败，不打断阅读
  }
}

const looksLikeLog = computed(() => {
  const c = props.message.content
  return c.includes('\n') && (c.length > 400 || /\[\d{2}:\d{2}:\d{2}\]/.test(c))
})
</script>

<template>
  <!-- 用户：右对齐短行，不占满宽度 -->
  <div v-if="isUser" class="flex justify-end">
    <div class="max-w-[78%] border-r-2 border-[var(--ui-border-accented)] pr-3 text-right">
      <pre
        v-if="looksLikeLog"
        class="max-h-72 overflow-auto whitespace-pre-wrap break-all text-left font-mono text-[11px] leading-relaxed text-[var(--ui-text-toned)]"
      >{{ message.content }}</pre>
      <p v-else class="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ui-text)]">
        {{ message.content }}
      </p>
    </div>
  </div>

  <!-- 助手：栏目标记 + 正交内容 -->
  <article v-else class="flex flex-col gap-3">
    <div class="flex items-center gap-2.5">
      <span class="dossier-label border-0 pb-0">报告</span>
      <span v-if="statusText !== null" class="font-mono text-[10px] text-[var(--ui-warning)]">
        {{ statusText }}
      </span>
      <div class="flex-1" />
      <UButton
        v-if="message.content.trim() !== ''"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="复制回答"
        @click="copy"
      />
    </div>

    <!-- 结论在前：玩家先要知道「是什么、该做什么」 -->
    <ConclusionSpine v-if="message.conclusion !== null" :conclusion="message.conclusion" />

    <!-- 正文 -->
    <div
      v-if="message.content.trim() !== ''"
      class="max-w-[34em] text-[13px] leading-[1.75] text-[var(--ui-text)]"
    >
      <MarkdownView :text="message.content" />
    </div>
    <p
      v-else-if="message.status === 'streaming'"
      class="flex items-center gap-2 text-[13px] text-[var(--ui-text-muted)]"
    >
      <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
      正在读日志…
    </p>

    <UAlert
      v-if="message.error !== null"
      :color="message.status === 'aborted' ? 'warning' : 'error'"
      variant="subtle"
      :icon="message.status === 'aborted' ? 'i-lucide-circle-stop' : 'i-lucide-triangle-alert'"
      :description="message.error"
    />

    <!-- 取证过程：思维链与工具调用合并成一栏，默认收起 -->
    <div v-if="message.thinkingTotal > 0 || message.tools.length > 0">
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        :trailing-icon="openThinking ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="!p-0 !text-[11px]"
        @click="openThinking = !openThinking"
      >
        取证过程
        <span class="ml-1.5 font-mono text-[10px] text-[var(--ui-text-dimmed)]">
          {{ message.tools.length }} 次检索 · {{ message.thinkingTotal }} 字
        </span>
      </UButton>

      <div v-if="openThinking" class="mt-3 flex flex-col gap-3">
        <!-- 工具调用：等宽的调用记录，像附录 -->
        <div v-if="message.tools.length > 0" class="flex flex-col">
          <div
            v-for="(t, i) in message.tools"
            :key="i"
            class="grid grid-cols-[1.75rem_1fr] items-baseline gap-1 border-b border-[var(--ui-border-muted)] py-1.5 last:border-b-0"
          >
            <span class="line-no font-mono text-[10px]">{{ i + 1 }}</span>
            <span class="truncate font-mono text-[11px] text-[var(--ui-text-muted)]">{{ t.name }}</span>
          </div>
        </div>

        <div
          v-if="message.reasoning !== ''"
          class="max-h-60 overflow-y-auto border-l border-[var(--ui-border)] pl-3 text-[11px] leading-[1.7] whitespace-pre-wrap text-[var(--ui-text-muted)]"
        >{{ message.reasoning }}</div>
      </div>
    </div>

    <!-- 自评：给复核者，默认收起 -->
    <UCollapsible v-if="message.score !== null">
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        class="!p-0 !text-[11px] !text-[var(--ui-text-dimmed)]"
        trailing-icon="i-lucide-chevron-down"
      >
        自评 {{ message.score.overall }} 分
      </UButton>
      <template #content>
        <div class="mt-2 flex flex-col gap-1.5 text-[11px] text-[var(--ui-text-muted)]">
          <div class="flex flex-wrap gap-x-4 font-mono text-[10px]">
            <span>证据 {{ message.score.dimensions.grounding }}</span>
            <span>核实 {{ message.score.dimensions.verification }}</span>
            <span>可行 {{ message.score.dimensions.actionability }}</span>
            <span>简洁 {{ message.score.dimensions.economy }}</span>
          </div>
          <p v-for="(d, i) in message.score.deductions" :key="i">{{ d }}</p>
          <p v-if="message.score.missingAnchors.length > 0" class="text-[var(--ui-warning)]">
            未核对到：{{ message.score.missingAnchors.join('、') }}
          </p>
        </div>
      </template>
    </UCollapsible>
  </article>
</template>
