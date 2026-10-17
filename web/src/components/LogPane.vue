<script setup lang="ts">
/**
 * 日志面板 —— 这个产品最核心的交互。
 *
 * ## 它在解决什么
 *
 * 用户带着一份 2600 行的日志来，真正有用的可能只有 20 行。上一版只有一个
 * 「已绑定日志」的信息条加一个聊天框，等于把「找出那 20 行」整件事都推给用户，
 * 而他来找我们正是因为找不出来。
 *
 * 所以面板给三件事：
 *
 * 1. **分节跳转**：LogShare 的 raw 是多份文件拼的（`===== hs_err_… =====`），
 *    节名即文件名。给出节名 = 把「哪一节是崩溃现场」这个结构还回去。
 * 2. **错误粗筛**：`上一处 / 下一处错误`按钮在 ERROR 行之间跳。INFO 不上色——
 *    高亮的行一多，高亮就等于没有。
 * 3. **指认**：点行号选起点、再点一次选终点，把这一段作为**证据**送进对话。
 *    这是本设计里唯一无法被通用聊天界面替代的交互。
 *
 * ## 为什么不做虚拟滚动
 *
 * 只渲染一个「行窗口」（默认 240 行）+ 上下翻屏。真做虚拟滚动要处理行高测量、
 * 滚动锚定、移动端惯性，代码量是这里的好几倍；而行窗口在「按节跳 + 按错误跳」
 * 的用法下几乎无感——用户本来就不是在连续滚动，是在跳。
 *
 * ## 为什么选行号而不是拖选
 *
 * 手机上拖选几行几乎不可能选准（手指覆盖三行、自动滚动乱跳）。点行号选区间
 * 是两根手指就能做完的事，且视觉上「起止行号高亮」比反色选区更清楚。
 */

import { computed, ref, watch } from 'vue';

import { logDocs } from '../api/client.ts';
import { bytes } from '../lib/format.ts';
import { nextError, parseLog, prevError, sliceLines } from '../lib/logdoc.ts';
import type { LogContext } from '../stores/chat.ts';
import Icon from './Icon.vue';

const props = defineProps<{
  log: LogContext | null;
}>();

const emit = defineEmits<{
  /** 把选中的行作为证据送进输入区 */
  quote: [payload: { label: string; from: number; to: number; text: string }];
  clear: [];
}>();

/** 面板一次渲染多少行 */
const WINDOW = 240;

/**
 * 面板自身的内容上限。粘贴进来的正文可能到 10MB（分析通道照收不误），
 * 但面板只用于阅读与指认，2MB 之后的行渲染出来也没人看，还会拖慢手机。
 */
const PANE_MAX_CHARS = 2 * 1024 * 1024;

/** 远端取回的日志按 ID 缓存（切换视图不重复请求） */
const remoteCache = new Map<string, { name: string; content: string; truncated: boolean; omitted: string[] }>();

const loading = ref(false);
const loadError = ref<string | null>(null);
const remote = ref<{ name: string; content: string; truncated: boolean; omitted: string[] } | null>(null);

const from = ref(1);
const pickStart = ref<number | null>(null);
const pickEnd = ref<number | null>(null);

const logId = computed(() => props.log?.logId ?? null);

/** 面板要显示的正文：本地有的直接用，没有的按 ID 取回 */
const content = computed(() => {
  const local = props.log?.content ?? '';
  if (local !== '') return local;
  return remote.value?.content ?? '';
});

const docName = computed(() => {
  if ((props.log?.content ?? '') !== '') return props.log?.label ?? '日志';
  return remote.value?.name ?? 'main.log';
});

const paneTruncated = computed(() => {
  const local = props.log?.content ?? '';
  if (local !== '') return local.length > PANE_MAX_CHARS;
  return remote.value?.truncated ?? false;
});

const parsed = computed(() => parseLog(content.value.slice(0, PANE_MAX_CHARS)));

const windowEnd = computed(() => Math.min(parsed.value.lines.length, from.value + WINDOW - 1));

/** 只渲染当前窗口，避免几万行 DOM 把手机拖死 */
const visible = computed(() => {
  const out: Array<{ no: number; text: string; sev: string }> = [];
  const p = parsed.value;
  const end = windowEnd.value;
  for (let n = from.value; n <= end; n++) {
    out.push({ no: n, text: p.lines[n - 1] ?? '', sev: p.severity[n - 1] ?? 'plain' });
  }
  return out;
});

const pickRange = computed(() => {
  const a = pickStart.value;
  if (a === null) return null;
  const b = pickEnd.value ?? a;
  return { from: Math.min(a, b), to: Math.max(a, b) };
});

