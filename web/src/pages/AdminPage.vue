<script setup lang="ts">
/**
 * 管理页：领域知识与分析记录。
 *
 * 面向对象只有一个：运维自己（也是唯一知道管理令牌的人）。因此这里的密度是
 * **compact**（36px 行高、表格排版），与对话页的 comfortable 刻意区分——
 * 这是 FDS 门控里「页面类型不同 ⇒ 过各自的密度门」的那条。
 *
 * 领域知识这块的界面逻辑有一条硬约束：**新增时必须先看性质判定**。
 * 领域知识会被原文拼进系统提示词，方法论混进来会稀释检索信号（见
 * `src/knowledge/domain.ts` 的说明）。所以「分析」按钮的警告不是提示文案，
 * 是必须让人看见的拦阻信息。
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  analyzeText,
  auditList,
  createDomain,
  explainAdminError,
  injectionPreview,
  listDomain,
  listRecords,
  purgeRecords,
  recordsStats,
  removeDomain,
  removeRecord,
  updateDomain,
  type AdminError,
  type AuditRecord,
  type InjectionPreview,
  type RecordsStats,
} from '../api/admin.ts';
import type { AnalysisRecord, DomainEntry, EntryAnalysis } from '../api/types.ts';
import { relativeTime } from '../lib/format.ts';
import { useSettings } from '../stores/settings.ts';
import Icon from '../components/Icon.vue';

const settings = useSettings();

const token = ref(settings.adminToken.value);
const verified = ref<boolean | null>(null);
const authError = ref<AdminError | null>(null);
const tab = ref<'domain' | 'records'>('domain');

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  method: '方法论',
  unclear: '不确定',
};

// ── 领域知识状态 ────────────────────────────────────────
const entries = ref<DomainEntry[]>([]);
const domainStats = ref<Record<string, unknown>>({});
const audit = ref<AuditRecord[]>([]);
const injection = ref<InjectionPreview | null>(null);
const showInjection = ref(false);
const showAudit = ref(false);
const keyword = ref('');

const form = ref({ content: '', priority: 5, tags: '', enabled: true, kindOverride: '' as '' | 'fact' });
const analysis = ref<(EntryAnalysis & { chars?: number }) | null>(null);
const analyzing = ref(false);
const formError = ref<string | null>(null);
const formNotice = ref<string | null>(null);
const saving = ref(false);

// ── 分析记录状态 ────────────────────────────────────────
const records = ref<AnalysisRecord[]>([]);
const total = ref(0);
const stats = ref<RecordsStats | null>(null);
const days = ref<number | ''>('');
const lowOnly = ref(false);
const detail = ref<AnalysisRecord | null>(null);

const loading = ref(false);

const kindCounts = computed(() => {
  const counts = { fact: 0, method: 0, unclear: 0 };
  for (const e of entries.value) counts[e.kind] += 1;
  return counts;
});

function handleError(e: unknown): void {
  const info = explainAdminError(e);
  authError.value = info;
  if (info.fatal) verified.value = false;
}

async function gate(): Promise<void> {
  loading.value = true;
  authError.value = null;
  try {
    const res = await listDomain(token.value, { limit: '1' });
    entries.value = res.entries;
    verified.value = true;
    settings.adminToken.value = token.value;
    await Promise.all([loadDomain(), loadAudit(), loadRecords(), loadStats()]);
  } catch (e) {
    handleError(e);
  } finally {
    loading.value = false;
  }
}

// ── 加载 ────────────────────────────────────────────────

async function loadDomain(): Promise<void> {
  try {
    const params: Record<string, string> = { limit: '500' };
    if (keyword.value.trim() !== '') params['keyword'] = keyword.value.trim();
    const res = await listDomain(token.value, params);
    entries.value = res.entries;
    domainStats.value = res.stats;
  } catch (e) {
    handleError(e);
  }
}

async function loadAudit(): Promise<void> {
  try {
    audit.value = (await auditList(token.value, 50)).records;
  } catch {
    // 审计拉取失败不影响主流程
  }
}

async function loadInjection(): Promise<void> {
  try {
    injection.value = await injectionPreview(token.value);
    showInjection.value = true;
  } catch (e) {
    handleError(e);
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true;
  try {
    const params: Record<string, string> = { limit: '50' };
    if (days.value !== '') params['days'] = String(days.value);
    if (lowOnly.value) params['deliverable'] = '0';
    const res = await listRecords(token.value, params);
    records.value = res.records;
    total.value = res.total;
  } catch (e) {
    handleError(e);
  } finally {
    loading.value = false;
  }
}

async function loadStats(): Promise<void> {
  try {
    const res = await recordsStats(token.value, days.value === '' ? undefined : days.value);
    stats.value = res.stats;
  } catch {
    // 统计失败只影响看板，不影响列表
  }
}

// ── 领域知识操作 ────────────────────────────────────────

async function runAnalyze(): Promise<void> {
  if (form.value.content.trim() === '') return;
  analyzing.value = true;
  analysis.value = null;
  try {
    analysis.value = await analyzeText(token.value, form.value.content);
  } catch (e) {
    handleError(e);
  } finally {
    analyzing.value = false;
  }
}

async function submitCreate(): Promise<void> {
  formError.value = null;
  formNotice.value = null;
  const content = form.value.content.trim();
  if (content === '') {
    formError.value = '内容不能为空';
    return;
  }

  saving.value = true;
  try {
    const res = await createDomain(token.value, {
      content,
      enabled: form.value.enabled,
      priority: form.value.priority,
      tags: form.value.tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      ...(form.value.kindOverride !== '' ? { kindOverride: form.value.kindOverride } : {}),
    });
    if (!res.ok) {
      formError.value = res.error ?? '写入失败';
      return;
    }
    formNotice.value = `已新增条目 ${res.entry?.id ?? ''}`;
    form.value.content = '';
    form.value.tags = '';
    form.value.kindOverride = '';
    analysis.value = null;
    await Promise.all([loadDomain(), loadAudit()]);
  } catch (e) {
    handleError(e);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(entry: DomainEntry): Promise<void> {
  try {
    await updateDomain(token.value, entry.id, { enabled: !entry.enabled });
    await loadDomain();
  } catch (e) {
    handleError(e);
  }
}

async function saveEntryContent(entry: DomainEntry, content: string): Promise<void> {
  try {
    const res = await updateDomain(token.value, entry.id, { content });
    if (!res.ok) handleError(new Error(res.error ?? '保存失败'));
    else await Promise.all([loadDomain(), loadAudit()]);
  } catch (e) {
    handleError(e);
  }
}

/**
 * 行内编辑。
 *
 * 用 `window.prompt` 而不是内嵌编辑态，是权衡后的选择：条目只有一句话
 * （≤200 字），为它实现一套「行内 textarea + 取消/保存/ESC」的状态机，
 * 维护成本明显高于收益。真到需要富编辑时再换。
 * 逻辑必须放在脚本里而不是模板内联——模板里访问 `window` 在类型层面就不可见。
 */
