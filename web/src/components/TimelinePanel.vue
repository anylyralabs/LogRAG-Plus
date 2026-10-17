<script setup lang="ts">
/**
 * 「工作过程」折叠区：思维链与工具调用的记录。
 *
 * 三条刻意的设计决定（与上一版一致，重做只改呈现）：
 *
 * 1. **正文与工作过程分离**。思维链不进答案气泡——用户要的是结论，不是草稿。
 *    但也不能丢掉：它是「凭什么这么判断」的唯一凭据，排查到一半想复核时要用。
 * 2. **流式时自动展开、结束后自动收起**。分析进行中用户需要看到进展（否则长任务
 *    像卡死）；结束后收起，把版面让给结论。用户手动点过一次后不再自动干预。
 * 3. **真实参数必须显示**。后端曾有缺陷让工具参数恒为 `{}`，界面上表现为
 *    「每次检索都看不到检索词」——那正是本面板存在的意义，因此参数行不做省略措辞。
 *
 * 呈现上的区别：这里用「行 + 左侧 mono 标签」而不是气泡。工具调用本来就是
 * 一串有次序的记录（读哪段、搜什么词、拿到什么），列表形态比气泡更贴近它。
 */
import { computed, ref, watch } from 'vue';
import type { TimelineItem } from '../stores/chat.ts';
import Icon from './Icon.vue';

const props = defineProps<{
  items: TimelineItem[];
  streaming: boolean;
}>();

const userToggled = ref(false);
const expanded = ref(props.streaming);

watch(
  () => props.streaming,
  (now) => {
    if (userToggled.value) return;
    expanded.value = now;
  },
);

function toggle(): void {
  userToggled.value = true;
  expanded.value = !expanded.value;
}

/** 展开的单条思考文本（超长时截断，避免折叠区里又出现一屏） */
const EXPAND_LIMIT = 1200;
const overLimit = ref<Record<number, boolean>>({});

const toolCount = computed(() => props.items.filter((i) => i.kind === 'tool').length);

const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  thinking: '思考',
  tool: '调用',
  tool_result: '结果',
  limit: '上限',
  note: '提示',
};

function thinkingText(text: string, index: number): string {
  if (overLimit.value[index] === true || text.length <= EXPAND_LIMIT) return text;
  return text.slice(0, EXPAND_LIMIT);
}

function isTruncatable(text: string, index: number): boolean {
  return text.length > EXPAND_LIMIT && overLimit.value[index] !== true;
}
</script>

<template>
  <section class="tl">
    <button type="button" class="tl-head" :aria-expanded="expanded" @click="toggle">
      <i class="dot" :class="streaming ? 'dot--accent dot--live' : ''" />
      <span class="tl-title mono">工作过程</span>
      <span class="meta">{{ toolCount }} 次工具</span>
      <span class="grow" />
      <Icon :name="expanded ? 'chevronUp' : 'chevronDown'" :size="15" class="tl-chev" />
    </button>

    <div v-if="expanded" class="tl-body">
      <p v-if="items.length === 0" class="meta tl-empty">尚未开始检索。</p>

      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.kind === 'thinking'" class="row row--thinking">
          <span class="row__kind mono">{{ KIND_LABEL[item.kind] }}</span>
          <div class="row__body">
            <span class="think">{{ thinkingText(item.text, i) }}</span>
            <button
              v-if="isTruncatable(item.text, i)"
              type="button"
              class="more mono"
              @click="overLimit[i] = true"
            >
              展开全部
            </button>
            <button
              v-else-if="overLimit[i] === true && item.text.length > EXPAND_LIMIT"
              type="button"
              class="more mono"
              @click="overLimit[i] = false"
            >
              收起
            </button>
          </div>
        </div>

        <div v-else-if="item.kind === 'tool'" class="row">
          <span class="row__kind mono">{{ KIND_LABEL[item.kind] }}</span>
          <div class="row__body">
            <span class="toolname mono">{{ item.name }}</span>
            <span v-if="item.args !== undefined && item.args !== ''" class="args mono">{{ item.args }}</span>
          </div>
        </div>

        <div v-else-if="item.kind === 'tool_result'" class="row">
          <span class="row__kind mono">{{ KIND_LABEL[item.kind] }}</span>
          <div class="row__body">
            <span class="toolname mono">{{ item.name }}</span>
            <span class="summary mono">{{ item.summary }}</span>
            <span v-if="item.truncated === true" class="pill pill--warn">已截断</span>
          </div>
        </div>

        <div v-else class="row" :class="item.kind === 'limit' ? 'row--limit' : ''">
          <span class="row__kind mono">{{ KIND_LABEL[item.kind] }}</span>
          <div class="row__body">
            <span class="summary">{{ item.text }}</span>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.tl {
  border: 1px solid var(--line);
  border-radius: var(--r1);
  background: var(--surface);
  overflow: hidden;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  padding: var(--s3);
  text-align: left;
  color: var(--text-2);
  transition: background 120ms ease;
}

.tl-head:hover {
  background: var(--surface-2);
}

.tl-title {
  font-size: var(--t-small);
  color: var(--text);
}

.tl-chev {
  color: var(--text-3);
}

.grow {
  flex: 1;
}

/* 流式中的脉冲点：一个就够了，不要再加转圈 */
.dot--live {
  animation: live 1.6s ease-in-out infinite;
}

@keyframes live {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.tl-body {
  border-top: 1px solid var(--line);
  max-height: 46vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tl-empty {
  padding: var(--s4) var(--s3);
}

.row {
  display: flex;
  gap: var(--s3);
  padding: var(--s3);
  border-bottom: 1px solid var(--line);
}

.row:last-child {
  border-bottom: none;
}

.row__kind {
  flex: none;
  width: 2.6em;
  font-size: var(--t-caption);
  color: var(--text-3);
  padding-top: 2px;
}

.row--thinking .row__kind {
  color: var(--text-3);
}

.row--limit .row__kind {
  color: var(--sev-warn);
}

.row--limit .summary {
  color: var(--sev-warn);
}

.row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}

.think {
  font-size: var(--t-small);
  line-height: 1.7;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.toolname {
  font-size: var(--t-small);
  color: var(--accent);
}

.args {
  font-size: var(--t-caption);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.summary {
  font-size: var(--t-caption);
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.more {
  align-self: flex-start;
  font-size: var(--t-caption);
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
