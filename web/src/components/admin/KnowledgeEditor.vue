<script setup lang="ts">
/**
 * 领域知识编辑器。
 *
 * 200 字上限是服务端硬约束（条目会原文注入提示词，不做摘要）。
 * 因此这里用「实时字数 + 超出即禁用保存」，而不是等提交后报错。
 *
 * `/analyze` 是**预检**：判定这段文本是事实、方法论还是无法判定。
 * 方法论应当挪去 `prompts/`，这里给出提醒但不硬拒（决策 D31）。
 */
import { computed, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import ModalShell from '@/components/ui/ModalShell.vue'
import { ApiError, api } from '@/lib/api'
import type { DomainKnowledge, EntryAnalysis, EntryKind } from '@/lib/types'

const props = defineProps<{
  open: boolean
  token: string
  /** 传入表示编辑；null 表示新增 */
  entry: DomainKnowledge | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const MAX_CHARS = 200

const content = ref('')
const enabled = ref(true)
const priority = ref(0)
const tags = ref('')
const kindOverride = ref<EntryKind | ''>('')
const analysis = ref<EntryAnalysis | null>(null)
const analyzing = ref(false)
const saving = ref(false)
const error = ref('')
const warnings = ref<string[]>([])

const chars = computed(() => [...content.value.trim()].length)
const overLimit = computed(() => chars.value > MAX_CHARS)
const valid = computed(() => chars.value > 0 && !overLimit.value && !saving.value)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    error.value = ''
    warnings.value = []
    analysis.value = null
    if (props.entry !== null) {
      content.value = props.entry.content
      enabled.value = props.entry.enabled
      priority.value = props.entry.priority
      tags.value = props.entry.tags.join(', ')
      kindOverride.value = props.entry.kind
    } else {
      content.value = ''
      enabled.value = true
      priority.value = 0
      tags.value = ''
      kindOverride.value = ''
    }
  },
  { immediate: true },
)

async function analyze(): Promise<void> {
  if (content.value.trim() === '') return
  analyzing.value = true
  error.value = ''
  try {
    analysis.value = await api.analyzeDomainKnowledge(content.value, props.token)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '预检失败'
  } finally {
    analyzing.value = false
  }
}

