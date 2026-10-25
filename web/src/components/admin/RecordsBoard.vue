<script setup lang="ts">
/**
 * 分析记录看板。
 *
 * 这不是「运营大屏」：它回答的是工程问题——哪个维度没有区分度、
 * 哪类扣分最常见、低分样本长什么样。因此统计条之后直接是可筛选的记录表。
 */
import { computed, ref } from 'vue'
import { ChevronLeft, ChevronRight, RefreshCw, Trash2 } from 'lucide-vue-next'
import type { AnalysisRecord, AnalysisStats } from '@/lib/types'

const props = defineProps<{
  records: AnalysisRecord[]
  total: number
  stats: AnalysisStats | null
  busy: boolean
}>()

const emit = defineEmits<{
  query: [
    filter: {
      limit: number
      offset: number
      minScore?: number
      maxScore?: number
      deliverable?: boolean
      logId?: string
      model?: string
      orderBy?: 'created' | 'overall' | 'rounds' | 'tool_calls'
      ascending?: boolean
    },
  ]
  refresh: []
  detail: [record: AnalysisRecord]
  remove: [record: AnalysisRecord]
}>()

const PAGE_SIZE = 50
const offset = ref(0)

const minScore = ref('')
const maxScore = ref('')
const deliverable = ref<'all' | 'yes' | 'no'>('all')
const logId = ref('')
const model = ref('')
const orderBy = ref<'created' | 'overall' | 'rounds' | 'tool_calls'>('created')
const ascending = ref(false)

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)
const pages = computed(() => Math.max(1, Math.ceil(props.total / PAGE_SIZE)))

function buildFilter() {
  const min = minScore.value === '' ? undefined : Number(minScore.value)
  const max = maxScore.value === '' ? undefined : Number(maxScore.value)
  return {
    limit: PAGE_SIZE,
    offset: offset.value,
    ...(min !== undefined && Number.isFinite(min) ? { minScore: min } : {}),
    ...(max !== undefined && Number.isFinite(max) ? { maxScore: max } : {}),
    ...(deliverable.value === 'yes' ? { deliverable: true } : {}),
    ...(deliverable.value === 'no' ? { deliverable: false } : {}),
    ...(logId.value.trim() !== '' ? { logId: logId.value.trim() } : {}),
    ...(model.value.trim() !== '' ? { model: model.value.trim() } : {}),
    orderBy: orderBy.value,
    ascending: ascending.value,
  }
}

function apply(): void {
  offset.value = 0
  emit('query', buildFilter())
}

function go(delta: number): void {
  const next = offset.value + delta * PAGE_SIZE
  if (next < 0 || next >= props.total) return
  offset.value = next
  emit('query', buildFilter())
}

function reset(): void {
  minScore.value = ''
  maxScore.value = ''
  deliverable.value = 'all'
  logId.value = ''
  model.value = ''
  orderBy.value = 'created'
  ascending.value = false
  apply()
}

function scoreTone(score: number): string {
  if (score >= 85) return 'ok'
  if (score >= 70) return 'warn'
  return 'danger'
}

