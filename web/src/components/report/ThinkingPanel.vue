<script setup lang="ts">
/**
 * 思维链：模型推理过程的连续文本。
 *
 * ## 与调查步骤分开的原因
 * 步骤是**可枚举的动作**（查了什么、拿到什么），思维链是**连续的自由文本**。
 * 两者混在一个折叠块里时，滚动的长思维链会把步骤挤出视野，用户看不出
 * 「它现在在做什么」；反过来，步骤的刷屏也会打断阅读推理。
 *
 * ## 自动滚动
 * 流式期间固定在几十像素高的窗口内自动跟随到底部——这与主流 Agent 界面一致：
 * 让用户看到「它在想」，但不让上万字的思考占领版面。用户上滚则停止跟随
 * （界面不主动改变阅读位置），回到底部自动恢复。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{
  reasoning: string
  thinkingTotal: number
  live: boolean
}>()

const touched = ref(false)
const open = ref(false)
const body = ref<HTMLElement | null>(null)
const pinned = ref(true)

const mode = computed<'live' | 'open' | 'closed'>(() => {
  if (open.value) return 'open'
  if (props.live && !touched.value) return 'live'
  return 'closed'
})

const summary = computed(() => `${props.thinkingTotal} 字`)

watch(
  () => props.live,
  (live) => {
    if (touched.value) return
    if (!live) open.value = false
  },
  { immediate: true },
)

function onScroll(): void {
  const node = body.value
  if (node === null) return
  pinned.value = node.scrollHeight - node.scrollTop - node.clientHeight < 40
}

function follow(): void {
  const node = body.value
  if (node === null || !pinned.value) return
  node.scrollTop = node.scrollHeight
}

/**
 * 跟随到底。
 *
 * 双帧：先等 DOM 更新，再等一次布局，然后才量 scrollHeight。
 * 只等 nextTick 会在长文本流式时停在「倒数第二行」——差得非常明显。
 */
watch(
  () => props.reasoning.length,
  () => {
    if (mode.value === 'closed') return
    void nextTick(() => {
      follow()
      requestAnimationFrame(follow)
    })
  },
)

/** 展开/进入输出态时直接落到最新（用户想看的是当前进度） */
watch(
  () => mode.value,
  (next) => {
    if (next === 'closed') return
    pinned.value = true
    void nextTick(() => {
      const node = body.value
      if (node !== null) node.scrollTop = node.scrollHeight
    })
  },
)

function toggle(): void {
  touched.value = true
  open.value = !open.value
}
</script>

<template>
  <div v-if="thinkingTotal > 0" class="thinking" :class="[`thinking--${mode}`]">
    <button
      type="button"
      class="thinking__head"
      :aria-expanded="open"
      @click="toggle"
    >
      <ChevronDown v-if="open" :size="13" aria-hidden="true" />
      <ChevronRight v-else :size="13" aria-hidden="true" />
      <span class="thinking__title">{{ live ? '正在思考' : '思维链' }}</span>
      <span class="num thinking__meta">{{ summary }}</span>
      <span v-if="live" class="dot dot--live thinking__pulse" aria-hidden="true" />
    </button>

    <div
      v-if="mode !== 'closed'"
      ref="body"
      class="thinking__body"
      :class="{ 'thinking__body--preview': mode === 'live' }"
      @scroll.passive="onScroll"
    >
      {{ reasoning }}
    </div>
  </div>
</template>

<style scoped>
.thinking {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thinking__head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 26px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: left;
}

.thinking__head:hover {
  color: var(--ink-2);
}

.thinking__title {
  color: var(--ink-2);
}

.thinking--live .thinking__title {
  color: var(--accent-ink);
}

.thinking__meta {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.thinking__pulse {
  margin-left: auto;
  color: var(--accent);
}

/*
 * 自动滚动的固定窗口。
 *
 * 输出中只给约 5 行：上万字的思维链若整段铺开，会把输入框和结论顶出屏幕。
 * 用户点开后放宽到 420px，仍可滚动。
 */
.thinking__body {
  max-height: 420px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: var(--paper-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scroll-behavior: auto;
}

.thinking__body--preview {
  max-height: 104px;
  mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent);
}

@media (max-width: 719px) {
  .thinking__body--preview {
    max-height: 88px;
  }

  .thinking--open .thinking__body {
    max-height: 320px;
  }
}
</style>
