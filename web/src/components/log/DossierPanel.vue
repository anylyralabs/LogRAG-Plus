<script setup lang="ts">
/**
 * 案卷面板：日志 + 证据 + 材料信息。
 *
 * 参考 Claude 的右侧文档面板：对话是推理轨迹，右侧是被检查的对象。
 * 宽屏常驻，窄屏变成全屏 Sheet。
 */
import { computed, ref } from 'vue'
import { AlertTriangle, FileText, RefreshCw, Unlink, X } from 'lucide-vue-next'
import LogViewer from './LogViewer.vue'
import { useLogStore } from '@/stores/log'

defineProps<{
  /** 窄屏模式：显示关闭按钮 */
  closable?: boolean
}>()

const emit = defineEmits<{
  close: []
  quote: [{ label: string; text: string }]
  unbind: []
}>()

const log = useLogStore()
const busyQuoting = ref(false)

const createdAt = computed(() => {
  const ts = log.meta?.createdAt ?? 0
  if (ts <= 0) return ''
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
})

const docBytes = computed(() => {
  const bytes = log.doc?.bytes ?? 0
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

function quote(): void {
  const built = log.buildQuote()
  if (built === null) return
  busyQuoting.value = true
  emit('quote', built)
  log.clearPick()
  setTimeout(() => (busyQuoting.value = false), 200)
}

function reload(): void {
  if (log.logId !== '') void log.load(log.logId, { force: true })
}
</script>

<template>
  <aside class="dossier">
    <header class="dossier__head">
      <div class="dossier__title">
        <FileText :size="14" aria-hidden="true" />
        <span class="label label--plain">材料</span>
        <code class="dossier__name">{{ log.doc?.name ?? (log.logId === '' ? '未绑定' : log.logId) }}</code>
      </div>

      <div class="dossier__actions">
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="刷新日志"
          title="重新读取合并后的正文"
          :disabled="log.loading || log.logId === ''"
          @click="reload"
        >
          <RefreshCw :size="13" aria-hidden="true" :class="{ spin: log.loading }" />
        </button>
        <button
          v-if="log.logId !== ''"
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="解除日志绑定"
          title="解除绑定"
          @click="emit('unbind')"
        >
          <Unlink :size="13" aria-hidden="true" />
        </button>
        <button
          v-if="closable === true"
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          aria-label="关闭案卷"
          @click="emit('close')"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="dossier__meta">
      <span v-if="log.meta?.source" class="badge">{{ log.meta.source }}</span>
      <span v-if="createdAt !== ''" class="num">{{ createdAt }}</span>
      <span v-if="docBytes !== ''" class="num">{{ docBytes }}</span>
      <span v-if="log.doc?.truncated === true" class="badge badge--warn">面板只显示前 2MB</span>
      <span v-if="(log.meta?.appended ?? 0) > 0" class="badge">含 {{ log.meta?.appended }} 段追加</span>
    </div>

    <p v-if="log.meta?.note !== undefined" class="dossier__note">
      <AlertTriangle :size="12" aria-hidden="true" />
      {{ log.meta.note }}
    </p>

    <p v-if="log.meta !== null && log.meta.omitted.length > 0" class="dossier__omitted">
      <AlertTriangle :size="12" aria-hidden="true" />
      以下附件因总量预算未显示：{{ log.meta.omitted.join('、') }}
    </p>

    <div v-if="log.loading || log.parsePending" class="dossier__state">
      <span class="dot dot--live" aria-hidden="true" />
      正在读取与解析日志…
    </div>

    <div v-else-if="log.error !== ''" class="dossier__state dossier__state--error">
      <span>{{ log.error }}</span>
      <button type="button" class="btn btn--sm" @click="reload">重试</button>
    </div>

    <LogViewer v-else-if="log.parsed !== null" />

    <div v-else class="empty">还没有材料。绑定日志后这里会显示原文。</div>

    <footer v-if="log.quoteRange !== null" class="dossier__foot">
      <span class="dossier__pick num">
        {{ log.quoteRange.from }}–{{ log.quoteRange.to }}
      </span>
      <button type="button" class="btn btn--primary btn--sm" :disabled="busyQuoting" @click="quote">
        引用到对话
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.dossier {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--paper);
}

.dossier__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 10px;
  border-bottom: 1px solid var(--rule);
}

.dossier__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ink-3);
}

.dossier__name {
  overflow: hidden;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dossier__actions {
  display: flex;
  gap: 1px;
  margin-left: auto;
}

.dossier__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding: 5px 10px;
  border-bottom: 1px solid var(--rule);
  color: var(--ink-4);
  font-size: 10px;
}

.dossier__omitted {
  display: flex;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.dossier__note {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.dossier__state {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-4);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.dossier__state--error {
  color: var(--warn);
  flex-wrap: wrap;
}

.dossier__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 7px 10px;
  border-top: 1px solid var(--rule);
  background: var(--paper-raised);
}

.dossier__pick {
  color: var(--accent);
  font-size: var(--fs-micro);
}

.dossier__foot .btn {
  margin-left: auto;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