function editEntry(entry: DomainEntry): void {
  const next = window.prompt('修改内容（≤200 字）', entry.content);
  if (next === null || next.trim() === '') return;
  void saveEntryContent(entry, next.trim());
}

async function deleteEntry(entry: DomainEntry): Promise<void> {
  if (!window.confirm(`删除该条目？\n\n${entry.content.slice(0, 60)}…`)) return;
  try {
    await removeDomain(token.value, entry.id);
    await Promise.all([loadDomain(), loadAudit()]);
  } catch (e) {
    handleError(e);
  }
}

// ── 分析记录操作 ────────────────────────────────────────

async function openDetail(record: AnalysisRecord): Promise<void> {
  detail.value = record;
}

async function deleteRecord(id: string): Promise<void> {
  if (!window.confirm('删除这条分析记录？（不影响已交付给用户的答案）')) return;
  try {
    await removeRecord(token.value, id);
    if (detail.value?.id === id) detail.value = null;
    await Promise.all([loadRecords(), loadStats()]);
  } catch (e) {
    handleError(e);
  }
}

async function flushRecords(): Promise<void> {
  if (!window.confirm('清空全部分析记录？此操作不可撤销，但不会影响用户已收到的回答。')) return;
  try {
    await purgeRecords(token.value);
    detail.value = null;
    await Promise.all([loadRecords(), loadStats()]);
  } catch (e) {
    handleError(e);
  }
}

