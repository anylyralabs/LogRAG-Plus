<script setup lang="ts">
/**
 * 单条消息。
 *
 * ## 为什么不是左右两列气泡
 *
 * 气泡是即时聊天的形态，它假设两边说的话等长。这里用户的输入常常是一份
 * 259KB 的日志，助手回的是一篇带小标题与代码块的报告——把它们塞进两个圆角
 * 气泡里，气泡只会限制阅读宽度并让「哪一段是谁说的」靠对齐去猜。
 *
 * 这里改用**单列 + 左侧标号**的形态（像一份实验记录）：每一轮之间一条发丝线，
 * 用户的标号是「你」，助手的是产品名。对齐不再承担语义，长度也不受气泡约束。
 *
 * ## 助手消息在正文为空且已是终态时，绝不渲染成空白
 *
 * 空答案伪装成功是线上真实事故（0 字答案 + 288 个事件 + 报 completed），
 * 界面必须如实说话：给「无结论」标号，而不是留一片空白让用户以为没加载出来。
 */
import { computed, ref } from 'vue';

import { relativeTime } from '../lib/format.ts';
import type { ChatMessage } from '../stores/chat.ts';
import EvidenceSpine from './EvidenceSpine.vue';
import Icon from './Icon.vue';
import MarkdownView from './MarkdownView.vue';
import TimelinePanel from './TimelinePanel.vue';

const props = defineProps<{ message: ChatMessage }>();

const copied = ref(false);

const scoreLine = computed(() => {
  const s = props.message.score;
  if (s === null) return null;
  return `${s.overall}`;
});

const statusBadge = computed<{ text: string; tone: string } | null>(() => {
  const m = props.message;
  if (m.role !== 'assistant') return null;
  if (m.status === 'streaming') return { text: '分析中', tone: 'pill--accent' };
  if (m.status === 'error') return { text: '失败', tone: 'pill--error' };
  if (m.status === 'aborted') return { text: '已停止', tone: 'pill--warn' };
  // 成功但没正文：这是「伪装成功」的界面形态，必须标出来
  if (m.content.trim() === '' && m.conclusion === null) return { text: '无结论', tone: 'pill--warn' };
  return null;
});

/** 用户消息里贴了大段日志时用等宽字呈现 */
const looksLikeLog = computed(() => {
  const c = props.message.content;
  return c.includes('\n') && (c.length > 400 || /\[\d{2}:\d{2}:\d{2}\]/.test(c));
});

async function copy(): Promise<void> {
  const m = props.message;
  const parts = [m.content];
  if (m.conclusionRaw !== null) parts.push('```json\n' + m.conclusionRaw + '\n```');
  try {
    await navigator.clipboard.writeText(parts.join('\n\n'));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // 剪贴板在非安全上下文（http 局域网调试）不可用：静默失败，不打断阅读
  }
}
</script>

