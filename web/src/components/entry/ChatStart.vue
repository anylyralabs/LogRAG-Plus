<script setup lang="ts">
/**
 * 聊天首页的空状态。
 *
 * 打开就能提问：日志是**可选附件**，不是入场券。把「输入编号 / 上传 / 粘贴」
 * 三件套摆在首屏，等于先让人填一张表才能开始问问题。
 *
 * 同时把口径说清楚：没有日志时结论会标注「未核实」，不会假装看过现场。
 */
import { ArrowUpRight, MessageSquare } from 'lucide-vue-next'

const props = defineProps<{ hasProvider?: boolean }>()
void props

const emit = defineEmits<{ ask: [text: string] }>()

const suggestions = [
  'Fabric 和 Forge 的模组能混装吗？',
  '游戏一启动就崩溃，自己可以先查什么？',
  '手机玩 Minecraft 用哪个渲染器更稳？',
]
</script>

<template>
  <div class="chat-start">
    <header class="chat-start__head">
      <MessageSquare :size="15" aria-hidden="true" />
      <span class="label label--plain">LogRAG+</span>
    </header>

    <h1 class="chat-start__title">把问题说清楚，剩下的交给它查。</h1>
    <p class="chat-start__lead">
      可以直接提问，也可以把崩溃日志拖进来。没有日志时，结论会明确标注「未核实」，
      不会假装看过现场；给了日志，它会指出依据在具体哪一行。
    </p>

    <section class="asks">
      <div class="label">可以从这里开始</div>
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
.chat-start {
  max-width: 620px;
  margin: 0 auto;
  padding: var(--sp-7) var(--sp-4) var(--sp-5);
}

.chat-start__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-3);
}

.chat-start__title {
  margin-top: var(--sp-3);
  max-width: 18em;
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: 1.4;
}

.chat-start__lead {
  max-width: 30em;
  margin-top: var(--sp-2);
  color: var(--ink-2);
  line-height: var(--lh-body);
}

.asks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--rule);
}

.asks .label {
  margin-bottom: var(--sp-1);
}

.ask {
  display: grid;
  grid-template-columns: 2rem 1fr auto;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  padding: 9px 0;
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
  .chat-start {
    padding: var(--sp-5) var(--sp-3);
  }
}
</style>
