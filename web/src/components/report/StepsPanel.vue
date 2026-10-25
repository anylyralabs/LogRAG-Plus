<script setup lang="ts">
/**
 * 调查步骤：模型调用工具的时间线。
 *
 * ## 与思维链分开
 * 早先「调查步骤 + 思维链」挤在同一个折叠块里，两者性质完全不同：
 *  - 步骤是**可枚举的动作**（查了什么、拿到什么），有明确起止；
 *  - 思维链是**连续的自由文本**，读的是推理走向。
 * 混在一起时，滚动的长思维链会把步骤挤出去，用户看不出「它现在在做什么」。
 *
 * ## 流式时只显示当前一步
 * 十几个步骤同时铺开，既看不清进度也占满版面。因此输出期间**每次只显示
 * 一个完整步骤**（当前正在执行的那一步），并给出「第 N / M 步」的位置感。
 * 用户点开后才显示完整时间线。
 */
import { computed, ref, watch } from 'vue'
import { AlertTriangle, ChevronDown, ChevronRight, Loader, Terminal } from 'lucide-vue-next'
import { summarizeArgs } from '@/stores/chat'
import type { StreamNotice, ToolCallItem } from '@/lib/types'

const props = defineProps<{
  tools: ToolCallItem[]
  live: boolean
  notices: StreamNotice[]
}>()

const touched = ref(false)
const open = ref(false)

/** 形态：输出中单步 / 用户展开全部 / 收起一行 */
const mode = computed<'live' | 'open' | 'closed'>(() => {
  if (open.value) return 'open'
  if (props.live && !touched.value) return 'live'
  return 'closed'
})

/**
 * 当前该显示的那一步。
 *
 * 优先「最后一个未完成的」——那才是此刻正在跑的动作；
 * 全部完成时退回最后一步（刚拿到结果的那个）。
 */
const current = computed<ToolCallItem | null>(() => {
  for (let i = props.tools.length - 1; i >= 0; i--) {
    const tool = props.tools[i]
    if (tool !== undefined && !tool.done) return tool
  }
  return props.tools[props.tools.length - 1] ?? null
})

const failedCount = computed(() => props.tools.filter((t) => t.failed).length)

/**
 * 当前该显示哪几步。
 *
 *  - `open`：完整时间线
 *  - `live`：只显示当前这一步
 *  - `closed`：**不显示任何步骤**（只留一行摘要）
 *
 * 这里必须显式判 `closed` 并返回空数组。早先写成「非 open 就返回当前步」，
 * 于是收起态也渲染了一步——摘要行下面挂着一块内容，看起来根本没折叠。
 */
const visible = computed<ToolCallItem[]>(() => {
  if (mode.value === 'open') return props.tools
  if (mode.value === 'live' && current.value !== null) return [current.value]
  return []
})

const summary = computed(() => {
  if (props.tools.length === 0) return ''
  const failed = failedCount.value
  return failed > 0 ? `${props.tools.length} 步 · ${failed} 次失败` : `${props.tools.length} 步`
})

/** 流结束自动收起（用户手动干预过则保持） */
watch(
  () => props.live,
  (live) => {
    if (touched.value) return
    if (!live) open.value = false
  },
  { immediate: true },
)

function toggle(): void {
  touched.value = true
  open.value = !open.value
}

function toolLabel(name: string): string {
  switch (name) {
    case 'grep_log_file':
      return '检索日志'
    case 'read_log_file':
      return '读取日志'
    case 'rag_search':
      return '知识库'
    case 'list_topics':
      return '知识库目录'
    case 'expert_knowledge':
      return '领域知识'
    case 'github_search':
    case 'github_search_repos':
      return 'GitHub 搜索'
    case 'github_get_content':
      return 'GitHub 读取'
    case 'web_search':
      return '网络搜索'
    case 'ask_user':
      return '向你提问'
    default:
      return name
  }
}
</script>