onMounted(() => {
  if (token.value !== '') void gate();
});

watch(days, () => {
  if (verified.value === true) {
    void loadRecords();
    void loadStats();
  }
});
watch(lowOnly, () => {
  if (verified.value === true) void loadRecords();
});
</script>

<template>
  <div class="ad">
    <!-- 未通过鉴权：只给一条信息，不摆完整界面 -->
    <div v-if="verified !== true" class="ad-gate">
      <section class="ad-card ad-gate-card">
        <div class="ad-card__header">
          <div class="row gap-2">
            <Icon name="shield" :size="16" />
            <span class="ad-card__title">管理入口</span>
          </div>
        </div>
        <div class="ad-card__body stack gap-3">
          <p class="ad-gate-desc">
            管理接口用于维护领域知识与查看分析记录，需要服务端的访问令牌。
            令牌只保存在本机浏览器。
          </p>
          <div class="field">
            <label class="ad-label" for="ad-token">访问令牌</label>
            <input id="ad-token" v-model="token" class="input mono" type="password" autocomplete="off" />
          </div>
          <div v-if="authError !== null" class="ad-error">
            <Icon name="alert" :size="15" />
            <span>{{ authError.message }}</span>
          </div>
          <button type="button" class="btn btn--primary" :disabled="loading || token.trim() === ''" @click="gate">
            <Icon name="check" :size="16" />
            进入
          </button>
        </div>
      </section>
    </div>

    <!-- 已通过鉴权 -->
    <div v-else class="ad-main">
      <div class="ad-tabs">
        <button
          type="button"
          class="ad-tab"
          :class="tab === 'domain' ? 'ad-tab-on' : ''"
          @click="tab = 'domain'"
        >
          领域知识
          <span class="pill">{{ entries.length }}</span>
        </button>
        <button
          type="button"
          class="ad-tab"
          :class="tab === 'records' ? 'ad-tab-on' : ''"
          @click="tab = 'records'"
        >
          分析记录
          <span class="pill">{{ total }}</span>
        </button>
        <span class="grow"></span>
        <button type="button" class="btn btn--quiet" @click="settings.clearAdminToken(); verified = null; token = ''">
          退出
        </button>
      </div>

      <div v-if="authError !== null && !authError.fatal" class="ad-error ad-error-bar">
        <Icon name="alert" :size="15" />
        <span>{{ authError.message }}</span>
      </div>

      <!-- ── 领域知识 ── -->
      <template v-if="tab === 'domain'">
        <section class="ad-card">
          <div class="ad-card__header">
            <span class="ad-card__title">新增条目</span>
            <span class="ad-card__desc">会被原文拼进系统提示词，单条上限 200 字</span>
          </div>
          <div class="ad-card__body stack gap-3">
            <div class="field">
              <textarea
                v-model="form.content"
                class="textarea"
                rows="3"
                placeholder="例：日志中出现 Mojang 认证 API 返回 401 通常表示离线模式游玩，不会导致崩溃，属噪音。"
              ></textarea>
              <span class="hint">{{ [...form.content].length }} / 200 字</span>
            </div>

            <div class="row gap-2 ad-wrap">
              <button type="button" class="btn" :disabled="analyzing || form.content.trim() === ''" @click="runAnalyze">
                <Icon name="search" :size="14" />
                性质判定
              </button>
              <div class="field ad-inline">
                <label class="ad-label" for="ad-prio">优先级</label>
                <input id="ad-prio" v-model.number="form.priority" class="input ad-num" type="number" min="1" max="9" />
              </div>
              <div class="field ad-inline grow">
                <label class="ad-label" for="ad-tags">标签（空格分隔）</label>
                <input id="ad-tags" v-model="form.tags" class="input" placeholder="渲染器 gpu" />
              </div>
              <label class="ad-check">
                <input v-model="form.enabled" type="checkbox" />
                启用
              </label>
            </div>

            <div v-if="analysis !== null" class="ad-analysis" :class="`ad-analysis-${analysis.kind}`">
              <div class="row gap-2">
                <span class="pill" :class="analysis.kind === 'fact' ? 'pill--ok' : analysis.kind === 'method' ? 'pill--warn' : ''">
                  {{ KIND_LABEL[analysis.kind] ?? analysis.kind }}
                </span>
                <span class="meta">{{ analysis.chars }} 字</span>
              </div>
              <ul v-if="analysis.warnings !== undefined && analysis.warnings.length > 0" class="ad-warn-list">
                <li v-for="(w, i) in analysis.warnings" :key="i">{{ w }}</li>
              </ul>
              <label v-if="analysis.kind === 'method'" class="ad-check">
                <input v-model="form.kindOverride" type="checkbox" true-value="fact" false-value="" />
                我确认它确实是先验事实，按事实入库（显式豁免）
              </label>
            </div>

            <div v-if="formError !== null" class="error-text">{{ formError }}</div>
            <div v-if="formNotice !== null" class="meta"><Icon name="check" :size="14" /> {{ formNotice }}</div>

            <div class="row gap-2">
              <button type="button" class="btn btn--primary" :disabled="saving" @click="submitCreate">
                <Icon name="plus" :size="15" />
                新增
              </button>
              <button type="button" class="btn" @click="loadInjection">
                <Icon name="terminal" :size="14" />
                预览实际注入内容
              </button>
            </div>
          </div>
        </section>

        <section v-if="showInjection && injection !== null" class="ad-card">
          <div class="ad-card__header">
            <span class="ad-card__title">注入提示词的原文</span>
            <div class="row gap-2">
              <span class="pill">{{ injection.chars }} 字</span>
              <span class="pill">已注入 {{ injection.injected.length }}</span>
              <span v-if="injection.skipped.length > 0" class="pill pill--warn">
                截断丢弃 {{ injection.skipped.length }}
              </span>
              <button type="button" class="btn btn--quiet" @click="showInjection = false">收起</button>
            </div>
          </div>
          <div class="ad-card__body">
            <pre class="ad-pre">{{ injection.text }}</pre>
          </div>
        </section>

        <section class="ad-card">
          <div class="ad-card__header">
            <span class="ad-card__title">条目（{{ entries.length }}）</span>
            <div class="row gap-2">
              <span class="pill">事实 {{ kindCounts.fact }}</span>
              <span class="pill">方法论 {{ kindCounts.method }}</span>
              <input v-model="keyword" class="input ad-search" placeholder="过滤内容" @keydown.enter="loadDomain" />
              <button type="button" class="btn btn--quiet" @click="loadDomain">
                <Icon name="search" :size="14" />
              </button>
            </div>
          </div>
          <div class="ad-table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>内容</th>
                  <th>性质</th>
                  <th class="numeric">优先级</th>
                  <th>状态</th>
                  <th>更新</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in entries" :key="e.id">
                  <td class="ad-content">
                    <span class="wrap-anywhere">{{ e.content }}</span>
                    <div v-if="e.tags.length > 0" class="ad-tags">
                      <span v-for="t in e.tags" :key="t" class="pill">{{ t }}</span>
                    </div>
                  </td>
                  <td>
                    <span class="pill" :class="e.kind === 'fact' ? 'pill--ok' : e.kind === 'method' ? 'pill--warn' : ''">
                      {{ KIND_LABEL[e.kind] ?? e.kind }}
                    </span>
                  </td>
                  <td class="numeric">{{ e.priority }}</td>
                  <td>
                    <span class="pill" :class="e.enabled ? 'pill--ok' : ''">{{ e.enabled ? '启用' : '停用' }}</span>
                  </td>
                  <td class="meta">{{ relativeTime(e.updatedAt) }}</td>
                  <td class="ad-ops">
                    <button type="button" class="btn btn--quiet" @click="toggleEnabled(e)">
                      {{ e.enabled ? '停用' : '启用' }}
                    </button>
                    <button type="button" class="btn btn--quiet" @click="editEntry(e)">
                      编辑
                    </button>
                    <button type="button" class="btn btn--danger" @click="deleteEntry(e)">删除</button>
                  </td>
                </tr>
                <tr v-if="entries.length === 0">
                  <td colspan="6" class="meta ad-empty">暂无条目。先新增一条真实的先验事实试试。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="ad-card">
          <button type="button" class="ad-card__header ad-audit-head" @click="showAudit = !showAudit">
            <span class="ad-card__title">变更留痕（最近 {{ audit.length }} 条）</span>
            <Icon :name="showAudit ? 'chevronDown' : 'chevronRight'" :size="16" />
          </button>
          <div v-if="showAudit" class="ad-table-wrap">
            <table class="table">
              <tbody>
                <tr v-for="a in audit" :key="a.id">
                  <td>{{ a.action }}</td>
                  <td class="mono">{{ a.entryId ?? '' }}</td>
                  <td class="wrap-anywhere">{{ a.content ?? '' }}</td>
                  <td class="meta">{{ a.actor ?? '' }}</td>
                  <td class="meta">{{ relativeTime(a.createdAt) }}</td>
                </tr>
                <tr v-if="audit.length === 0">
                  <td class="meta ad-empty">没有留痕记录。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <!-- ── 分析记录 ── -->
      <template v-else>
        <section class="ad-kpis">
          <div class="ad-card ad-kpi">
            <span class="meta">记录总数</span>
            <span class="ad-kpi-value">{{ total }}</span>
          </div>
          <div class="ad-card ad-kpi">
            <span class="meta">平均自评</span>
            <span class="ad-kpi-value">
              {{ typeof stats?.averageOverall === 'number' ? stats.averageOverall.toFixed(1) : '—' }}
            </span>
          </div>
          <div class="ad-card ad-kpi">
            <span class="meta">可交付率</span>
            <span class="ad-kpi-value">
              {{ typeof stats?.deliverableRate === 'number' ? `${Math.round(stats.deliverableRate * 100)}%` : '—' }}
            </span>
          </div>
        </section>

        <section class="ad-card">
          <div class="ad-card__header">
            <span class="ad-card__title">记录列表</span>
            <div class="row gap-2">
              <select v-model="days" class="ad-select">
                <option value="">全部时间</option>
                <option :value="1">最近 1 天</option>
                <option :value="7">最近 7 天</option>
                <option :value="30">最近 30 天</option>
              </select>
              <label class="ad-check">
                <input v-model="lowOnly" type="checkbox" />
                只看低分
              </label>
              <button type="button" class="btn btn--quiet" @click="loadRecords">
                <Icon name="refresh" :size="14" />
                刷新
              </button>
              <button type="button" class="btn btn--danger" @click="flushRecords">
                <Icon name="trash" :size="14" />
                清空
              </button>
            </div>
          </div>
          <div class="ad-table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th class="numeric">轮次</th>
                  <th class="numeric">字数</th>
                  <th class="numeric">自评</th>
                  <th>日志</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in records" :key="r.id">
                  <td class="meta">{{ relativeTime(r.createdAt) }}</td>
                  <td class="mono">{{ r.model }}</td>
                  <td class="numeric">{{ r.rounds }}</td>
                  <td class="numeric">{{ r.answerChars }}</td>
                  <td class="numeric">
                    <span class="pill" :class="r.overall >= 80 ? 'pill--ok' : r.overall >= 60 ? 'pill--warn' : 'pill--error'">
                      {{ r.overall }}
                    </span>
                  </td>
                  <td class="mono">{{ r.logId ?? '—' }}</td>
                  <td class="ad-ops">
                    <button type="button" class="btn btn--quiet" @click="openDetail(r)">详情</button>
                    <button type="button" class="btn btn--danger" @click="deleteRecord(r.id)">删除</button>
                  </td>
                </tr>
                <tr v-if="records.length === 0">
                  <td colspan="7" class="meta ad-empty">暂无分析记录。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </div>

    <!-- 记录详情 -->
    <div v-if="detail !== null" class="ad-detail-root">
      <div class="sheet-backdrop" @click="detail = null"></div>
      <aside class="ad-detail">
        <header class="ad-detail-head">
          <span class="ad-card__title">分析详情</span>
          <span class="grow"></span>
          <button type="button" class="icon-btn" aria-label="关闭" @click="detail = null">
            <Icon name="x" :size="18" />
          </button>
        </header>
        <div class="ad-detail-body">
          <div class="ad-detail-meta">
            <span class="pill">{{ detail.model }}</span>
            <span class="pill">{{ detail.rounds }} 轮</span>
            <span class="pill">{{ detail.answerChars }} 字</span>
            <span class="pill" :class="detail.overall >= 80 ? 'pill--ok' : 'pill--warn'">自评 {{ detail.overall }}</span>
            <span v-if="detail.logId !== null" class="pill mono">{{ detail.logId }}</span>
          </div>
          <h3 class="ad-detail-h">根因</h3>
          <p class="wrap-anywhere">{{ detail.conclusion.rootCause ?? '（无）' }}</p>
          <h3 class="ad-detail-h">步骤</h3>
          <ol v-if="Array.isArray(detail.conclusion.steps)" class="ad-detail-list">
            <li v-for="(s, i) in detail.conclusion.steps" :key="i" class="wrap-anywhere">{{ s }}</li>
          </ol>
          <p v-else class="meta">（无）</p>
          <h3 class="ad-detail-h">证据</h3>
          <ul v-if="Array.isArray(detail.conclusion.evidence)" class="ad-detail-list mono">
            <li v-for="(e, i) in detail.conclusion.evidence" :key="i" class="wrap-anywhere">{{ e }}</li>
          </ul>
          <p v-else class="meta">（无）</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/**
 * 管理面样式。
 *
 * 与对话面共用同一套语义令牌（`tokens.css`），因此暗/浅色、强调色、严重度色
 * 自动一致；这里只定义管理面自己的结构件（`ad-*`）与它用到的几个通用类。
 *
 * 两点与上一版不同的取舍：
 *
 * 1. **不再用「卡片 + 阴影」分区**。管理面一屏里常有四五个区块，每块都套圆角
 *    阴影会让页面看起来像一堆互不相干的便签，读不出从属关系。改用发丝线
 *    （`1px` 边框、无圆角阴影）分区，层级靠间距与字级区分。
 * 2. **数字一律等宽右对齐**（`.numeric`）。管理面的判断多是比大小（分数、
 *    耗时、条数），比例字让同一列的数字宽度不齐，肉眼比不了。
 */
