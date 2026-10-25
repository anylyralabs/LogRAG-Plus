<script setup lang="ts">
/**
 * 一条消息。
 *
 * ## 一条报告的可见层级（从上到下）
 * 1. **判定句** —— 19px，一眼可见；这是用户唯一必须先看到的东西；
 * 2. **处置步骤** —— 编号列表，照着做；
 * 3. **完整分析** —— 默认折叠（结论已在前两条里给全时）。正文是「为什么」，
 *    与判定/处置高度重叠；一屏里同时展开会让重点被淹掉；
 * 4. **调查过程 / 自检** —— 复核者信息，各压成一行，默认收起。
 *
 * ## 为什么不再有「报告」标签
 * 每个助手消息都挂一个「报告」标签，等于每段文字前都加一句「以下是文字」。
 * 状态异常时才需要标记（未完成 / 无结论 / 已停止）。
 */
import { computed, ref } from 'vue'
import { Check, Copy, RotateCcw } from 'lucide-vue-next'
import ConclusionSpine from '@/components/report/ConclusionSpine.vue'
import MarkdownView from '@/components/report/MarkdownView.vue'
import ScorePanel from '@/components/report/ScorePanel.vue'
import StepsPanel from '@/components/report/StepsPanel.vue'
import ThinkingPanel from '@/components/report/ThinkingPanel.vue'
import { looksLikeLog } from '@/lib/upload'
import type { ChatMessage } from '@/lib/types'

const props = defineProps<{
  message: ChatMessage
  /** 有日志面板时允许证据回跳 */
  canLocate: boolean
  /** 最后一条失败/中断消息可重试 */
  canRetry: boolean
  /** 该消息之后已有用户发言 → 追问视为已回答 */
  answered?: boolean
  /** 正在流式：追问块只展示、不接受输入 */
  live?: boolean
}>()

const emit = defineEmits<{
  locate: [text: string]
  retry: []
  answer: [text: string]
}>()

const copied = ref(false)

const isUser = computed(() => props.message.role === 'user')

const status = computed<{ text: string; tone: string } | null>(() => {
  const m = props.message
  if (m.role !== 'assistant') return null
  switch (m.status) {
    case 'streaming':
      return { text: '分析中', tone: 'accent' }
    case 'error':
      return { text: '未完成', tone: 'danger' }
    case 'aborted':
      return { text: '已停止', tone: 'warn' }
    case 'empty':
      return { text: '无结论', tone: 'warn' }
    default:
      return null
  }
})

const userLooksLikeLog = computed(() => isUser.value && looksLikeLog(props.message.content))

/** 用户消息里的引用块单独渲染，避免一行行压扁 */
const userParts = computed(() => {
  const text = props.message.content
  const idx = text.indexOf('引用日志 ')
  if (idx < 0) return { body: text, quote: '' }
  const body = text.slice(0, idx).trimEnd()
  const quote = text.slice(idx).trim()
  return { body, quote }
})


async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.content)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    /* 非安全上下文：静默失败，不打断阅读 */
  }
}
</script>

