<script setup lang="ts">
/**
 * 注入预览。
 *
 * 管理员最需要确认的事情不是「我写了什么」，而是「它到底以什么形态进入模型」。
 * 这里展示实际拼进系统提示词的原文、被注入/被跳过的条目与字符预算。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/lib/api'
import type { InjectionPreview } from '@/lib/types'

const props = defineProps<{ token: string }>()

const preview = ref<InjectionPreview | null>(null)
const loading = ref(false)
const error = ref('')

const budgetHint = computed(() => {
  if (preview.value === null) return ''
  return `${preview.value.chars} 字，注入 ${preview.value.injected.length} 条，跳过 ${preview.value.skipped.length} 条`
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    preview.value = await api.injectionPreview(props.token)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.token, load)
</script>

<template>
  <section class="preview">
    <header class="preview__head">
      <div class="label">提示词注入预览</div>
      <button type="button" class="btn btn--sm" :disabled="loading" @click="load">刷新</button>
    </header>

    <p class="preview__meta num">{{ budgetHint }}</p>

    <div v-if="error !== ''" class="alert alert--danger">{{ error }}</div>
    <div v-else-if="loading && preview === null" class="preview__state">正在读取…</div>

    <template v-else-if="preview !== null">
      <div v-if="preview.skipped.length > 0" class="skipped">
        <span class="badge badge--warn">未注入 {{ preview.skipped.length }} 条</span>
        <ul>
          <li v-for="item in preview.skipped" :key="item.id">
            <span class="num">{{ item.id }}</span>
            {{ item.content }}
          </li>
        </ul>
      </div>

      <pre class="text">{{ preview.text === '' ? '（当前没有注入任何条目）' : preview.text }}</pre>
    </template>
  </section>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.preview__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.preview__head .label {
  flex: 1;
}

.preview__meta {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.preview__state {
  padding: var(--sp-4);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.text {
  max-height: 320px;
  margin: 0;
  padding: var(--sp-3);
  overflow: auto;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-sunken);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.skipped {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: var(--sp-2);
  background: var(--warn-soft);
}

.skipped ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 1.1em;
  list-style: disc;
  color: var(--warn);
  font-size: var(--fs-micro);
  line-height: 1.65;
}
</style>
