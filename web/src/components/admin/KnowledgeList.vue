<script setup lang="ts">
/**
 * 领域知识列表。
 *
 * 信息密度可以高，但结构必须与前台的卷宗语言同源：栏目标记、发丝线、
 * 等宽元信息。管理面不是另一个产品。
 */
import { computed, ref } from 'vue'
import { Pencil, Plus, Search, Trash2 } from 'lucide-vue-next'
import type { DomainKnowledge, EntryKind } from '@/lib/types'

const props = defineProps<{
  entries: DomainKnowledge[]
  busy: boolean
  keyword: string
}>()

const emit = defineEmits<{
  edit: [entry: DomainKnowledge]
  create: []
  remove: [entry: DomainKnowledge]
  'update:keyword': [value: string]
  filter: [kind: EntryKind | '']
}>()

const kindFilter = ref<EntryKind | ''>('')

const filtered = computed(() =>
  kindFilter.value === '' ? props.entries : props.entries.filter((e) => e.kind === kindFilter.value),
)

const kindLabel: Record<EntryKind, string> = {
  fact: '事实',
  method: '方法论',
  unclear: '未判定',
}

function setKind(value: EntryKind | ''): void {
  kindFilter.value = value
}

function removed(entry: DomainKnowledge): void {
  if (!confirm(`删除这条领域知识？\n\n${entry.content.slice(0, 80)}`)) return
  emit('remove', entry)
}

function dateOf(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
</script>

<template>
  <section class="knowledge">
    <header class="knowledge__head">
      <div class="label">领域知识</div>
      <button type="button" class="btn btn--primary btn--sm" @click="emit('create')">
        <Plus :size="13" aria-hidden="true" />
        新增
      </button>
    </header>

    <div class="knowledge__tools">
      <div class="search">
        <Search :size="12" class="search__icon" aria-hidden="true" />
        <input
          :value="keyword"
          type="search"
          class="search__input"
          placeholder="按关键词过滤（服务端）"
          @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="kinds" role="group" aria-label="按性质过滤">
        <button
          type="button"
          class="kinds__item"
          :class="{ 'kinds__item--active': kindFilter === '' }"
          @click="setKind('')"
        >
          全部
        </button>
        <button
          type="button"
          class="kinds__item"
          :class="{ 'kinds__item--active': kindFilter === 'fact' }"
          @click="setKind('fact')"
        >
          事实
        </button>
        <button
          type="button"
          class="kinds__item"
          :class="{ 'kinds__item--active': kindFilter === 'method' }"
          @click="setKind('method')"
        >
          方法论
        </button>
        <button
          type="button"
          class="kinds__item"
          :class="{ 'kinds__item--active': kindFilter === 'unclear' }"
          @click="setKind('unclear')"
        >
          未判定
        </button>
      </div>
    </div>

    <div v-if="busy" class="knowledge__state">
      <span class="dot dot--live" aria-hidden="true" />
      正在加载…
    </div>

    <div v-else-if="filtered.length === 0" class="empty">没有匹配的条目。</div>

    <ul v-else class="entries">
      <li v-for="entry in filtered" :key="entry.id" class="entry" :class="{ 'entry--disabled': !entry.enabled }">
        <div class="entry__main">
          <p class="entry__content">{{ entry.content }}</p>
          <div class="entry__meta">
            <span class="badge" :class="entry.kind === 'method' ? 'badge--warn' : ''">
              {{ kindLabel[entry.kind] }}
            </span>
            <span v-if="!entry.enabled" class="badge">已停用</span>
            <span class="num">优先级 {{ entry.priority }}</span>
            <span v-if="entry.tags.length > 0" class="entry__tags mono">
              {{ entry.tags.join(' · ') }}
            </span>
            <span class="num entry__id">{{ entry.id }}</span>
            <span class="num">{{ dateOf(entry.updatedAt) }}</span>
          </div>
        </div>
        <div class="entry__actions">
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="编辑"
            @click="emit('edit', entry)"
          >
            <Pencil :size="13" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm entry__remove"
            aria-label="删除"
            @click="removed(entry)"
          >
            <Trash2 :size="13" aria-hidden="true" />
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.knowledge {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
}

.knowledge__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.knowledge__head .label {
  flex: 1;
}

.knowledge__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 160px;
  height: 28px;
  padding: 0 7px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-control);
  background: var(--paper-raised);
}

.search:focus-within {
  border-color: var(--accent);
}

.search__icon {
  color: var(--ink-4);
  flex: none;
}

.search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: var(--fs-micro);
}

.kinds {
  display: flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius-control);
  overflow: hidden;
  flex: none;
}

.kinds__item {
  padding: 4px 8px;
  border-right: 1px solid var(--rule);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kinds__item:last-child {
  border-right: 0;
}

.kinds__item--active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.knowledge__state {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--sp-4);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.entries {
  display: flex;
  flex-direction: column;
  list-style: none;
}

.entry {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--rule);
}

.entry--disabled .entry__content {
  color: var(--ink-4);
  text-decoration: line-through;
}

.entry__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.entry__content {
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.entry__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  color: var(--ink-4);
  font-size: 10px;
}

.entry__tags {
  color: var(--ink-3);
}

.entry__id {
  color: var(--ink-4);
}

.entry__actions {
  display: flex;
  gap: 1px;
  flex: none;
}

.entry__remove:hover {
  color: var(--danger);
}
</style>
