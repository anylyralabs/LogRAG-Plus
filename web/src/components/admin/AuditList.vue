<script setup lang="ts">
/**
 * 审计留痕。
 *
 * 领域知识会直接影响所有用户的结论，属于高危配置项。
 * 这里把「改了什么、谁改的」按时间倒序展示——排查「某天的分析为什么突然变了」
 * 时必须能回答这个问题。
 */
import { computed } from 'vue'
import type { AuditRecord } from '@/lib/types'

const props = defineProps<{ records: AuditRecord[] }>()

const ACTION_LABEL: Record<string, string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
  enable: '启用',
  disable: '停用',
}

const items = computed(() =>
  props.records.map((r) => ({
    ...r,
    label: ACTION_LABEL[r.action] ?? r.action,
    time: new Date(r.at * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  })),
)
</script>

<template>
  <section class="audit">
    <div class="label">变更留痕</div>

    <div v-if="items.length === 0" class="empty">还没有变更记录。</div>

    <ol v-else class="audit__list">
      <li v-for="item in items" :key="item.id" class="audit__item">
        <div class="audit__head">
          <span class="badge" :class="item.action === 'delete' ? 'badge--danger' : ''">{{ item.label }}</span>
          <span class="num audit__id">{{ item.entryId }}</span>
          <span class="audit__actor">{{ item.actor }}</span>
          <span class="num audit__time">{{ item.time }}</span>
        </div>
        <p v-if="item.afterContent !== null" class="audit__content audit__content--after">
          {{ item.afterContent }}
        </p>
        <p v-if="item.beforeContent !== null" class="audit__content audit__content--before">
          {{ item.beforeContent }}
        </p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.audit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.audit__list {
  display: flex;
  flex-direction: column;
  list-style: none;
}

.audit__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--rule);
}

.audit__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  color: var(--ink-4);
  font-size: 10px;
}

.audit__id {
  color: var(--ink-3);
}

.audit__actor {
  color: var(--ink-3);
}

.audit__time {
  margin-left: auto;
}

.audit__content {
  font-size: var(--fs-micro);
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.audit__content--after {
  color: var(--ink-2);
}

.audit__content--before {
  color: var(--ink-4);
  text-decoration: line-through;
}
</style>
