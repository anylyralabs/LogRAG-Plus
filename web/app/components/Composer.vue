<script setup lang="ts">
/**
 * 输入区。
 *
 * 排版意图：命令行。左侧一个等宽提示符 `›`，不是带边框的文本框——
 * 这份产品的输入是「再问一句」而不是「填一个表单」。
 * 边框只在聚焦时出现，且是下边框，不是四边。
 */
const props = defineProps<{
  busy: boolean
  hasLog: boolean
  phase: string
}>()

const emit = defineEmits<{ send: [text: string]; abort: [] }>()

const text = ref('')
const el = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)

const placeholder = computed(() =>
  props.hasLog
    ? '再问一句，比如「怎么彻底避免」…'
    : '先绑定日志，或直接粘贴一段报错…',
)

function submit(): void {
  if (props.busy) return
  const v = text.value.trim()
  if (v === '') return
  emit('send', v)
  text.value = ''
  nextTick(() => resize())
}

function resize(): void {
  const node = el.value
  if (node === null) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, 140)}px`
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div>
    <div
      class="flex items-end gap-2 border-b transition"
      :class="focused ? 'border-[var(--ui-primary)]' : 'border-[var(--ui-border-accented)]'"
    >
      <span class="pb-2 font-mono text-[13px] text-[var(--ui-primary)]" aria-hidden="true">›</span>

      <textarea
        ref="el"
        v-model="text"
        :placeholder="placeholder"
        rows="1"
        aria-label="输入问题"
        class="min-w-0 flex-1 resize-none bg-transparent py-2 text-[13px] leading-relaxed text-[var(--ui-text)] outline-none placeholder:text-[var(--ui-text-dimmed)]"
        @input="resize"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="focused = false"
      />

      <UButton
        v-if="busy"
        icon="i-lucide-square"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mb-1.5"
        aria-label="停止"
        @click="emit('abort')"
      />
      <UButton
        v-else
        icon="i-lucide-arrow-up"
        color="primary"
        variant="ghost"
        size="xs"
        class="mb-1.5"
        :disabled="text.trim() === ''"
        aria-label="发送"
        @click="submit"
      />
    </div>

    <p class="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-[var(--ui-text-dimmed)]">
      <template v-if="busy && phase !== ''">
        <UIcon name="i-lucide-loader-circle" class="size-2.5 animate-spin" />
        {{ phase }}
      </template>
      <template v-else>回车发送　Shift+回车换行</template>
    </p>
  </div>
</template>