.ad {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--s4);
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}

@media (min-width: 1024px) {
  .ad {
    padding: var(--s5);
    gap: var(--s5);
  }
}

/* ── 门禁 ─────────────────────────────────────────────── */

.ad-gate {
  display: flex;
  justify-content: center;
  padding-top: var(--s7);
}

.ad-gate-card {
  width: 100%;
  max-width: 460px;
}

.ad-gate-desc {
  color: var(--text-2);
  line-height: 1.7;
}

/* ── 通用件：发丝线盒子 ───────────────────────────────── */

.ad-card {
  border: 1px solid var(--line);
  border-radius: var(--r1);
  background: var(--surface);
}

.ad-card__header {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--line);
  text-align: left;
}

.ad-card__title {
  font-family: var(--font-display);
  font-size: var(--t-small);
  color: var(--text);
  letter-spacing: 0.02em;
}

.ad-card__body {
  padding: var(--s4);
}

.ad-card__desc {
  color: var(--text-2);
  font-size: var(--t-caption);
  margin-top: var(--s2);
  line-height: 1.65;
}

/* ── 提示与错误 ───────────────────────────────────────── */

.ad-error {
  display: flex;
  align-items: flex-start;
  gap: var(--s2);
  padding: var(--s3);
  border-left: 3px solid var(--sev-error);
  background: var(--sev-error-wash);
  color: var(--text);
  font-size: var(--t-small);
  line-height: 1.6;
}

