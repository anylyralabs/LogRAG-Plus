<script setup lang="ts">
/**
 * 已绑定日志、尚未提问时的第一屏。
 *
 * 与入口页刻意不同：这里已经有现场材料，用户需要的不是「怎么上传」，
 * 而是「这份日志大概是什么情况」与「我可以先问什么」。
 *
 * 三个建议问题取自真实的排查起点（崩溃点、模组、渲染器），
 * 点击即发送——比让用户自己想措辞更省事。
 */
import { computed } from 'vue'
import { ArrowUpRight, FileText } from 'lucide-vue-next'
import { useLogStore } from '@/stores/log'

const emit = defineEmits<{ ask: [text: string] }>()

const log = useLogStore()

const suggestions = computed(() => {
  const list = ['这份日志为什么崩溃？先给根因，再给处理步骤。']
  const parsed = log.parsed
  const hasCrash = parsed?.sections.some((s) => s.role === '崩溃现场') ?? false
  if (hasCrash) list.push('崩溃报告里的 Problematic frame 说明了什么？')
  list.push('有没有模组版本或依赖冲突？')
  list.push('如果暂时不想折腾，最省事的绕过办法是什么？')
  return list.slice(0, 3)
})

const counts = computed(() => log.parsed?.counts ?? { error: 0, warn: 0 })
const sectionCount = computed(() => log.sections.length)
</script>

<template>
  <div class="start">
    <header class="start__head">
      <div class="start__id">
        <FileText :size="14" aria-hidden="true" />
        <code class="num">{{ log.logId }}</code>
        <span v-if="log.meta?.source" class="badge">{{ log.meta.source }}</span>
      </div>
      <h1 class="start__title">日志已经在案卷里了。</h1>
      <p class="start__lead">
        右侧可以逐行查看原文、按错误行跳转、选中片段引用给我。
        直接问一句就能开始——不需要重新上传。
      </p>
      <dl class="facts">
        <div class="facts__item">
          <dt>行数</dt>
          <dd class="num">{{ log.totalLines }}</dd>
        </div>
        <div class="facts__item">
          <dt>分节</dt>
          <dd class="num">{{ sectionCount }}</dd>
        </div>
        <div class="facts__item">
          <dt>错误</dt>
          <dd class="num facts__err">{{ counts.error }}</dd>
        </div>
        <div class="facts__item">
          <dt>警告</dt>
          <dd class="num facts__warn">{{ counts.warn }}</dd>
        </div>
      </dl>
    </header>

    <section class="asks">
      <div class="label">可以先问</div>
      <button
        v-for="(question, i) in suggestions"
        :key="i"
        type="button"
        class="ask"
        @click="emit('ask', question)"
      >
        <span class="ask__no num">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="ask__text">{{ question }}</span>
        <ArrowUpRight :size="13" class="ask__icon" aria-hidden="true" />
      </button>
    </section>
  </div>
</template>

<style scoped>
.start {
  max-width: 620px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-4);
}

.start__head {
  padding-bottom: var(--sp-5);
  border-bottom: 1px solid var(--rule);
}

.start__id {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.start__title {
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: 1.35;
}

.start__lead {
  max-width: 28em;
  margin-top: var(--sp-2);
  color: var(--ink-2);
  line-height: var(--lh-body);
}

.facts {
  display: flex;
  gap: var(--sp-5);
  margin-top: var(--sp-4);
}

.facts__item {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.facts__item dt {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.facts__item dd {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.facts__err {
  color: var(--danger);
}

.facts__warn {
  color: var(--warn);
}

.asks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-5);
}

.asks .label {
  margin-bottom: var(--sp-2);
}

.ask {
  display: grid;
  grid-template-columns: 2rem 1fr auto;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  padding: 10px 0;
  border-bottom: 1px solid var(--rule);
  color: var(--ink-2);
  text-align: left;
}

.ask:hover {
  color: var(--accent);
}

.ask__no {
  color: var(--ink-4);
  font-size: var(--fs-micro);
}

.ask__text {
  line-height: 1.65;
}

.ask__icon {
  color: var(--ink-4);
  align-self: center;
}

.ask:hover .ask__icon {
  color: var(--accent);
}

@media (max-width: 719px) {
  .start {
    padding: var(--sp-5) var(--sp-3);
  }

  .facts {
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
}
</style>
