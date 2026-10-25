<script setup lang="ts">
/**
 * 日志阅读器。
 *
 * 虚拟滚动 + 固定行高（不折行）：日志的每一行都是一个逻辑单位，
 * 折行会破坏「一屏多少行」的直觉，也让 5 万行的滚动变得不可预测。
 * 长行横向滚动；需要通读时用选行引用送到对话里。
 *
 * 交互：
 *  - 点击行：第一次设起点，第二次设终点；
 *  - 上/下错误行导航；
 *  - 日志内搜索，命中行高亮并跳转；
 *  - 证据锚点回跳后短暂高亮目标行。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-vue-next'
import { useLogStore } from '@/stores/log'
import LogLine from './LogLine.vue'

const log = useLogStore()

const scroller = ref<HTMLElement | null>(null)
const highlightLine = ref<number | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

const range = computed(() => log.activeRange ?? { from: 1, to: 0 })
const count = computed(() => Math.max(0, range.value.to - range.value.from + 1))

/** 虚拟列表：固定 20px 行高，overscan 24 行够快速滚动时不露白 */
const virtualizer = useVirtualizer(
  computed(() => ({
    count: count.value,
    getScrollElement: () => scroller.value,
    estimateSize: () => 20,
    overscan: 24,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())

/** 搜索命中的行集合（用于行背景） */
const hitSet = computed(() => new Set(log.searchHits))

const pickFrom = computed(() => {
  const r = log.quoteRange
  return r === null ? null : r.from
})
const pickTo = computed(() => {
  const r = log.quoteRange
  return r === null ? null : r.to
})

function lineAt(index: number): number {
  return range.value.from + index
}

/** 跳转：把 1 基行号换成当前节内的索引 */
function scrollToLine(line: number, highlight = true): void {
  const idx = line - range.value.from
  if (idx < 0) return
  virtualizer.value.scrollToIndex(idx, { align: 'center' })
  if (highlight) {
    highlightLine.value = line
    if (highlightTimer !== null) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      highlightLine.value = null
    }, 2200)
  }
}

watch(
  () => log.focusLine,
  (line) => {
    if (line === null) return
    void nextTick(() => scrollToLine(line))
  },
)

function onPick(line: number): void {
  log.pickLine(line)
}

function onSubmitSearch(): void {
  log.runSearch()
}

function clearSearch(): void {
  log.searchQuery = ''
  log.searchHits = []
  log.searchIndex = 0
}

const searchLabel = computed(() => {
  if (log.searchQuery.trim() === '') return ''
  if (log.searchHits.length === 0) return '无命中'
  return `${log.searchIndex + 1} / ${log.searchHits.length}`
})

/** 供父组件在打开面板时定位 */
defineExpose({ scrollToLine })
</script>

<template>
  <div class="viewer">
    <!-- 分节 -->
    <div v-if="log.sections.length > 1" class="sections" role="tablist" aria-label="日志分节">
      <button
        type="button"
        role="tab"
        class="sections__tab"
        :class="{ 'sections__tab--active': log.activeSection === null }"
        :aria-selected="log.activeSection === null"
        @click="log.selectSection(null)"
      >
        全部
        <span class="num">{{ log.totalLines }}</span>
      </button>
      <button
        v-for="section in log.sections"
        :key="section.start"
        type="button"
        role="tab"
        class="sections__tab"
        :class="{ 'sections__tab--active': log.activeSection === section.start }"
        :aria-selected="log.activeSection === section.start"
        :title="section.name"
        @click="log.selectSection(section.start)"
      >
        {{ section.role }}
        <span class="num">{{ section.end - section.start + 1 }}</span>
      </button>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar__nav">
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="上一处错误"
          title="上一处错误"
          @click="log.goError(-1)"
        >
          <ChevronUp :size="14" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="下一处错误"
          title="下一处错误"
          @click="log.goError(1)"
        >
          <ChevronDown :size="14" aria-hidden="true" />
        </button>
        <span class="counts num" aria-label="错误与警告数量">
          <span class="counts__err">{{ log.parsed?.counts.error ?? 0 }}</span> 错
          <span class="counts__warn">{{ log.parsed?.counts.warn ?? 0 }}</span> 警
        </span>
      </div>

      <form class="search" role="search" @submit.prevent="onSubmitSearch">
        <Search :size="12" class="search__icon" aria-hidden="true" />
        <input
          v-model="log.searchQuery"
          type="search"
          class="search__input"
          placeholder="日志内搜索"
          aria-label="日志内搜索"
          @keydown.enter.prevent="onSubmitSearch"
        />
        <span v-if="searchLabel !== ''" class="search__label num">{{ searchLabel }}</span>
        <template v-if="log.searchHits.length > 0">
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="上一处命中"
            @click="log.nextSearchHit(-1)"
          >
            <ChevronUp :size="12" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="下一处命中"
            @click="log.nextSearchHit(1)"
          >
            <ChevronDown :size="12" aria-hidden="true" />
          </button>
        </template>
        <button
          v-if="log.searchQuery !== ''"
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="清除搜索"
          @click="clearSearch"
        >
          <X :size="12" aria-hidden="true" />
        </button>
      </form>
    </div>

    <!-- 行区 -->
    <div ref="scroller" class="lines" tabindex="0">
      <div
        class="lines__sizer"
        :style="{ height: `${virtualizer.getTotalSize()}px` }"
      >
        <LogLine
          v-for="row in virtualRows"
          :key="String(row.key)"
          :line-no="lineAt(row.index)"
          :text="log.parsed?.lines[lineAt(row.index) - 1] ?? ''"
          :severity="log.parsed?.severity[lineAt(row.index) - 1] ?? 'plain'"
          :picked="pickFrom !== null && pickTo !== null && lineAt(row.index) >= pickFrom && lineAt(row.index) <= pickTo"
          :pick-edge="lineAt(row.index) === pickFrom || lineAt(row.index) === pickTo"
          :is-hit="hitSet.has(lineAt(row.index))"
          :highlight="highlightLine === lineAt(row.index)"
          :style="{ transform: `translateY(${row.start}px)` }"
          @pick="onPick"
        />
      </div>
    </div>

    <!-- 底部状态 -->
    <div class="status">
      <span class="num">{{ log.activeRange?.from ?? 1 }}–{{ log.activeRange?.to ?? 0 }} / {{ log.totalLines }}</span>
      <span v-if="log.quoteRange !== null" class="status__pick">
        已选 {{ log.quoteRange.from }}–{{ log.quoteRange.to }}（{{ log.quoteRange.to - log.quoteRange.from + 1 }} 行）
      </span>
      <span v-else class="status__hint">点行选起点，再点一次选终点</span>
      <button
        v-if="log.quoteRange !== null"
        type="button"
        class="btn btn--ghost btn--sm"
        @click="log.clearPick()"
      >
        清除选择
      </button>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.sections {
  display: flex;
  gap: 2px;
  padding: 6px 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--rule);
  scrollbar-width: none;
}