/** 从 LogShare 取回正文（只有「只给 ID」这一条主路径需要） */
async function load(): Promise<void> {
  const id = logId.value;
  if (id === null) return;
  if ((props.log?.content ?? '') !== '') return;

  const hit = remoteCache.get(id);
  if (hit !== undefined) {
    remote.value = hit;
    loadError.value = null;
    return;
  }

  loading.value = true;
  loadError.value = null;
  try {
    const res = await logDocs(id);
    const first = res.docs[0];
    if (first === undefined) {
      loadError.value = '这份日志没有任何可显示的正文';
      remote.value = null;
      return;
    }
    const entry = {
      name: first.name,
      content: first.content,
      truncated: first.truncated,
      omitted: res.omitted ?? [],
    };
    remoteCache.set(id, entry);
    remote.value = entry;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '读取日志失败';
    remote.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [logId.value, props.log?.content ?? ''] as const,
  () => {
    from.value = 1;
    pickStart.value = null;
    pickEnd.value = null;
    void load();
  },
  { immediate: true },
);

/** 切换日志后跳到最该看的位置：崩溃现场 > 第一处错误 > 开头 */
watch(parsed, (p) => {
  const crash = p.sections.find((s) => s.role === '崩溃现场');
  if (crash !== undefined) {
    from.value = crash.start;
    return;
  }
  const first = p.errors[0];
  from.value = first === undefined ? 1 : Math.max(1, first - 12);
});

function goSection(start: number): void {
  from.value = Math.max(1, start);
  pickStart.value = null;
  pickEnd.value = null;
}

function jumpError(dir: 1 | -1): void {
  const p = parsed.value;
  const cur = windowEnd.value;
  const target = dir === 1 ? nextError(p.errors, cur) : prevError(p.errors, from.value);
  if (target === null) return;
  from.value = Math.max(1, target - 8);
}

function page(dir: 1 | -1): void {
  from.value = Math.max(1, Math.min(from.value + dir * WINDOW, Math.max(1, parsed.value.lines.length - 1)));
}

/** 强制重新读取（绕过缓存） */
function reload(): void {
  const id = logId.value;
  if (id !== null) remoteCache.delete(id);
  void load();
}

function pick(no: number): void {
  if (pickStart.value === null || pickEnd.value !== null) {
    pickStart.value = no;
    pickEnd.value = null;
    return;
  }
  pickEnd.value = no;
}

function clearPick(): void {
  pickStart.value = null;
  pickEnd.value = null;
}

function sendQuote(): void {
  const r = pickRange.value;
  if (r === null) return;
  emit('quote', {
    label: `${docName.value}:${r.from}-${r.to}`,
    from: r.from,
    to: r.to,
    text: sliceLines(parsed.value, r.from, r.to),
  });
  clearPick();
}
</script>

<template>
  <section class="pane" aria-label="日志面板">
    <header class="pane__top">
      <div class="pane__title">
        <Icon name="file" :size="14" />
        <span class="mono pane__name">{{ docName }}</span>
      </div>
      <div class="pane__top-right">
        <span class="pill" v-if="parsed.counts.error > 0">
          <i class="dot dot--error" />{{ parsed.counts.error }} 错误
        </span>
        <span class="pill" v-if="parsed.counts.warn > 0">
          <i class="dot dot--warn" />{{ parsed.counts.warn }} 警告
        </span>
        <button class="icon-btn" type="button" title="重新读取日志" @click="reload">
          <Icon name="refresh" :size="15" />
        </button>
        <button class="icon-btn" type="button" title="解除日志绑定" @click="emit('clear')">
          <Icon name="x" :size="15" />
        </button>
      </div>
    </header>

    <p class="pane__facts meta">
      <span v-if="logId !== null">{{ logId }}</span>
      <span>· {{ parsed.lines.length }} 行</span>
      <span v-if="(log?.bytes ?? 0) > 0">· {{ bytes(log?.bytes ?? 0) }}</span>
    </p>

    <!-- 分节：LogShare 的 raw 是多份文件拼的，节名就是文件名 -->
    <nav v-if="parsed.sections.length > 0" class="pane__sections" aria-label="日志分节">
      <button
        v-for="s in parsed.sections"
        :key="s.start"
        type="button"
        class="sec"
        :class="{ 'sec--on': from >= s.start && from <= s.end }"
        @click="goSection(s.start)"
      >
        <span class="sec__role">{{ s.role }}</span>
        <span class="sec__name mono">{{ s.name }}</span>
        <span class="meta">{{ s.start }}</span>
      </button>
    </nav>

    <p v-if="loading" class="pane__state meta">正在读取日志…</p>
    <p v-else-if="loadError !== null" class="pane__state pane__state--err">
      {{ loadError }}
      <button class="btn" type="button" @click="load">重试</button>
    </p>

    <div v-else class="pane__scroll" role="region" tabindex="0" aria-label="日志正文">
      <div
        v-for="l in visible"
        :key="l.no"
        class="log-line"
        :class="[
          `log-line--${l.sev}`,
          pickRange !== null && l.no >= pickRange.from && l.no <= pickRange.to ? 'log-line--picked' : '',
        ]"
      >
        <button
          type="button"
          class="log-line__no log-line__no--btn"
          :title="`选择第 ${l.no} 行`"
          @click="pick(l.no)"
        >
          {{ l.no }}
        </button>
        <span class="log-line__text">{{ l.text }}</span>
      </div>
    </div>

    <footer class="pane__bar">
      <span class="meta pane__range">
        第 {{ from }}–{{ windowEnd }} 行 / 共 {{ parsed.lines.length }} 行
      </span>
      <div class="pane__nav">
        <button class="btn" type="button" :disabled="parsed.errors.length === 0" @click="jumpError(-1)">
          <Icon name="chevronUp" :size="14" />上一处错误
        </button>
        <button class="btn" type="button" :disabled="parsed.errors.length === 0" @click="jumpError(1)">
          <Icon name="chevronDown" :size="14" />下一处错误
        </button>
        <button class="btn" type="button" :disabled="from <= 1" @click="page(-1)">上一屏</button>
        <button class="btn" type="button" :disabled="windowEnd >= parsed.lines.length" @click="page(1)">
          下一屏
        </button>
      </div>
    </footer>

    <!-- 指认：选中区间后浮出的动作条 -->
    <div v-if="pickRange !== null" class="pane__pick">
      <span class="mono">
        已选 {{ pickRange.from }}–{{ pickRange.to }} 行（{{ pickRange.to - pickRange.from + 1 }} 行）
      </span>
      <div class="pane__pick-btns">
        <button class="btn" type="button" @click="clearPick">取消</button>
        <button class="btn btn--primary" type="button" @click="sendQuote">
          <Icon name="quote" :size="14" />引用进对话
        </button>
      </div>
    </div>

    <p v-if="paneTruncated" class="hint pane__hint">
      面板只显示前 2MB（约 {{ parsed.lines.length }} 行）。分析时送入的是完整正文。
    </p>
    <p v-if="remote !== null && remote.omitted.length > 0" class="hint pane__hint">
      另有附件未在面板显示：{{ remote.omitted.join('、') }}（体积超出面板预算）。
    </p>
  </section>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-deep);
  border: 1px solid var(--line);
  border-radius: var(--r1);
  overflow: hidden;
}