<template>
  <!-- 用户这一轮 -->
  <article v-if="message.role === 'user'" class="turn turn--user">
    <div class="turn__gutter">
      <span class="turn__from mono">你</span>
    </div>
    <div class="turn__body">
      <pre v-if="looksLikeLog" class="user-log">{{ message.content }}</pre>
      <p v-else class="user-text">{{ message.content }}</p>
    </div>
  </article>

  <!-- 助手这一轮 -->
  <article v-else class="turn turn--assistant">
    <div class="turn__gutter">
      <span class="turn__from turn__from--mark mono">LogRAG+</span>
    </div>

    <div class="turn__body">
      <header class="head">
        <span class="meta">{{ relativeTime(message.createdAt) }}</span>
        <span v-if="statusBadge !== null" class="pill" :class="statusBadge.tone">{{ statusBadge.text }}</span>
        <span v-if="scoreLine !== null" class="pill" title="本轮自评总分（四维明细见文末）">
          <Icon name="gauge" :size="12" />自评 {{ scoreLine }}
        </span>
        <span class="grow" />
        <button
          v-if="message.content.trim() !== ''"
          type="button"
          class="icon-btn"
          aria-label="复制回答"
          @click="copy"
        >
          <Icon :name="copied ? 'check' : 'copy'" :size="15" />
        </button>
      </header>

      <TimelinePanel :items="message.items" :streaming="message.status === 'streaming'" />

      <div v-if="message.content.trim() !== ''" class="body">
        <MarkdownView :text="message.content" />
      </div>

      <p v-else-if="message.status === 'streaming'" class="waiting mono">
        正在整理结论<span class="waiting__dots" aria-hidden="true">…</span>
      </p>

      <p v-if="message.error !== null" class="err" :class="message.status === 'aborted' ? 'err--soft' : ''">
        <Icon :name="message.status === 'aborted' ? 'bulb' : 'alert'" :size="15" />
        <span>{{ message.error }}</span>
      </p>

      <EvidenceSpine v-if="message.conclusion !== null" :conclusion="message.conclusion" />

      <!-- 自评明细：原生 details（可访问、无 JS）。默认收起，它是给复核者的 -->
      <details v-if="message.score !== null" class="score">
        <summary class="score__sum mono">
          自评 {{ message.score.overall }} 分 · 依据 {{ message.score.dimensions.grounding }} · 核实
          {{ message.score.dimensions.verification }} · 可行 {{ message.score.dimensions.actionability }} · 简洁
          {{ message.score.dimensions.economy }}
        </summary>
        <ul class="score__list">
          <li v-for="(d, i) in message.score.deductions" :key="i" class="score__item">
            <span class="mono score__pts">{{ d.dimension ?? '综合' }} -{{ d.points ?? '?' }}</span>
            <span>{{ d.reason ?? '' }}</span>
          </li>
          <li v-if="message.score.deductions.length === 0" class="score__item meta">无扣分项。</li>
        </ul>
        <p v-if="message.score.missingAnchors.length > 0" class="score__missing mono">
          未在正文中核对到：{{ message.score.missingAnchors.join('、') }}
        </p>
      </details>
    </div>
  </article>
</template>

<style scoped>
/**
 * 单列 + 标号列。标号列在窄屏收窄（只留 2 个字符宽），在宽屏给足，
 * 但**不隐藏**——「这段是谁说的」不能靠对齐猜。
 */
.turn {
  display: grid;
  grid-template-columns: 4.5em 1fr;
  gap: var(--s4);
  padding: var(--s5) 0;
  border-top: 1px solid var(--line);
}

@media (max-width: 560px) {
  .turn {
    grid-template-columns: 2.6em 1fr;
    gap: var(--s3);
  }
}

.turn__gutter {
  padding-top: 2px;
}

.turn__from {
  font-size: var(--t-caption);
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.turn__from--mark {
  color: var(--accent);
}

.turn__body {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
}

.grow {
  flex: 1;
}

/* 用户消息：贴了日志就用等宽保留原样（缩进是信息），否则按正文 */
.user-text {
  white-space: pre-wrap;
  max-width: var(--measure);
}

.user-log {
  margin: 0;
  padding: var(--s3);
  background: var(--bg-deep);
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: var(--r1);
  font-family: var(--font-log);
  font-size: var(--t-caption);
  line-height: var(--lh-log);
  white-space: pre;
  overflow-x: auto;
  max-height: 40vh;
}

.waiting {
  font-size: var(--t-small);
  color: var(--text-2);
}

.waiting__dots {
  animation: dots 1.6s steps(4, end) infinite;
}

@keyframes dots {
  0% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}

.err {
  display: flex;
  gap: var(--s2);
  align-items: flex-start;
  padding: var(--s3);
  border-left: 3px solid var(--sev-error);
  background: var(--sev-error-wash);
  font-size: var(--t-small);
  color: var(--text);
}

.err--soft {
  border-left-color: var(--sev-warn);
  background: var(--sev-warn-wash);
}

.score {
  border-top: 1px solid var(--line);
  padding-top: var(--s3);
}

.score__sum {
  cursor: pointer;
  font-size: var(--t-caption);
  color: var(--text-3);
  list-style: none;
}

.score__sum::-webkit-details-marker {
  display: none;
}

.score__sum::before {
  content: '▸ ';
  color: var(--text-3);
}

.score[open] .score__sum::before {
  content: '▾ ';
}

.score__list {
  list-style: none;
  margin-top: var(--s3);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}

.score__item {
  display: flex;
  gap: var(--s3);
  font-size: var(--t-caption);
  color: var(--text-2);
  max-width: var(--measure);
}

.score__pts {
  flex: none;
  color: var(--sev-warn);
}

.score__missing {
  margin-top: var(--s3);
  font-size: var(--t-caption);
  color: var(--sev-warn);
}
</style>
