<script setup lang="ts">
/**
 * 追问面板 —— 贴在输入框**上方**，与输入框同宽。
 *
 * ## 为什么在这里
 * 追问是阻塞性的：用户不答，下一轮就没法继续。它原本是半屏弹层，
 * 弹层会盖住输入框——而用户要做的恰恰是「在输入框里回答」，两者抢同一块位置。
 *
 * 现在它作为输入区的一部分浮在输入框上方：
 *  - 与输入框严格同宽（同处 `.composer-bar__inner` 的宽度约束内）；
 *  - 不遮挡对话上下文，也不遮挡输入框；
 *  - 回答后原地消失，输入框自然接替成为焦点。
 *
 * ## 与消息的关系
 * 问题来自消息的 `meta.asks`（落库），因此刷新、换设备回放都还在。
 * 「已回答」由**其后是否出现用户消息**判定，不设额外状态。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowUp, MessageCircleQuestion, X } from 'lucide-vue-next'
import type { AskPayload } from '@/lib/types'

const props = defineProps<{
  asks: AskPayload[]
  /** 正在流式：只展示，不接受输入 */
  disabled?: boolean
}>()

const emit = defineEmits<{ answer: [text: string] }>()

/** 用户主动收起（问题仍会留在消息里） */
const collapsed = ref(false)
const drafts = ref<Record<string, string>>({})
const firstInput = ref<HTMLInputElement | null>(null)

const questions = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ask of props.asks) {
    for (const q of ask.questions) {
      if (q === '' || seen.has(q)) continue
      seen.add(q)
      out.push(q)
    }
  }
  return out
})

const reasons = computed(() =>
  props.asks.map((a) => a.reason).filter((r): r is string => r !== undefined && r !== ''),
)

const filled = computed(() => questions.value.filter((q) => (drafts.value[q] ?? '').trim() !== ''))
const canSubmit = computed(() => filled.value.length > 0 && props.disabled !== true)

/** 问题集合变化时清空草稿，并重新展开 */
watch(
  () => questions.value.join('\u0000'),
  () => {
    drafts.value = {}
    collapsed.value = false
  },
)

/** 新问题到达时把焦点放到第一项，用户可以直接开始打字 */
watch(
  () => questions.value.length > 0,
  (has) => {
    if (!has) return
    void nextTick(() => {
      if (!collapsed.value) firstInput.value?.focus()
    })
  },
  { immediate: true },
)

function answer(): void {
  if (!canSubmit.value) return
  const lines = filled.value.map((q) => `${q}\n${(drafts.value[q] ?? '').trim()}`)
  emit('answer', lines.join('\n\n'))
  drafts.value = {}
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    answer()
  }
}

function collapse(): void {
  collapsed.value = true
}
</script>

<template>
  <section v-if="questions.length > 0" class="dock" :class="{ 'dock--collapsed': collapsed }">
    <header class="dock__head">
      <MessageCircleQuestion :size="14" aria-hidden="true" />
      <span class="dock__title">需要你补充 {{ questions.length }} 项信息</span>
      <span v-if="reasons.length > 0" class="dock__reason">{{ reasons.join('；') }}</span>
      <div class="dock__spacer" />
      <button
        v-if="!collapsed"
        type="button"
        class="btn btn--icon btn--sm"
        aria-label="稍后再答"
        title="稍后再答"
        @click="collapse"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </header>

    <div v-if="!collapsed" class="dock__body">
      <ol class="dock__list">
        <li v-for="(question, i) in questions" :key="question" class="ask">
          <label class="ask__q" :for="`dock-ask-${i}`">{{ question }}</label>
          <input
            :id="`dock-ask-${i}`"
            :ref="i === 0 ? (el) => (firstInput = el as HTMLInputElement | null) : undefined"
            v-model="drafts[question]"
            class="input ask__input"
            :placeholder="filled.includes(question) ? '' : '在这里回答（可留空）'"
            :disabled="disabled === true"
            @keydown="onKeydown"
          />
        </li>
      </ol>

      <div class="dock__foot">
        <span class="num dock__count">{{ filled.length }} / {{ questions.length }} 项已填写</span>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          :disabled="!canSubmit"
          @click="answer"
        >
          提交并继续
          <ArrowUp :size="13" aria-hidden="true" />
        </button>
      </div>
    </div>

    <button v-else type="button" class="dock__reopen" @click="collapsed = false">
      展开填写
    </button>
  </section>
</template>

<style scoped>
/*
 * 卡片浮在输入框上方：与输入区同一套圆角与底色，
 * 靠阴影与输入框区分层次（输入框是内凹淡底，这里是抬起的纸面）。
 */
.dock {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-field);
  background: var(--paper-raised);
  box-shadow:
    0 0 0 1px var(--accent-line),
    var(--shadow-sm);
}

.dock--collapsed {
  gap: 0;
  padding: 8px 14px;
}

.dock__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--accent-ink);
  font-size: var(--fs-meta);
}

.dock__title {
  font-weight: 500;
  white-space: nowrap;
}

.dock__reason {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock__spacer {
  flex: 1;
}

.dock__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dock__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.ask {
  display: grid;
  grid-template-columns: minmax(0, 13em) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.ask__q {
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.5;
  cursor: pointer;
}

.ask__input {
  height: 32px;
  font-size: var(--fs-meta);
  border-color: transparent;
  background: var(--paper-inset);
}

.ask__input:focus {
  background: var(--paper-raised);
}

.dock__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding-top: 2px;
}

.dock__count {
  flex: 1;
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.dock__reopen {
  align-self: flex-start;
  color: var(--accent);
  font-size: var(--fs-micro);
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 窄屏：问题与输入框上下排，避免各占半行挤成两行 */
@media (max-width: 719px) {
  .dock {
    padding: 10px 12px;
  }

  .ask {
    grid-template-columns: minmax(0, 1fr);
    gap: 5px;
  }

  .dock__reason {
    display: none;
  }
}
</style>
