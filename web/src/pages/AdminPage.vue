<script setup lang="ts">
/**
 * 管理台。
 *
 * 与对话页同一套排版语言：栏目标记 + 发丝线 + 等宽元信息，不用卡片。
 * 它是后台，信息密度可以高，但结构必须与前台同源——两份界面长得不一样，
 * 用户会以为是两个产品。
 *
 * 两个页签：
 *  - 领域知识：原文注入提示词，直接影响所有用户的结论；
 *  - 分析记录：评分看板与低分样本复核。
 */
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, LogOut, RefreshCw } from 'lucide-vue-next'

import AdminGate from '@/components/admin/AdminGate.vue'
import AuditList from '@/components/admin/AuditList.vue'
import InjectionPreview from '@/components/admin/InjectionPreview.vue'
import KnowledgeEditor from '@/components/admin/KnowledgeEditor.vue'
import KnowledgeList from '@/components/admin/KnowledgeList.vue'
import RecordDetail from '@/components/admin/RecordDetail.vue'
import RecordsBoard from '@/components/admin/RecordsBoard.vue'
import { useAdminStore } from '@/stores/admin'
import type { AnalysisRecord, DomainKnowledge } from '@/lib/types'

const admin = useAdminStore()

const tab = ref<'knowledge' | 'records'>('knowledge')
const keyword = ref('')
const editorOpen = ref(false)
const editing = ref<DomainKnowledge | null>(null)
const detail = ref<AnalysisRecord | null>(null)
const notice = ref('')
const showAudit = ref(false)

const statsLine = computed(() => {
  const s = admin.stats
  if (s === null) return ''
  return `${s.total} 条 · 启用 ${s.enabled} · 方法论 ${s.methodLike} · 注入 ${s.injectedChars} 字 / ${s.injectedCount} 条`
})

onMounted(async () => {
  admin.loadToken()
  if (admin.token !== '') {
    const ok = await admin.verify()
    if (ok) await loadAll()
  }
})

async function loadAll(): Promise<void> {
  await Promise.all([admin.loadKnowledge(), admin.loadRecords(), admin.loadRecordsStats()])
}

async function reloadKnowledge(): Promise<void> {
  await admin.loadKnowledge({ keyword: keyword.value.trim() === '' ? undefined : keyword.value.trim() })
  if (showAudit.value) await admin.loadAudit()
}

let keywordTimer: ReturnType<typeof setTimeout> | null = null
function onKeyword(value: string): void {
  keyword.value = value
  if (keywordTimer !== null) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => {
    void reloadKnowledge()
  }, 300)
}

function createEntry(): void {
  editing.value = null
  editorOpen.value = true
}

function editEntry(entry: DomainKnowledge): void {
  editing.value = entry
  editorOpen.value = true
}

async function afterSave(): Promise<void> {
  await reloadKnowledge()
  notice.value = '已保存'
  setTimeout(() => (notice.value = ''), 1800)
}

async function removeEntry(entry: DomainKnowledge): Promise<void> {
  const ok = await admin.removeEntry(entry.id)
  notice.value = ok ? '已删除' : admin.message
  setTimeout(() => (notice.value = ''), 2400)
}

async function removeRecord(record: AnalysisRecord): Promise<void> {
  if (!confirm(`删除记录 ${record.id}？此操作不可恢复。`)) return
  const ok = await admin.removeRecord(record.id)
  notice.value = ok ? '记录已删除' : admin.message
  setTimeout(() => (notice.value = ''), 2400)
}

async function purge(): Promise<void> {
  if (!confirm('按保留期清理过期记录？只删除超过 RECORDS_RETENTION_DAYS 的条目，不会影响近期记录。')) return
  const deleted = await admin.purge()
  notice.value = `已清理 ${deleted} 条过期记录`
  setTimeout(() => (notice.value = ''), 2400)
}

async function toggleAudit(): Promise<void> {
  showAudit.value = !showAudit.value
  if (showAudit.value) await admin.loadAudit()
}

function logout(): void {
  admin.logout()
  notice.value = ''
}

function onQuery(filter: Parameters<typeof admin.loadRecords>[0]): void {
  void admin.loadRecords(filter)
}
</script>