async function save(): Promise<void> {
  if (!valid.value) return
  saving.value = true
  error.value = ''
  warnings.value = []

  const payload = {
    content: content.value.trim(),
    enabled: enabled.value,
    priority: priority.value,
    tags: tags.value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    ...(kindOverride.value !== '' ? { kindOverride: kindOverride.value } : {}),
  }

  try {
    const result =
      props.entry === null
        ? await api.createDomainKnowledge(payload, props.token)
        : await api.updateDomainKnowledge(props.entry.id, payload, props.token)

    if (!result.ok) {
      error.value = result.error ?? '保存失败'
      return
    }
    warnings.value = result.warnings ?? []
    emit('saved')
    if (warnings.value.length === 0) emit('update:open', false)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

const kindLabel: Record<EntryKind, string> = {
  fact: '事实先验',
  method: '方法论',
  unclear: '无法判定',
}
</script>

<template>
  <ModalShell
    :open="open"
    variant="center"
    :title="entry === null ? '新增领域知识' : '编辑领域知识'"
    description="条目会原文拼进系统提示词，直接影响所有用户的分析结论。"
    @update:open="emit('update:open', $event)"
  >
    <div class="editor__head">
      <code class="editor__id">{{ entry?.id ?? '尚未保存' }}</code>
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm"
        aria-label="关闭"
        @click="emit('update:open', false)"
      >
        <X :size="15" aria-hidden="true" />
      </button>
    </div>

    <div class="editor__body">
      <div class="field">
        <div class="editor__label-row">
          <label for="dk-content">条目内容</label>
          <span class="editor__count num" :class="{ 'editor__count--over': overLimit }">
            {{ chars }} / {{ MAX_CHARS }}
          </span>
        </div>
        <textarea
          id="dk-content"
          v-model="content"
          class="textarea"
          rows="5"
          placeholder="例：Mali GPU 在部分机型上不支持 Vulkan 启动，建议先切换到 OpenGL 渲染器。"
        />
        <span class="field-help">
          一行说清一件事。会原文拼进系统提示词，不做摘要——所以不要写长段落。
        </span>
      </div>

      <div class="editor__row">
        <label class="check">
          <input v-model="enabled" type="checkbox" />
          <span>启用（关闭后不注入、也不被 expert_knowledge 检索）</span>
        </label>
      </div>

      <div class="editor__row editor__row--split">
        <div class="field">
          <label for="dk-priority">优先级</label>
          <input id="dk-priority" v-model.number="priority" class="input mono" type="number" step="1" />
          <span class="field-help">越大越靠前注入；低于阈值的只进工具检索。</span>
        </div>
        <div class="field">
          <label for="dk-tags">标签</label>
          <input id="dk-tags" v-model="tags" class="input mono" placeholder="渲染器, Mali" />
          <span class="field-help">逗号分隔，用于分组与检索。</span>
        </div>
      </div>

      <div class="field">
        <label for="dk-kind">性质</label>
        <select id="dk-kind" v-model="kindOverride" class="select">
          <option value="">按内容自动判定</option>
          <option value="fact">事实先验</option>
          <option value="method">方法论</option>
          <option value="unclear">无法判定</option>
        </select>
        <span class="field-help">方法论应放在 <code>prompts/</code>，这里只提醒、不硬拒。</span>
      </div>

      <div class="editor__analyze">
        <button
          type="button"
          class="btn btn--sm"
          :disabled="analyzing || content.trim() === ''"
          @click="analyze"
        >
          {{ analyzing ? '判定中…' : '预检性质' }}
        </button>
        <div v-if="analysis !== null" class="analysis">
          <span class="badge" :class="analysis.kind === 'method' ? 'badge--warn' : 'badge--accent'">
            {{ kindLabel[analysis.kind] }}
          </span>
          <span class="num">{{ analysis.chars }} 字</span>
          <ul v-if="analysis.warnings.length > 0" class="analysis__warnings">
            <li v-for="(w, i) in analysis.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>
      </div>

      <p v-if="overLimit" class="alert alert--danger">
        超出 {{ chars - MAX_CHARS }} 字。条目会原文注入提示词，超长会挤占预算，请压缩。
      </p>
      <p v-if="error !== ''" class="alert alert--danger">{{ error }}</p>
      <div v-if="warnings.length > 0" class="alert alert--warn">
        <ul>
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
      </div>
    </div>

    <footer class="editor__foot">
      <button type="button" class="btn" @click="emit('update:open', false)">取消</button>
      <span class="editor__spacer" />
      <button type="button" class="btn btn--primary" :disabled="!valid" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </footer>
  </ModalShell>
</template>

<style scoped>
/* 容器/遮罩/标题由 ModalShell 提供 */

.editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px 14px;
  border-bottom: 1px solid var(--rule);
}

.editor__id {
  color: var(--ink-4);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.editor__body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
}

.editor__label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.editor__count {
  color: var(--ink-4);
  font-size: 10px;
}

.editor__count--over {
  color: var(--danger);
}

.editor__row--split {
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: var(--sp-3);
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.6;
  cursor: pointer;
}

.check input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.editor__analyze {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--rule);
}

.analysis {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.analysis__warnings {
  flex-basis: 100%;
  padding-left: 1.1em;
  list-style: disc;
  color: var(--warn);
  line-height: 1.6;
}

.editor__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
}

.editor__spacer {
  flex: 1;
}

.alert ul {
  padding-left: 1.1em;
  list-style: disc;
}

@media (max-width: 599px) {
  .editor__row--split {
    grid-template-columns: 1fr;
  }
}
</style>