.ad-error-bar {
  margin-bottom: var(--s3);
}

.error-text {
  color: var(--sev-error);
  font-size: var(--t-caption);
}

/* ── 布局小工具 ───────────────────────────────────────── */

.ad-main {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s3);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}

.grow {
  flex: 1;
}

.gap-2 {
  gap: var(--s2);
}

.gap-3 {
  gap: var(--s3);
}

.wrap-anywhere {
  overflow-wrap: anywhere;
}

.numeric {
  text-align: right;
  font-family: var(--font-display);
  font-variant-numeric: tabular-nums;
}

.meta {
  font-size: var(--t-caption);
}

.ad-label {
  font-family: var(--font-display);
  font-size: var(--t-caption);
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.ad-inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--s2);
}

.ad-wrap {
  align-items: flex-end;
}

/* 表单控件尺寸（宽度类，外观交给 base.css 的 .input/.ad-select） */
.ad-num {
  width: 84px;
}

.ad-search {
  width: 190px;
}

.ad-select {
  width: auto;
  padding: var(--s2) var(--s3);
  border: 1px solid var(--input-line);
  border-radius: var(--r1);
  background: var(--input-bg);
  font-size: var(--t-small);
}

.ad-check {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: 34px;
  font-size: var(--t-small);
  white-space: nowrap;
}

