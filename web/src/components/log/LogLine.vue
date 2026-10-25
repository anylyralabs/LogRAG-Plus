<script setup lang="ts">
/**
 * 日志的一行。
 *
 * 固定高度（20px）不折行：虚拟滚动依赖它，且「一屏多少行」是读日志的直觉。
 * 长行横向滚动；行号等宽、可选中；整行可键盘操作。
 */
import type { Severity } from '@/lib/logdoc'

defineProps<{
  lineNo: number
  text: string
  severity: Severity
  picked: boolean
  pickEdge: boolean
  isHit: boolean
  highlight: boolean
}>()

const emit = defineEmits<{ pick: [line: number] }>()
</script>

<template>
  <div
    class="line"
    :class="[
      `line--${severity}`,
      { 'line--picked': picked, 'line--edge': pickEdge, 'line--hit': isHit, 'line--flash': highlight },
    ]"
    role="button"
    tabindex="0"
    :aria-label="`第 ${lineNo} 行`"
    @click="emit('pick', lineNo)"
    @keydown.enter.prevent="emit('pick', lineNo)"
    @keydown.space.prevent="emit('pick', lineNo)"
  >
    <span class="line__no num">{{ lineNo }}</span>
    <span class="line__text">{{ text }}</span>
  </div>
</template>

<style scoped>
.line {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  width: 100%;
  height: 20px;
  line-height: 20px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre;
  cursor: text;
  outline: none;
}

.line:hover {
  background: var(--paper-inset);
}

.line:focus-visible {
  outline: 1px solid var(--focus);
  outline-offset: -1px;
}

.line__no {
  position: sticky;
  left: 0;
  z-index: 1;
  flex: none;
  width: 4.2em;
  padding-right: 8px;
  border-right: 1px solid var(--rule);
  background: var(--paper-sunken);
  color: var(--ink-4);
  font-size: 10px;
  text-align: right;
  user-select: none;
}

.line__text {
  flex: 1;
  padding: 0 10px;
  color: var(--ink-2);
}

.line--error .line__text {
  color: var(--danger);
}

.line--error .line__no {
  color: var(--danger);
}

.line--warn .line__text {
  color: var(--warn);
}

.line--dim .line__text {
  color: var(--ink-4);
}

.line--picked {
  background: var(--selection);
}

.line--picked .line__no {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.line--edge {
  box-shadow: inset 2px 0 0 var(--accent);
}

.line--hit .line__text {
  background: var(--search);
}

.line--flash {
  animation: flash 1.8s var(--ease);
}

@keyframes flash {
  0%,
  30% {
    background: var(--selection);
  }
  100% {
    background: transparent;
  }
}
</style>
