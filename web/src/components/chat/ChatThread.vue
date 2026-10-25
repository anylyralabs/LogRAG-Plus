<script setup lang="ts">
/**
 * 报告线程。
 *
 * ## 滚动：非强制跟随
 * 与主流 AI 聊天界面一致——**跟随的是「用户的意图」，不是「最后一行文字」**：
 *  - 用户停留在底部时，流式输出自动跟随，读到哪算哪；
 *  - 用户一旦上滚（想回看前面），立刻**停止跟随**，内容继续增长也不把他拽回去；
 *  - 此时右下角出现「回到最新」，点一下才回到底部。
 *
 * 这是「非强制」的含义：界面永远不主动改变用户当前的阅读位置。
 * 强制贴底在长回答里非常恼人——用户刚想读判定，一句话就被推走了。
 *
 * ## 为什么不 scrollIntoView
 * 它在移动端会连同外层容器一起滚动，把输入区推出视口。
 * 这里只操作内部容器的 scrollTop。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowDown } from 'lucide-vue-next'
import MessageItem from './MessageItem.vue'
import type { ChatMessage } from '@/lib/types'

const props = defineProps<{
  messages: ChatMessage[]
  canLocate: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  locate: [text: string]
  retry: []
  answer: [text: string]
}>()

const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)
const showJump = ref(false)

const lastIndex = computed(() => props.messages.length - 1)

const lastAssistantFailed = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i]
    if (m === undefined) continue
    if (m.role === 'assistant') {
      return m.status === 'error' || m.status === 'empty' || m.status === 'aborted'
    }
  }
  return false
})

/**
 * 「这条追问是否已被回答」。
 *
 * 判据是**其后是否出现过用户消息**——不需要额外记录回答状态，
 * 对话历史本身就是唯一事实来源。刷新、回放、打断后重发都自动正确。
 */
function answeredAt(index: number): boolean {
  for (let i = index + 1; i < props.messages.length; i++) {
    if (props.messages[i]?.role === 'user') return true
  }
  return false
}

/**
 * 判定「用户是否停在底部」。
 *
 * 阈值 96px 而不是 80：移动端一次惯性滑动常常停在离底部几十像素处，
 * 阈值太紧会误判成「用户上滚了」，于是流式不再跟随——表现是「卡住不动」。
 */
function nearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 96
}

function onScroll(): void {
  const node = scroller.value
  if (node === null) return
  const atBottom = nearBottom(node)
  pinned.value = atBottom
  showJump.value = !atBottom && props.messages.length > 0
}

function scrollToBottom(smooth = false): void {
  const node = scroller.value
  if (node === null) return
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  pinned.value = true
  showJump.value = false
}

/**
 * 流式跟随（非强制）。
 *
 * 只在用户仍停留在底部时执行；用户上滚过就完全不碰 scrollTop。
 * 用 `scrollTop = scrollHeight` 而不是 smooth：流式增量每几十毫秒一次，
 * smooth 会不断重启动画，表现为抖动。
 */
function follow(): void {
  if (!pinned.value) return
  const node = scroller.value
  if (node === null) return
  node.scrollTop = node.scrollHeight
}

watch(
  () => props.messages.map((m) => `${m.content.length}:${m.reasoning.length}:${m.tools.length}`).join('|'),
  () => {
    void nextTick(follow)
  },
)

/**
 * 只对「最后一轮正在流式」跟随。
 *
 * 历史回放是一次性替换整组消息，长度变化很大——若按长度变化就强制滚到底，
 * 用户打开一份已有的长对话会直接落在末尾，看不到结论开头。
 * 因此：只有**最后一条是 assistant 且仍在 streaming** 时才滚到底；
 * 其余场景保持顶部（回放）或用户当前位置。
 */
watch(
  () => props.messages.length,
  (next, prev) => {
    const last = props.messages[props.messages.length - 1]
    const streaming = last !== undefined && last.role === 'assistant' && last.status === 'streaming'

    // 用户刚发出一条新消息（长度 +2：自己的消息 + 空的助手消息）→ 跟随到底，
    // 这是唯一「强制」的场景：他刚说完话，当然想立刻看到回答开始。
    const justSent = next === prev + 2 && last?.role === 'assistant'

    if (streaming && (justSent || pinned.value)) {
      pinned.value = true
      void nextTick(() => scrollToBottom(false))
      return
    }

    // 历史回放（一次替换整组消息）：停在顶部，从头读
    if (prev === 0 && next > 2) {
      pinned.value = false
      showJump.value = false
      void nextTick(() => {
        const node = scroller.value
        if (node !== null) node.scrollTop = 0
      })
    }
  },
)

onMounted(() => {
  const last = props.messages[props.messages.length - 1]
  if (last !== undefined && last.status === 'streaming') {
    void nextTick(() => scrollToBottom(false))
  }
})

defineExpose({ scrollToBottom, focusInput: () => undefined })
</script>

<template>
  <div class="thread">
    <div ref="scroller" class="thread__scroller" @scroll.passive="onScroll">
      <div class="thread__inner">
        <MessageItem
          v-for="(message, i) in messages"
          :key="i"
          :message="message"
          :can-locate="canLocate"
          :can-retry="lastAssistantFailed && i === lastIndex"
          :answered="answeredAt(i)"
          :live="busy && i === lastIndex"
          @locate="emit('locate', $event)"
          @retry="emit('retry')"
          @answer="emit('answer', $event)"
        />
      </div>
    </div>

    <Transition name="fade">
      <button
        v-if="showJump"
        type="button"
        class="thread__jump"
        aria-label="回到最新"
        @click="scrollToBottom(true)"
      >
        <ArrowDown :size="13" aria-hidden="true" />
        回到最新
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.thread {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.thread__scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding-bottom: var(--sp-5);
}

.thread__inner {
  max-width: var(--thread-w);
  margin: 0 auto;
  padding: 0 var(--sp-4);
}

/* 非强制跟随时出现的「回到最新」：居中悬浮，不与输入区抢位置 */
.thread__jump {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 13px;
  border: 0;
  border-radius: 999px;
  background: var(--paper-raised);
  color: var(--ink-2);
  font-size: var(--fs-micro);
  box-shadow:
    0 0 0 1px var(--rule),
    0 6px 18px rgba(28, 27, 22, 0.14);
}

.thread__jump:hover {
  color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent-line),
    0 6px 18px rgba(28, 27, 22, 0.14);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur) var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 959px) {
  .thread__inner {
    padding: 0 var(--sp-3);
  }
}
</style>
