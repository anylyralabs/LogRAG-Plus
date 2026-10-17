<script setup lang="ts">
/**
 * 输入区。
 *
 * ## 两处刻意的设计
 *
 * 1. **证据条在输入框之上，不在消息里**。用户从日志面板「引用几行」之后，
 *    那几行会先变成输入框上方的一条 chip（`main.log:623-631`），他还能继续写字、
 *    还能撤掉。若直接把它拼进输入框文本，用户得手工去删——日志行删起来很烦。
 * 2. **发送键与停止键是同一个位置**。分析可能跑三分钟，停止必须是第一时间
 *    能找到的动作，而不是藏在别处的次要按钮。
 *
 * 占位文案写成「说说你想知道什么」而不是「输入消息」：后者对「该写什么」零帮助。
 */
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';

export interface Quote {
  label: string;
  text: string;
}

const props = defineProps<{
  busy: boolean;
  quotes: Quote[];
  /** 有没有绑定日志（决定占位文案） */
  hasLog: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  stop: [];
  removeQuote: [index: number];
  pickFile: [];
  openPaste: [];
  openSettings: [];
}>();

const text = ref('');
const box = ref<HTMLTextAreaElement | null>(null);

const canSend = computed(() => text.value.trim() !== '' && !props.busy);

async function grow(): Promise<void> {
  await nextTick();
  const el = box.value;
  if (el === null) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.3))}px`;
}

watch(text, () => void grow());

function submit(): void {
  if (!canSend.value) return;
  emit('send', text.value);
  text.value = '';
  void grow();
}

/** Enter 发送、Shift+Enter 换行；中文输入法组合中不触发 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  if (window.matchMedia('(pointer: coarse)').matches) return; // 触屏不劫持回车
  e.preventDefault();
  submit();
}

function fillQuote(q: Quote): void {
  text.value = text.value.trim() === '' ? q.text : `${text.value}\n\n${q.text}`;
}

defineExpose({ fillQuote });
</script>

<template>
  <div class="composer">
    <div v-if="quotes.length > 0" class="quotes">
      <span
        v-for="(q, i) in quotes"
        :key="`${q.label}-${i}`"
        class="pill quote"
      >
        <Icon name="quote" :size="12" />
        <span class="mono quote__label">{{ q.label }}</span>
        <button
          type="button"
          class="quote__x"
          :aria-label="`移除引用 ${q.label}`"
          @click="emit('removeQuote', i)"
        >
          <Icon name="x" :size="12" />
        </button>
      </span>
    </div>

    <textarea
      ref="box"
      v-model="text"
      class="composer__input"
      rows="1"
      :placeholder="hasLog ? '这份日志怎么回事？也可以先问「哪里最先出错」' : '说说你遇到了什么问题'"
      :disabled="busy"
      @keydown="onKeydown"
    />

    <div class="composer__bar">
      <button class="icon-btn" type="button" title="上传日志文件" @click="emit('pickFile')">
        <Icon name="upload" :size="16" />
      </button>
      <button class="icon-btn" type="button" title="粘贴日志文本" @click="emit('openPaste')">
        <Icon name="clipboard" :size="16" />
      </button>
      <button class="icon-btn" type="button" title="设置" @click="emit('openSettings')">
        <Icon name="settings" :size="16" />
      </button>
      <span class="grow" />
      <button v-if="busy" class="btn btn--danger" type="button" @click="emit('stop')">
        <Icon name="stop" :size="14" />停止
      </button>
      <button v-else class="btn btn--primary" type="button" :disabled="!canSend" @click="submit">
        <Icon name="send" :size="14" />发送
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding: var(--s3);
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: var(--r1);
}

.composer:focus-within {
  border-color: var(--focus);
}

.quotes {
  display: flex;
  gap: var(--s2);
  flex-wrap: wrap;
}

.quote {
  padding-right: 2px;
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-quiet);
}

.quote__label {
  font-size: var(--t-caption);
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quote__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--r-pill);
  color: var(--accent);
}

.quote__x:hover {
  background: var(--accent);
  color: var(--on-accent);
}

.composer__input {
  width: 100%;
  border: none;
  background: transparent;
  padding: var(--s2) 0;
  font-size: var(--t-body);
  line-height: 1.6;
  resize: none;
  max-height: 30vh;
}

.composer__input:focus {
  outline: none;
}

.composer__input::placeholder {
  color: var(--text-3);
}

.composer__bar {
  display: flex;
  align-items: center;
  gap: var(--s2);
}

.grow {
  flex: 1;
}
</style>
