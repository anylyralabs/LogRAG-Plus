<script setup lang="ts">
/**
 * Markdown 视图（入口组件）。
 *
 * 流式期间文本每几十毫秒变一次，整段重新 lexer 会拖慢移动端。这里按 120ms
 * 节流：流式时最多每 120ms 重解析一次，结束后立刻做一次完整解析
 * （修正半截围栏、未闭合的强调等）。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { parseMarkdown, type Block } from '@/lib/markdown'
import MarkdownBlocks from './MarkdownBlocks.vue'

const props = defineProps<{ text: string; streaming?: boolean }>()
const expanded = ref<Record<number, boolean>>({})

const blocks = ref<Block[]>([])
let timer: ReturnType<typeof setTimeout> | null = null
let lastParseAt = 0

const THROTTLE_MS = 120

function parseNow(): void {
  blocks.value = parseMarkdown(props.text)
  lastParseAt = Date.now()
}

function schedule(): void {
  if (props.streaming !== true) {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    parseNow()
    return
  }

  const elapsed = Date.now() - lastParseAt
  if (elapsed >= THROTTLE_MS) {
    parseNow()
    return
  }
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    parseNow()
  }, THROTTLE_MS - elapsed)
}

watch(() => props.text, schedule, { immediate: true })
watch(
  () => props.streaming,
  (streaming) => {
    if (streaming === false) schedule()
  },
)

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
})
</script>

<template>
  <div class="markdown">
    <MarkdownBlocks :blocks="blocks" v-model:expanded="expanded" />
  </div>
</template>

<style scoped>
.markdown {
  font-size: var(--fs-body);
  color: var(--ink);
  overflow-wrap: anywhere;
}

.markdown :deep(> :first-child) {
  margin-top: 0;
}

.markdown :deep(> :last-child) {
  margin-bottom: 0;
}
</style>