function timeOf(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const buckets = computed(() => {
  const raw = props.stats?.scoreBuckets ?? {}
  const entries = Object.entries(raw).sort(([a], [b]) => {
    const na = Number.parseInt(a.split('-')[0] ?? '0', 10)
    const nb = Number.parseInt(b.split('-')[0] ?? '0', 10)
    return na - nb
  })
  const max = Math.max(1, ...entries.map(([, n]) => n))
  return entries.map(([label, count]) => ({ label, count, pct: Math.round((count / max) * 100) }))
})

const dimensionRows = computed(() => {
  const d = props.stats?.dimensions
  if (d === undefined || d === null) return []
  return [
    { label: '证据', value: d.grounding },
    { label: '核实', value: d.verification },
    { label: '可行', value: d.actionability },
    { label: '效率', value: d.economy },
  ]
})
</script>

<template>
  <section class="board">
    <header class="board__head">
      <div class="label">分析记录</div>
      <button type="button" class="btn btn--sm" :disabled="busy" @click="emit('refresh')">
        <RefreshCw :size="12" aria-hidden="true" :class="{ spin: busy }" />
        刷新
      </button>
    </header>

    <!-- 统计条：紧凑、无卡片 -->
    <div v-if="stats !== null" class="summary">
      <div class="summary__item">
        <span class="summary__label">总量</span>
        <span class="num summary__value">{{ stats.total }}</span>
      </div>
      <div class="summary__item">
        <span class="summary__label">均分</span>
        <span class="num summary__value">{{ stats.avgOverall ?? '—' }}</span>
      </div>
      <div class="summary__item">
        <span class="summary__label">可交付率</span>
        <span class="num summary__value">
          {{ stats.deliverableRate === null ? '—' : `${Math.round(stats.deliverableRate * 100)}%` }}
        </span>
      </div>
      <div class="summary__item">
        <span class="summary__label">低分（&lt;70）</span>
        <span class="num summary__value summary__value--danger">{{ stats.lowScoreCount }}</span>
      </div>
      <div class="summary__item">
        <span class="summary__label">均轮次</span>
        <span class="num summary__value">{{ stats.avgRounds ?? '—' }}</span>
      </div>
      <div class="summary__item">
        <span class="summary__label">均工具调用</span>
        <span class="num summary__value">{{ stats.avgToolCalls ?? '—' }}</span>
      </div>
      <div v-if="stats.truncated" class="summary__truncated">
        样本超过聚合上限，统计只覆盖最近 {{ stats.sampled }} 条
      </div>
    </div>

    <!-- 分布 -->
    <div v-if="stats !== null" class="charts">
      <div class="chart">
        <div class="label">分数分布</div>
        <div class="buckets">
          <div v-for="bucket in buckets" :key="bucket.label" class="bucket">
            <span class="num bucket__label">{{ bucket.label }}</span>
            <span class="bucket__bar">
              <span class="bucket__fill" :style="{ width: `${bucket.pct}%` }" />
            </span>
            <span class="num bucket__count">{{ bucket.count }}</span>
          </div>
        </div>
      </div>

      <div class="chart">
        <div class="label">维度均值</div>
        <div class="dims">
          <div v-for="row in dimensionRows" :key="row.label" class="dim">
            <span class="dim__label">{{ row.label }}</span>
            <span class="dim__bar">
              <span
                class="dim__fill"
                :style="{ width: row.value === null ? '0%' : `${Math.max(2, row.value)}%` }"
              />
            </span>
            <span class="num dim__value">{{ row.value ?? '—' }}</span>
          </div>
        </div>
      </div>

      <div v-if="stats.topDeductions.length > 0" class="chart chart--wide">
        <div class="label">最常见的扣分理由</div>
        <ol class="reasons">
          <li v-for="(reason, i) in stats.topDeductions" :key="i" class="reason">
            <span class="num reason__count">{{ reason.count }}</span>
            <span class="reason__text">{{ reason.text }}</span>
          </li>
        </ol>
      </div>
    </div>

    <!-- 筛选 -->
    <form class="filters" @submit.prevent="apply">
      <div class="filters__row">
        <label class="filter">
          <span>最低分</span>
          <input v-model="minScore" class="input mono" type="number" min="0" max="100" placeholder="0" />
        </label>
        <label class="filter">
          <span>最高分</span>
          <input v-model="maxScore" class="input mono" type="number" min="0" max="100" placeholder="100" />
        </label>
        <label class="filter">
          <span>可交付</span>
          <select v-model="deliverable" class="select">
            <option value="all">全部</option>
            <option value="yes">仅可交付</option>
            <option value="no">仅需复核</option>
          </select>
        </label>
        <label class="filter">
          <span>日志 ID</span>
          <input v-model="logId" class="input mono" placeholder="kalkLqQ" />
        </label>
        <label class="filter">
          <span>模型</span>
          <input v-model="model" class="input mono" placeholder="全部" />
        </label>
        <label class="filter">
          <span>排序</span>
          <select v-model="orderBy" class="select">
            <option value="created">时间</option>
            <option value="overall">总分</option>
            <option value="rounds">轮次</option>
            <option value="tool_calls">工具调用</option>
          </select>
        </label>
        <label class="filter filter--check">
          <input v-model="ascending" type="checkbox" />
          <span>升序</span>
        </label>
      </div>
      <div class="filters__actions">
        <button type="button" class="btn btn--sm" @click="reset">重置</button>
        <button type="submit" class="btn btn--primary btn--sm">应用筛选</button>
      </div>
    </form>

    <!-- 记录表 -->
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">日志</th>
            <th scope="col">总分</th>
            <th scope="col">四维</th>
            <th scope="col">轮次</th>
            <th scope="col">工具</th>
            <th scope="col">根因</th>
            <th scope="col"><span class="visually-hidden">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="records.length === 0">
            <td colspan="8" class="table__empty">没有匹配的记录。</td>
          </tr>
          <tr
            v-for="record in records"
            :key="record.id"
            class="row"
            tabindex="0"
            @click="emit('detail', record)"
            @keydown.enter.prevent="emit('detail', record)"
          >
            <td class="num nowrap">{{ timeOf(record.created) }}</td>
            <td class="mono">{{ record.logId ?? '—' }}</td>
            <td>
              <span class="badge" :class="`badge--${scoreTone(record.overall)}`">{{ record.overall }}</span>
            </td>
            <td class="dims-cell num nowrap">
              {{ record.grounding ?? '—' }} / {{ record.verification }} / {{ record.actionability }} /
              {{ record.economy }}
            </td>
            <td class="num">{{ record.rounds }}</td>
            <td class="num">
              {{ record.toolCalls }}
              <span v-if="record.failedCalls > 0" class="cell-warn">（失败 {{ record.failedCalls }}）</span>
            </td>
            <td class="cell-root">{{ record.rootCause === '' ? '（未提取）' : record.rootCause }}</td>
            <td class="cell-actions">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                aria-label="删除记录"
                @click.stop="emit('remove', record)"
              >
                <Trash2 :size="12" aria-hidden="true" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="pager">
      <span class="num pager__info">
        共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页
      </span>
      <button type="button" class="btn btn--sm" :disabled="offset === 0 || busy" @click="go(-1)">
        <ChevronLeft :size="12" aria-hidden="true" />
        上一页
      </button>
      <button
        type="button"
        class="btn btn--sm"
        :disabled="offset + PAGE_SIZE >= total || busy"
        @click="go(1)"
      >
        下一页
        <ChevronRight :size="12" aria-hidden="true" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-height: 0;
}

