<script setup lang="ts">
/**
 * 行内 Markdown 渲染。
 *
 * **全程不用 `v-html`**：文本节点交给 Vue 模板输出，默认转义。
 * 链接已经过 `safeHref` 白名单（只允许 http/https/mailto），
 * 因此这里可以放心绑定 `href`。
 */
import type { Inline } from '@/lib/markdown'

defineProps<{ nodes: Inline[] }>()
</script>

<template>
  <template v-for="(node, i) in nodes" :key="i">
    <code v-if="node.kind === 'code'" class="inline-code">{{ node.text }}</code>
    <strong v-else-if="node.kind === 'strong'" class="inline-strong">
      <MarkdownInline :nodes="node.children" />
    </strong>
    <em v-else-if="node.kind === 'em'">
      <MarkdownInline :nodes="node.children" />
    </em>
    <del v-else-if="node.kind === 'del'">
      <MarkdownInline :nodes="node.children" />
    </del>
    <a
      v-else-if="node.kind === 'link'"
      :href="node.href"
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <MarkdownInline :nodes="node.children" />
    </a>
    <br v-else-if="node.kind === 'br'" />
    <template v-else>{{ node.text }}</template>
  </template>
</template>

<style scoped>
/*
 * 行内代码：淡底 pill。
 * 早先是 1px 边框 + 2px 圆角的小方块，一屏里出现十几次，像贴了一堆标签。
 */
.inline-code {
  padding: 1.5px 5px;
  border-radius: 4px;
  background: var(--paper-inset);
  color: var(--accent-ink);
  font-size: 0.9em;
  word-break: break-word;
}

.inline-strong {
  font-weight: 600;
  color: var(--ink);
}

a {
  word-break: break-word;
}
</style>
