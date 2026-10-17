<script setup lang="ts">
/**
 * 极简 Markdown 渲染。
 *
 * **全程不使用 `v-html`**。原因不是洁癖：模型输出里必然混着用户日志原文，
 * 而日志里出现 `<`、`&` 乃至用户自己贴的 HTML 片段是常态；一旦走 `innerHTML`，
 * 就多了一条「日志内容 → 任意脚本执行」的路径。这里把文本解析成结构化节点后
 * 由 Vue 模板渲染，Vue 默认转义，从机制上不可能注入。
 *
 * 解析器与视图模型在 `lib/structured.ts`（纯函数、可单测），本组件只做呈现；
 * 视图模型刻意拍平了联合类型，所以模板里没有任何类型断言。
 *
 * 标题渲染成**真的 `h3`/`h4` 元素**（而不是带样式的 `p`）：这份输出是一篇
 * 有结构的报告，读屏器需要靠标题层级跳读；样式由 base.css 的标题规则统一给。
 */
import { computed } from 'vue';
import { toViewBlocks } from '../lib/structured.ts';

const props = defineProps<{ text: string }>();

const blocks = computed(() => toViewBlocks(props.text));
</script>

<template>
  <div class="md">
    <template v-for="(block, i) in blocks" :key="i">
      <pre v-if="block.kind === 'code'" class="md-code"><code>{{ block.text }}</code></pre>

      <component
        :is="block.level <= 2 ? 'h3' : 'h4'"
        v-else-if="block.kind === 'h'"
        class="md-h"
      >
        <template v-for="(inline, j) in block.inlines" :key="j">
          <code v-if="inline.t === 'code'" class="md-inline-code">{{ inline.v }}</code>
          <strong v-else-if="inline.t === 'strong'">{{ inline.v }}</strong>
          <span v-else>{{ inline.v }}</span>
        </template>
      </component>

      <blockquote v-else-if="block.kind === 'quote'" class="md-quote">
        <template v-for="(inline, j) in block.inlines" :key="j">
          <code v-if="inline.t === 'code'" class="md-inline-code">{{ inline.v }}</code>
          <strong v-else-if="inline.t === 'strong'">{{ inline.v }}</strong>
          <span v-else>{{ inline.v }}</span>
        </template>
      </blockquote>

      <ul v-else-if="block.kind === 'ul'" class="md-list">
        <li v-for="(item, j) in block.items" :key="j">
          <template v-for="(inline, k) in item" :key="k">
            <code v-if="inline.t === 'code'" class="md-inline-code">{{ inline.v }}</code>
            <strong v-else-if="inline.t === 'strong'">{{ inline.v }}</strong>
            <span v-else>{{ inline.v }}</span>
          </template>
        </li>
      </ul>

      <ol v-else-if="block.kind === 'ol'" class="md-list">
        <li v-for="(item, j) in block.items" :key="j">
          <template v-for="(inline, k) in item" :key="k">
            <code v-if="inline.t === 'code'" class="md-inline-code">{{ inline.v }}</code>
            <strong v-else-if="inline.t === 'strong'">{{ inline.v }}</strong>
            <span v-else>{{ inline.v }}</span>
          </template>
        </li>
      </ol>

      <p v-else-if="block.kind === 'p'" class="md-p">
        <template v-for="(line, j) in block.lines" :key="j">
          <template v-for="(inline, k) in line" :key="k">
            <code v-if="inline.t === 'code'" class="md-inline-code">{{ inline.v }}</code>
            <strong v-else-if="inline.t === 'strong'">{{ inline.v }}</strong>
            <span v-else>{{ inline.v }}</span>
          </template>
          <br v-if="j < block.lines.length - 1" />
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.md {
  max-width: var(--measure);
  overflow-wrap: anywhere;
}

.md-p,
.md-list,
.md-code,
.md-quote {
  margin: 0 0 var(--s4);
}

.md > :last-child {
  margin-bottom: 0;
}

/* 报告里的标题：等宽、克制。级别差异靠字级与上间距，不靠颜色 */
.md-h {
  margin: var(--s5) 0 var(--s3);
  font-size: var(--t-h5);
  color: var(--text);
}

h4.md-h {
  font-size: var(--t-small);
  color: var(--text-2);
  letter-spacing: 0.02em;
}

.md-list {
  padding-left: var(--s5);
}

.md ol.md-list {
  list-style: decimal;
}

.md-list li {
  margin-bottom: var(--s2);
}

.md-list li::marker {
  color: var(--text-3);
  font-family: var(--font-display);
  font-size: 0.9em;
}

/**
 * 代码块：日志原文多半在这里。等宽、不折行（横向滚动），
 * 底色比页面更深一档——它是「引用进来的外部材料」，与正文分开。
 */
.md-code {
  padding: var(--s3);
  background: var(--bg-deep);
  border: 1px solid var(--line);
  border-left: 3px solid var(--line-3);
  border-radius: var(--r1);
  font-family: var(--font-log);
  font-size: var(--t-caption);
  line-height: var(--lh-log);
  overflow-x: auto;
  white-space: pre;
}

.md-inline-code {
  padding: 1px 4px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r1);
  font-family: var(--font-log);
  font-size: 0.9em;
}

.md-quote {
  padding: var(--s2) var(--s3);
  border-left: 3px solid var(--line-3);
  color: var(--text-2);
}
</style>