.board__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.board__head .label {
  flex: 1;
}

.summary {
  display: flex;
  align-items: baseline;
  gap: var(--sp-5);
  flex-wrap: wrap;
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.summary__item {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.summary__label {
  color: var(--ink-4);
  font-size: 10px;
}

.summary__value {
  color: var(--ink);
  font-size: var(--fs-lead);
}

.summary__value--danger {
  color: var(--danger);
}

.summary__truncated {
  flex-basis: 100%;
  color: var(--warn);
  font-size: var(--fs-micro);
}

.charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sp-4);
}

.chart {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.chart--wide {
  grid-column: 1 / -1;
}

.buckets,
.dims {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bucket,
.dim {
  display: grid;
  grid-template-columns: 3.2rem 1fr 2.2rem;
  align-items: center;
  gap: var(--sp-2);
  font-size: 10px;
}

.bucket__label,
.dim__label {
  color: var(--ink-3);
}

.dim__bar,
.bucket__bar {
  height: 4px;
  background: var(--paper-inset);
  overflow: hidden;
}

.bucket__fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.dim__fill {
  display: block;
  height: 100%;
  background: var(--ink-4);
}

.bucket__count,
.dim__value {
  color: var(--ink-3);
  text-align: right;
}

.reasons {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.reason {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.reason__count {
  flex: none;
  color: var(--ink-4);
}

.reason__text {
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--rule);
}

.filters__row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.filter {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--ink-4);
  font-size: 10px;
}

.filter .input,
.filter .select {
  height: 28px;
  padding: 0 6px;
  font-size: var(--fs-micro);
  width: 8rem;
}

.filter--check {
  flex-direction: row;
  align-items: center;
  gap: 5px;
  height: 28px;
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.filter--check input {
  accent-color: var(--accent);
}

.filters__actions {
  display: flex;
  gap: var(--sp-2);
  justify-content: flex-end;
}

.table-wrap {
  overflow-x: auto;
  border-top: 1px solid var(--rule);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-micro);
}

.table th,
.table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}

.table th {
  color: var(--ink-4);
  font-weight: 500;
  white-space: nowrap;
  background: var(--paper-sunken);
}

.table__empty {
  padding: var(--sp-6);
  color: var(--ink-3);
  text-align: center;
}

.row {
  cursor: pointer;
}

.row:hover,
.row:focus-visible {
  background: var(--paper-raised);
}

.nowrap {
  white-space: nowrap;
}

.dims-cell,
.cell-warn {
  color: var(--ink-3);
}

.cell-warn {
  color: var(--warn);
}

.cell-root {
  max-width: 26rem;
  color: var(--ink-2);
  line-height: 1.55;
}

.cell-actions {
  width: 1%;
}

.pager {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.pager__info {
  flex: 1;
  color: var(--ink-4);
  font-size: 10px;
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