.sections::-webkit-scrollbar {
  display: none;
}

.sections__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  flex: none;
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.sections__tab .num {
  color: var(--ink-4);
  font-size: 10px;
}

.sections__tab:hover {
  color: var(--ink);
  background: var(--paper-inset);
}

.sections__tab--active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.sections__tab--active .num {
  color: var(--accent-ink);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 5px 8px;
  border-bottom: 1px solid var(--rule);
}

.toolbar__nav {
  display: flex;
  align-items: center;
  gap: 1px;
  flex: none;
}

.counts {
  margin-left: 4px;
  color: var(--ink-4);
  font-size: 10px;
  white-space: nowrap;
}

.counts__err {
  color: var(--danger);
}

.counts__warn {
  margin-left: 4px;
  color: var(--warn);
}

.search {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-control);
  background: var(--paper-raised);
}

.search:focus-within {
  border-color: var(--accent);
}

.search__icon {
  flex: none;
  color: var(--ink-4);
}

.search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-size: var(--fs-micro);
  outline: none;
}

.search__input::placeholder {
  color: var(--ink-4);
}

.search__label {
  flex: none;
  color: var(--ink-4);
  font-size: 10px;
}

.lines {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--paper-sunken);
}

.lines__sizer {
  position: relative;
  width: max-content;
  min-width: 100%;
}

.status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 8px;
  border-top: 1px solid var(--rule);
  color: var(--ink-4);
  font-size: 10px;
  white-space: nowrap;
  overflow-x: auto;
}

.status__pick {
  color: var(--accent);
}

.status__hint {
  color: var(--ink-4);
}

.status .btn {
  margin-left: auto;
}
</style>