<template>
  <div
    v-if="tools.length > 0 || notices.length > 0"
    class="steps"
    :class="[`steps--${mode}`, { 'steps--live': live }]"
  >
    <button
      type="button"
      class="steps__head"
      :aria-expanded="open"
      :disabled="tools.length === 0"
      @click="toggle"
    >
      <ChevronDown v-if="open" :size="13" aria-hidden="true" />
      <ChevronRight v-else :size="13" aria-hidden="true" />
      <span class="steps__title">{{ live ? '正在调查' : '调查步骤' }}</span>
      <span v-if="summary !== ''" class="num steps__meta">{{ summary }}</span>
      <!-- 单步态给出位置感：第几步 / 共几步 -->
      <span v-if="mode === 'live' && current !== null" class="num steps__position">
        第 {{ current.index }} / {{ tools.length }} 步
      </span>
      <span v-if="live" class="dot dot--live steps__pulse" aria-hidden="true" />
    </button>

    <!-- 流内提示不折叠：轮次上限、重复检索会改变结论的可信度 -->
    <div v-if="notices.length > 0" class="notices">
      <div v-for="(n, i) in notices" :key="i" class="notice">
        <span class="dot" />
        {{ n.text }}
      </div>
    </div>

    <!--
      输出中只渲染**一个**步骤，且不做高度限制：
      单步内容本来就短（动作 + 参数 + 结果摘要），完整显示比塞进滚动框更清楚。
    -->
    <ol v-if="visible.length > 0" class="list" :class="{ 'list--single': mode !== 'open' }">
      <li
        v-for="tool in visible"
        :key="tool.index"
        class="item"
        :class="{ 'item--failed': tool.failed }"
      >
        <div class="item__rail" aria-hidden="true">
          <Loader v-if="!tool.done && live" :size="12" class="item__icon item__icon--spin" />
          <AlertTriangle v-else-if="tool.failed" :size="12" class="item__icon" />
          <Terminal v-else :size="12" class="item__icon" />
        </div>
        <div class="item__body">
          <div class="item__head">
            <span class="num item__no">{{ String(tool.index).padStart(2, '0') }}</span>
            <span class="item__action">{{ toolLabel(tool.name) }}</span>
            <code class="item__name">{{ tool.name }}</code>
            <span v-if="tool.summary === undefined && !tool.done" class="item__state">进行中</span>
            <span v-else-if="tool.truncated === true" class="item__state">结果已截断</span>
          </div>
          <p v-if="summarizeArgs(tool.args) !== ''" class="item__args">
            {{ summarizeArgs(tool.args) }}
          </p>
          <p v-if="tool.summary !== undefined" class="item__result">{{ tool.summary }}</p>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.steps__head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 26px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: left;
}

.steps__head:hover:not(:disabled) {
  color: var(--ink-2);
}

.steps__head:disabled {
  cursor: default;
}

.steps__title {
  color: var(--ink-2);
}

.steps--live .steps__title {
  color: var(--accent-ink);
}

.steps__meta {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.steps__position {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.steps__pulse {
  margin-left: auto;
  color: var(--accent);
}

.notices {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.notice {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 9px;
  border-radius: var(--radius-control);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-meta);
  line-height: 1.6;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
}

/* 单步态：给一点内缩，与时间线区分开，但不加边框 */
.list--single {
  padding: 8px 10px;
  border-radius: var(--radius-control);
  background: var(--paper-inset);
}

.item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
}

.item__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 时间线只在「展开全部」时连接各步；单步态不画线 */
.steps--open .item:not(:last-child) .item__rail::after {
  content: '';
  flex: 1;
  width: 1px;
  margin-top: 3px;
  background: var(--rule);
}

.item__icon {
  flex: none;
  margin-top: 3px;
  color: var(--ink-4);
}

.item--failed .item__icon {
  color: var(--warn);
}

.item__icon--spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.item__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.item__head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.item__no {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.item__action {
  color: var(--ink);
  font-size: var(--fs-meta);
}

.item__name {
  color: var(--ink-4);
  font-size: 10.5px;
}

.item__state {
  color: var(--ink-4);
  font-size: 10.5px;
}

.item__args {
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  word-break: break-all;
}

.item__result {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

/* 展开态的结果摘要限制在 3 行，避免一条巨型结果撑破版面 */
.steps--open .item__result {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
