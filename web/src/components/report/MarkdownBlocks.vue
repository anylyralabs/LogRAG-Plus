<script setup lang="ts">
/**
 * 块级 Markdown 渲染。
 *
 * marked 只负责词法分析（`marked.lexer`），这里把 token 渲染成 DOM。
 * 引用的嵌套用组件自引用实现。
 */
import { computed } from 'vue'
import type { Block } from '@/lib/markdown'
import MarkdownInline from './MarkdownInline.vue'

const props = defineProps<{ blocks: Block[] }>()

/** 长代码块默认折叠：日志分析里代码块动辄几十行，展开会淹没正文 */
const COLLAPSE_LINES = 24

const expanded = defineModel<Record<number, boolean>>('expanded', { default: () => ({}) })

const normalized = computed(() => props.blocks)

function lineCount(content: string): number {
  return content.split('\n').length
}

function toggle(index: number): void {
  expanded.value = { ...expanded.value, [index]: !expanded.value[index] }
}
</script>

<template>
  <template v-for="(block, i) in normalized" :key="i">
    <h1 v-if="block.kind === 'heading' && block.level <= 2" class="md-h md-h1">
      <MarkdownInline :nodes="block.inline" />
    </h1>
    <h2 v-else-if="block.kind === 'heading' && block.level === 3" class="md-h md-h2">
      <MarkdownInline :nodes="block.inline" />
    </h2>
    <h3 v-else-if="block.kind === 'heading'" class="md-h md-h3">
      <MarkdownInline :nodes="block.inline" />
    </h3>

    <p v-else-if="block.kind === 'paragraph'" class="md-p">
      <MarkdownInline :nodes="block.inline" />
    </p>

    <ul v-else-if="block.kind === 'list' && !block.ordered" class="md-list">
      <li v-for="(item, j) in block.items" :key="j" :class="{ 'md-task': item.checked !== null }">
        <span v-if="item.checked !== null" class="md-check" aria-hidden="true">
          {{ item.checked ? '✓' : '·' }}
        </span>
        <MarkdownBlocks :blocks="item.blocks" :expanded="expanded" />
      </li>
    </ul>
    <ol
      v-else-if="block.kind === 'list'"
      class="md-list md-list--ordered"
      :start="block.start"
    >
      <li v-for="(item, j) in block.items" :key="j">
        <MarkdownBlocks :blocks="item.blocks" :expanded="expanded" />
      </li>
    </ol>

    <figure v-else-if="block.kind === 'code'" class="md-code">
      <figcaption v-if="block.lang !== ''" class="md-code__lang">{{ block.lang }}</figcaption>
      <pre
        :class="{
          'md-code__body--clamped':
            lineCount(block.content) > COLLAPSE_LINES && expanded[i] !== true,
        }"
      >{{ block.content }}</pre>
      <button
        v-if="lineCount(block.content) > COLLAPSE_LINES"
        type="button"
        class="md-code__more"
        @click="toggle(i)"
      >
        {{ expanded[i] === true ? '收起' : `展开全部 ${lineCount(block.content)} 行` }}
      </button>
    </figure>

    <blockquote v-else-if="block.kind === 'quote'" class="md-quote">
      <MarkdownBlocks :blocks="block.blocks" :expanded="expanded" />
    </blockquote>

    <div v-else-if="block.kind === 'table'" class="md-table-wrap">
      <table class="md-table">
        <thead>
          <tr>
            <th v-for="(cell, j) in block.head" :key="j"><MarkdownInline :nodes="cell" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, j) in block.rows" :key="j">
            <td v-for="(cell, k) in row" :key="k"><MarkdownInline :nodes="cell" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <hr v-else-if="block.kind === 'hr'" class="md-hr" />
  </template>
</template>

<style scoped>
/*
 * Markdown 标题只用来**分节**，不该抢过判定那句根因。
 * 因此三级统一压在小字级：h1 16px / h2 15px / h3 13px，主要靠上间距区分层次。
 */
.md-h {
  margin-top: 24px;
  margin-bottom: 8px;
}

.md-h:first-child {
  margin-top: 0;
}

.md-h1 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.md-h2 {
  font-size: 15px;
  font-weight: 600;
}

.md-h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  letter-spacing: 0.01em;
}

.md-p {
  margin: 8px 0;
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
}

.md-p:first-child {
  margin-top: 0;
}

.md-list {
  margin: 8px 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.md-list li {
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
}

.md-list--ordered {
  list-style: decimal;
}

.md-list:not(.md-list--ordered) {
  list-style: disc;
}

.md-task {
  list-style: none;
  margin-left: -1.35em;
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.md-check {
  color: var(--accent);
  font-family: var(--font-mono);
}

/* 代码块：淡底 + 圆角，不画边框（整页已经有足够多的线了） */
.md-code {
  margin: 16px 0;
  border-radius: var(--radius-control);
  background: var(--paper-inset);
  overflow: hidden;
}

.md-code__lang {
  padding: 6px 12px;
  color: var(--ink-4);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-transform: lowercase;
}

.md-code pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  color: var(--ink-2);
  white-space: pre;
}

.md-code__body--clamped {
  max-height: 320px;
  overflow-y: hidden;
}

.md-code__more {
  width: 100%;
  padding: 6px;
  border-top: 1px solid var(--rule);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.md-code__more:hover {
  color: var(--accent);
  background: var(--paper-inset);
}

.md-quote {
  margin: var(--sp-3) 0;
  padding-left: var(--sp-3);
  border-left: 2px solid var(--accent-line);
  color: var(--ink-2);
}

.md-table-wrap {
  margin: var(--sp-3) 0;
  overflow-x: auto;
  border: 1px solid var(--rule);
}

.md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-meta);
}

.md-table th,
.md-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}

.md-table th {
  background: var(--paper-sunken);
  color: var(--ink-2);
  font-weight: 600;
  white-space: nowrap;
}

.md-table tr:last-child td {
  border-bottom: 0;
}

.md-hr {
  margin: var(--sp-5) 0;
  border: 0;
  border-top: 1px solid var(--rule);
}
</style>