/* ── 页签 ─────────────────────────────────────────────── */

.ad-tabs {
  display: flex;
  align-items: center;
  gap: var(--s4);
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
}

.ad-tab {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: 40px;
  padding: var(--s2) 0;
  border-bottom: 2px solid transparent;
  color: var(--text-2);
  font-size: var(--t-small);
  white-space: nowrap;
}

.ad-tab:hover {
  color: var(--text);
}

.ad-tab-on {
  color: var(--text);
  border-bottom-color: var(--accent);
}

/* ── 表格与内容列 ─────────────────────────────────────── */

.ad-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--r1);
}

.ad-table-wrap .table th {
  background: var(--surface-2);
}

.ad-content {
  min-width: 260px;
  max-width: 520px;
}

.ad-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  margin-top: var(--s2);
}

.ad-ops {
  white-space: nowrap;
  text-align: right;
}

.ad-empty {
  text-align: center;
  padding: var(--s6);
}

/* ── 评分与结果块 ─────────────────────────────────────── */

.ad-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: var(--s3);
}

/* KPI 值用等宽大号字：管理面里它是要被比大小的读数，不是文案 */
.ad-kpi {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding: var(--s3) var(--s4);
}

.ad-kpi-value {
  font-family: var(--font-display);
  font-size: var(--t-h3);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.ad-analysis {
  padding: var(--s3);
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--r1);
  background: var(--surface-2);
}

