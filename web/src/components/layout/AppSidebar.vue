<script setup lang="ts">
/**
 * 会话栏。
 *
 * 本地历史（后端没有「列出我的会话」接口，无登录下也不该有）。
 * 分组按「今天 / 近七天 / 更早」，与主流 Agent 产品的会话栏一致，
 * 但标题只用首条提问，**绝不存储日志正文**。
 */
import { computed, onMounted } from 'vue'
import { MessageSquare, Plus, Trash2, X } from 'lucide-vue-next'
import type { HistoryEntry } from '@/lib/history'
import { useHistoryStore } from '@/stores/history'

const props = defineProps<{
  activeSessionId?: string
  activeLogId?: string
  /** 窄屏抽屉：显示关闭按钮 */
  closable?: boolean
}>()

const emit = defineEmits<{
  select: [entry: HistoryEntry]
  new: []
  close: []
}>()

const history = useHistoryStore()
const entries = computed(() => history.entries)

onMounted(() => history.refresh())

const groups = computed(() => {
  const now = Date.now()
  const day = 24 * 3600 * 1000
  const today: HistoryEntry[] = []
  const week: HistoryEntry[] = []
  const older: HistoryEntry[] = []

  for (const entry of entries.value) {
    const age = now - entry.updatedAt
    if (age < day) today.push(entry)
    else if (age < 7 * day) week.push(entry)
    else older.push(entry)
  }

  return [
    { label: '今天', items: today },
    { label: '近七天', items: week },
    { label: '更早', items: older },
  ].filter((g) => g.items.length > 0)
})

function isActive(entry: HistoryEntry): boolean {
  if (props.activeSessionId !== undefined && props.activeSessionId !== '') {
    return entry.sessionId === props.activeSessionId
  }
  return props.activeLogId !== undefined && entry.logId === props.activeLogId
}

function remove(entry: HistoryEntry, event: Event): void {
  event.stopPropagation()
  history.remove(entry.sessionId)
}

function clearAll(): void {
  if (!confirm('清空本机保存的会话记录？服务端的会话不会被删除，但之后无法从这里找回。')) return
  history.clear()
}

function timeLabel(ts: number): string {
  if (ts === 0) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <nav class="sidebar" aria-label="会话">
    <div class="sidebar__head">
      <span class="label label--plain">会话</span>
      <button
        v-if="closable === true"
        type="button"
        class="btn btn--ghost btn--icon btn--sm only-narrow"
        aria-label="关闭会话栏"
        @click="emit('close')"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </div>

    <button type="button" class="new" @click="emit('new')">
      <Plus :size="14" aria-hidden="true" />
      新建分析
    </button>

    <div class="sidebar__list">
      <div v-if="entries.length === 0" class="sidebar__empty">
        还没有会话。分析过的日志会出现在这里，保存在本机浏览器。
      </div>

      <section v-for="group in groups" :key="group.label" class="group">
        <h2 class="group__label">{{ group.label }}</h2>
        <button
          v-for="entry in group.items"
          :key="entry.sessionId"
          type="button"
          class="entry"
          :class="{ 'entry--active': isActive(entry) }"
          @click="emit('select', entry)"
        >
          <MessageSquare :size="12" class="entry__icon" aria-hidden="true" />
          <span class="entry__body">
            <span class="entry__title">{{ entry.title }}</span>
            <span class="entry__meta num">
              <template v-if="entry.logId !== null">{{ entry.logId }}</template>
              <template v-else>纯对话</template>
              <template v-if="timeLabel(entry.updatedAt) !== ''"> · {{ timeLabel(entry.updatedAt) }}</template>
            </span>
          </span>
          <span
            class="entry__remove"
            role="button"
            tabindex="0"
            aria-label="从本机历史移除"
            @click="remove(entry, $event)"
            @keydown.enter.prevent="remove(entry, $event)"
          >
            <Trash2 :size="11" aria-hidden="true" />
          </span>
        </button>
      </section>
    </div>

    <footer class="sidebar__foot">
      <span class="sidebar__note">历史仅存本机</span>
      <button
        v-if="entries.length > 0"
        type="button"
        class="btn btn--ghost btn--sm"
        @click="clearAll"
      >
        清空
      </button>
    </footer>
  </nav>
</template>

<style scoped>
/* 会话栏留在画布上：无底色、无边框，靠间距与选中态的淡底区分 */
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: transparent;
  padding: 0 var(--sp-2) 0 0;
}

.sidebar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 8px 8px;
}

.sidebar__head .label {
  flex: 1;
}

.new {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 4px 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--paper-raised);
  box-shadow: var(--shadow-sm);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  font-weight: 500;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.new:hover {
  background: var(--paper-raised);
  color: var(--accent);
  box-shadow: 0 2px 6px rgba(28, 27, 22, 0.08);
}

.sidebar__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 0 4px;
}

.sidebar__empty {
  padding: var(--sp-4) var(--sp-3);
  color: var(--ink-4);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.group {
  margin-bottom: var(--sp-3);
}

.group__label {
  padding: 8px 8px 5px;
  color: var(--ink-4);
  font-size: var(--fs-micro);
  font-weight: 500;
  letter-spacing: 0.03em;
}

.entry {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 9px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
  text-align: left;
  transition: background var(--dur) var(--ease);
}

.entry:hover {
  background: rgba(0, 0, 0, 0.028);
}

.entry--active {
  background: var(--paper-raised);
  color: var(--ink);
  box-shadow: var(--shadow-sm);
}

.entry--active .entry__title {
  font-weight: 500;
}

.entry__icon {
  flex: none;
  margin-top: 3px;
  color: var(--ink-4);
}

.entry__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.entry__title {
  overflow: hidden;
  font-size: var(--fs-meta);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry__meta {
  color: var(--ink-4);
  font-size: 10.5px;
}

.entry__remove {
  flex: none;
  padding: 3px;
  border-radius: var(--radius);
  color: var(--ink-4);
  opacity: 0;
}

.entry:hover .entry__remove,
.entry__remove:focus-visible {
  opacity: 1;
}

.entry__remove:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

.sidebar__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 8px 4px;
}

.sidebar__note {
  flex: 1;
  color: var(--ink-4);
  font-size: 10px;
}
</style>