<template>
  <div class="admin">
    <header class="admin__top">
      <RouterLink to="/" class="btn btn--ghost btn--sm">
        <ArrowLeft :size="13" aria-hidden="true" />
        返回分析
      </RouterLink>
      <div class="admin__spacer" />
      <template v-if="admin.authorized">
        <span class="admin__status">
          <span class="dot" aria-hidden="true" />
          已连接
        </span>
        <button type="button" class="btn btn--ghost btn--sm" @click="logout">
          <LogOut :size="13" aria-hidden="true" />
          退出
        </button>
      </template>
    </header>

    <div class="admin__body">
      <div class="admin__inner">
        <header class="admin__head">
          <h1 class="admin__title">管理台</h1>
          <p class="admin__lead">
            领域知识会原文进入系统提示词；分析记录用于复核分析质量。两项操作都只对管理员开放。
          </p>
        </header>

        <p v-if="notice !== ''" class="alert alert--ok">{{ notice }}</p>
        <p v-if="admin.message !== '' && !admin.authorized" class="alert alert--warn">{{ admin.message }}</p>

        <AdminGate v-if="!admin.authorized" />

        <template v-else>
          <nav class="tabs" role="tablist" aria-label="管理分区">
            <button
              type="button"
              role="tab"
              class="tab"
              :class="{ 'tab--active': tab === 'knowledge' }"
              :aria-selected="tab === 'knowledge'"
              @click="tab = 'knowledge'"
            >
              领域知识
            </button>
            <button
              type="button"
              role="tab"
              class="tab"
              :class="{ 'tab--active': tab === 'records' }"
              :aria-selected="tab === 'records'"
              @click="tab = 'records'"
            >
              分析记录
            </button>
            <div class="tabs__spacer" />
            <span class="tabs__meta num">{{ statsLine }}</span>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="admin.busy" @click="loadAll">
              <RefreshCw :size="12" aria-hidden="true" :class="{ spin: admin.busy }" />
              刷新
            </button>
          </nav>

          <!-- 领域知识 -->
          <template v-if="tab === 'knowledge'">
            <KnowledgeList
              :entries="admin.entries"
              :busy="admin.busy"
              :keyword="keyword"
              @create="createEntry"
              @edit="editEntry"
              @remove="removeEntry"
              @update:keyword="onKeyword"
              @filter="() => undefined"
            />

            <div class="admin__tools">
              <button type="button" class="btn btn--sm" @click="toggleAudit">
                {{ showAudit ? '收起变更留痕' : '查看变更留痕' }}
              </button>
              <button type="button" class="btn btn--sm" @click="admin.loadInjection()">
                加载注入预览
              </button>
            </div>

            <AuditList v-if="showAudit" :records="admin.audit" />
            <InjectionPreview v-if="admin.injection !== null" :token="admin.token" />
          </template>

          <!-- 分析记录 -->
          <template v-else>
            <RecordsBoard
              :records="admin.records"
              :total="admin.recordsTotal"
              :stats="admin.recordsStats"
              :busy="admin.busy"
              @query="onQuery"
              @refresh="admin.loadRecords(); admin.loadRecordsStats()"
              @detail="detail = $event"
              @remove="removeRecord"
            />

            <div class="admin__tools">
              <span class="admin__hint">
                清理只删除超过保留期的记录（默认 90 天），近期记录不受影响。
              </span>
              <button type="button" class="btn btn--danger btn--sm" @click="purge">清理过期记录</button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <KnowledgeEditor
      v-model:open="editorOpen"
      :token="admin.token"
      :entry="editing"
      @saved="afterSave"
    />

    <RecordDetail :record="detail" @close="detail = null" />
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}

.admin__top {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--topbar-h);
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--rule);
}

.admin__spacer {
  flex: 1;
}

.admin__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ok);
  font-size: var(--fs-micro);
}

.admin__body {
  flex: 1;
  min-height: 0;
}

.admin__inner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  max-width: 1080px;
  margin: 0 auto;
  padding: var(--sp-5) var(--sp-4) var(--sp-7);
}

.admin__head {
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--rule);
}

.admin__title {
  font-size: var(--fs-title);
  font-weight: 600;
}

.admin__lead {
  max-width: 34em;
  margin-top: 6px;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.75;
}

.tabs {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--rule);
  padding-bottom: 6px;
  flex-wrap: wrap;
}

.tab {
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.tab:hover {
  color: var(--ink);
  background: var(--paper-inset);
}

.tab--active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.tabs__spacer {
  flex: 1;
}

.tabs__meta {
  color: var(--ink-4);
  font-size: 10px;
}

.admin__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-top: var(--sp-2);
  border-top: 1px solid var(--rule);
}

.admin__hint {
  flex: 1;
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 719px) {
  .admin__inner {
    padding: var(--sp-4) var(--sp-3) var(--sp-6);
  }
}
</style>