.ad-analysis-fact {
  border-left-color: var(--sev-ok);
}

.ad-analysis-method {
  border-left-color: var(--sev-warn);
}

.ad-warn-list {
  margin: var(--s2) 0;
  padding-left: var(--s4);
  color: var(--text-2);
  font-size: var(--t-small);
  line-height: 1.7;
}

.ad-pre {
  margin: 0;
  padding: var(--s3);
  max-height: 320px;
  overflow: auto;
  background: var(--bg-deep);
  border: 1px solid var(--line);
  border-radius: var(--r1);
  font-family: var(--font-log);
  font-size: var(--t-caption);
  line-height: var(--lh-log);
  white-space: pre-wrap;
}

.ad-audit-head {
  width: 100%;
  text-align: left;
}

/* ── 详情抽屉 ─────────────────────────────────────────── */

.ad-detail-root {
  position: fixed;
  inset: 0;
  z-index: 60;
}

.sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 6, 10, 0.55);
}

.ad-detail {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}

.ad-detail-head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--line);
}

.ad-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--s4);
  padding-bottom: calc(var(--s7) + env(safe-area-inset-bottom));
}

.ad-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  margin-bottom: var(--s4);
}

.ad-detail-h {
  margin: var(--s5) 0 var(--s2);
  font-family: var(--font-display);
  font-size: var(--t-caption);
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.1em;
}

.ad-detail-list {
  margin: 0;
  padding-left: var(--s4);
  line-height: 1.7;
  color: var(--text-2);
  font-size: var(--t-small);
}
</style>