<template>
  <div v-if="isUser" class="user">
    <div class="user__inner">
      <p v-if="userParts.body !== ''" class="user__text" :class="{ 'user__text--log': userLooksLikeLog }">
        {{ userParts.body }}
      </p>
      <pre v-if="userParts.quote !== ''" class="user__quote">{{ userParts.quote }}</pre>
    </div>
  </div>

  <article v-else class="report">
    <!-- 状态只在异常时出现；正常完成时不加任何头部装饰 -->
    <!-- 头部只在异常状态出现；正常回答不挂任何头部装饰 -->
    <header v-if="status !== null" class="report__head">
      <span class="report__status" :class="`report__status--${status.tone}`">{{ status.text }}</span>
    </header>

    <!--
      顺序 = 真实发生的时间：
        ① 调查过程（它先查）→ ② 正文（边查边写）→ ③ 结论（最后才提炼）
      模式最后输出的是结尾 JSON 块，所以结论在最下面是**符合时间顺序**的。

      刻意不做的两件事：
      · 不把结论提到最上——那是把时间倒过来，读者会先看到结果再看到过程；
      · 不折叠正文——正文就是这个产品的答案主体，藏在「展开」后面等于让用户多点一次。
    -->
    <!-- 调查步骤与思维链是两种性质的内容，各占一块、各有一套折叠状态 -->
    <StepsPanel
      :tools="message.tools"
      :live="message.status === 'streaming'"
      :notices="message.notices"
    />
    <ThinkingPanel
      :reasoning="message.reasoning"
      :thinking-total="message.thinkingTotal"
      :live="message.status === 'streaming'"
    />

    <div v-if="message.content.trim() !== ''" class="report__body">
      <MarkdownView :text="message.content" :streaming="message.status === 'streaming'" />
    </div>
    <p v-else-if="message.status === 'streaming'" class="report__pending">
      <span class="dot dot--live" aria-hidden="true" />
      正在读日志…
    </p>

    <!-- 结论：正文之后，作为整段的收束 -->
    <ConclusionSpine
      v-if="message.conclusion !== null"
      :conclusion="message.conclusion"
      :missing-anchors="message.score?.missingAnchors ?? []"
      :can-locate="canLocate"
      @locate="emit('locate', $event)"
    />

    <p v-if="message.status === 'empty' && message.error !== null" class="alert alert--warn">
      {{ message.error }}
    </p>
    <p v-else-if="message.error !== null" class="alert" :class="message.status === 'aborted' ? 'alert--warn' : 'alert--danger'">
      {{ message.error }}
    </p>

    <button
      v-if="canRetry && (message.status === 'error' || message.status === 'empty' || message.status === 'aborted')"
      type="button"
      class="btn btn--sm btn--subtle report__retry"
      @click="emit('retry')"
    >
      <RotateCcw :size="12" aria-hidden="true" />
      重新分析
    </button>

    <!--
      动作行紧贴内容末尾：复制按钮离正文越远越难找。
      早先它放在消息头部右上角，用户读完答案要往上滚才看得到。
    -->
    <div v-if="message.content.trim() !== ''" class="report__actions">
      <button
        type="button"
        class="report__action"
        :aria-label="copied ? '已复制' : '复制回答'"
        @click="copy"
      >
        <Check v-if="copied" :size="12" aria-hidden="true" />
        <Copy v-else :size="12" aria-hidden="true" />
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>

    <!-- 自检：复核者信息，最后一行小字 -->
    <ScorePanel
      v-if="message.score !== null"
      :score="message.score"
      :can-locate="canLocate"
      @locate="emit('locate', $event)"
    />
  </article>
</template>

<style scoped>
/* ── 用户发言：右侧淡底气泡，左对齐（中文右对齐极难读） ─── */
.user {
  display: flex;
  justify-content: flex-end;
  padding: 26px 0 0;
}

.user__inner {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: min(84%, 34em);
  padding: 10px 14px;
  border-radius: var(--radius-field);
  background: var(--paper-inset);
}

.user__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink);
  line-height: 1.7;
}

.user__text--log {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.65;
  color: var(--ink-2);
  max-height: 220px;
  overflow-y: auto;
}

.user__quote {
  max-height: 200px;
  overflow: auto;
  margin: 0;
  color: var(--ink-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.6;
  white-space: pre-wrap;
}

/* ── 助手报告：一页纸，段间距 18px ─────────────────────── */
.report {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 26px 0 40px;
}

.report + .report {
  border-top: 1px solid var(--rule-muted);
}

.report__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 20px;
  margin-bottom: -6px;
}

.report__status {
  font-size: var(--fs-micro);
  font-weight: 500;
}

.report__status--accent {
  color: var(--accent);
}

.report__status--danger {
  color: var(--danger);
}

.report__status--warn {
  color: var(--warn);
}

/* 动作行：贴近内容末尾，默认低对比，hover 才突出 */
.report__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: -4px;
}

.report__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--ink-4);
  font-size: var(--fs-micro);
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.report__action:hover {
  background: var(--paper-inset);
  color: var(--ink-2);
}

.report__body {
  max-width: 34em;
}

.report__pending {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.report__retry {
  align-self: flex-start;
}

@media (max-width: 719px) {
  .user {
    padding-top: 20px;
  }

  .user__inner {
    max-width: 92%;
  }

  .report {
    gap: 14px;
    padding: 20px 0 32px;
  }

}
</style>