.pane__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: var(--s3);
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.pane__title {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
  color: var(--text-2);
}

.pane__name {
  font-size: var(--t-small);
  color: var(--text);
}

.pane__top-right {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex: none;
}

.pane__facts {
  display: flex;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.pane__sections {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
}

.sec {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  border-right: 1px solid var(--line);
  white-space: nowrap;
  color: var(--text-2);
  transition: background 120ms ease, color 120ms ease;
}

.sec:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* 当前所在节：下沿一条强调线。不用底色块，避免和错误行的行底色打架 */
.sec--on {
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.sec__role {
  font-size: var(--t-small);
}

.sec__name {
  font-size: var(--t-caption);
  color: var(--text-3);
}

.pane__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--s3) 0;
  overscroll-behavior: contain;
}

.log-line__no--btn {
  font: inherit;
  color: var(--text-3);
  cursor: pointer;
}

.log-line__no--btn:hover {
  color: var(--accent);
}

.pane__state {
  padding: var(--s5) var(--s3);
  display: flex;
  align-items: center;
  gap: var(--s3);
  justify-content: center;
}

.pane__state--err {
  color: var(--sev-error);
  font-size: var(--t-small);
}

.pane__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  border-top: 1px solid var(--line);
  background: var(--surface);
  flex-wrap: wrap;
}

.pane__range {
  flex: none;
}

.pane__nav {
  display: flex;
  gap: var(--s2);
  flex-wrap: wrap;
}

/* 指认动作条：浮在底部而不是插进流里，避免布局跳动 */
.pane__pick {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: var(--s3);
  background: var(--surface-3);
  border-top: 1px solid var(--accent);
  flex-wrap: wrap;
}

.pane__pick .mono {
  font-size: var(--t-small);
}

.pane__pick-btns {
  display: flex;
  gap: var(--s2);
}

.pane__hint {
  padding: var(--s2) var(--s3);
  border-top: 1px solid var(--line);
}
</style>
