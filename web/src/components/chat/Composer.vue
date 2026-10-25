<script setup lang="ts">
/**
 * 输入区。
 *
 * ## 形态：圆角输入框，聚焦时展开
 * 默认是一行矮框（视觉上像「随时可以插一句」），聚焦或已输入时展开成多行大框，
 * 右侧动作按钮也随之完整显示。这样静止时它不抢版面，要说话时它成为主角。
 *
 * 之前是「下划线 + `›` 提示符」的命令行形态，静止状态下几乎看不出这里可以输入；
 * 移动端更明显——没有光标就分不清那是输入框还是说明文字。
 *
 * ## 行为细节
 *  - Enter 发送 / Shift+Enter 换行，但 **IME 组合期间不发送**（中文输入法的常见坑）；
 *  - 大段粘贴自动识别为日志，提示「作为日志附件分析」；
 *  - 流式中显示停止按钮，并保留草稿。
 */
import { computed, nextTick, ref } from 'vue'
import { ArrowUp, FilePlus2, Paperclip, Plus, Square, X } from 'lucide-vue-next'
import { looksLikeLog } from '@/lib/upload'

const props = defineProps<{
  busy: boolean
  phase: string
  hasLog: boolean
  /** 引用的日志片段（已格式化） */
  quote: string
  disabled?: boolean
  /** 上一轮以「向你提问」结束：输入区提示改成等待补充 */
  awaitingAnswer?: boolean
  /** 已有会话：加号表示「追加材料」，否则表示「上传并新建」 */
  sessionActive?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  abort: []
  upload: []
  'clear-quote': []
  'use-as-log': [text: string]
}>()

const text = ref('')
const el = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)

const canSend = computed(() => !props.busy && !props.disabled && text.value.trim() !== '')
const pasteIsLog = computed(
  () => text.value.length > 0 && looksLikeLog(text.value) && !props.hasLog,
)

/** 展开态：聚焦、有内容、或引用了日志片段 */
const expanded = computed(
  () => focused.value || text.value.trim() !== '' || props.quote !== '' || props.busy,
)

function submit(): void {
  if (!canSend.value) return
  const v = text.value.trim()
  if (v === '') return
  emit('send', v)
  text.value = ''
  nextTick(() => resize())
}

function resize(): void {
  const node = el.value
  if (node === null) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, 200)}px`
}

function onKeydown(e: KeyboardEvent): void {
  // isComposing：中文输入法选字时按 Enter 不应发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

function focus(): void {
  el.value?.focus()
  focused.value = true
}

/**
 * blur 延迟处理。
 *
 * 点击动作按钮时，`blur` 会先于 `click` 触发；若立刻把 focused 置 false，
 * 展开态会在点击生效前塌回去，用户看到按钮「跳了一下」。
 * 延迟一个宏任务即可让 click 先完成。
 */
function onBlur(): void {
  window.setTimeout(() => {
    const node = el.value
    if (node !== null && document.activeElement === node) return
    focused.value = false
  }, 0)
}

defineExpose({ focus })
</script>

<template>
  <div class="composer-wrap" :class="{ 'composer-wrap--expanded': expanded }">
    <div v-if="quote !== ''" class="quote-chip">
      <Paperclip :size="12" aria-hidden="true" />
      <span class="quote-chip__text">已引用日志片段</span>
      <button type="button" class="quote-chip__x" aria-label="取消引用" @click="emit('clear-quote')">
        <X :size="12" aria-hidden="true" />
      </button>
    </div>

    <div v-if="pasteIsLog" class="paste-hint">
      <span>这段内容像是日志。</span>
      <button type="button" class="btn btn--sm btn--subtle" @click="emit('use-as-log', text)">
        <FilePlus2 :size="12" aria-hidden="true" />
        作为日志分析
      </button>
    </div>

    <!--
      输入框本体是 CSS Grid，加号的位置由**状态**决定（不移动 DOM）：
        · 收起：加号在发送键左侧，两者同处一行右侧 → 「+ ↑」
        · 展开：输入区占满首行，加号沉到左下、发送留在右下 → 典型对话输入框
      用 grid-template-areas 切换，而不是 v-if 复制两个按钮——复制会让焦点与
      click 目标在状态切换时丢失。
    -->
    <div class="composer" :class="{ 'composer--focus': focused, 'composer--expanded': expanded }">
      <textarea
        ref="el"
        v-model="text"
        rows="1"
        :placeholder="
          awaitingAnswer === true
            ? '回答上面的问题，或补充其他信息…'
            : hasLog
              ? '再问一句，比如「怎么彻底避免」…'
              : '直接提问，或粘贴日志内容…'
        "
        aria-label="输入问题"
        :disabled="disabled === true"
        class="composer__input"
        @input="resize"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="onBlur"
      />

      <button
        type="button"
        class="composer__attach"
        :aria-label="sessionActive === true ? '追加日志到当前会话' : '上传日志文件'"
        :title="sessionActive === true ? '追加日志（会话与链接不变）' : '上传日志'"
        :disabled="busy"
        @click="emit('upload')"
      >
        <Plus :size="15" aria-hidden="true" />
        <span class="composer__attach-text">
          {{ sessionActive === true ? '追加日志' : '上传日志' }}
        </span>
      </button>

      <button
        v-if="busy"
        type="button"
        class="composer__stop"
        aria-label="停止分析"
        title="停止"
        @click="emit('abort')"
      >
        <Square :size="14" aria-hidden="true" />
      </button>
      <button
        v-else
        type="button"
        class="composer__send"
        aria-label="发送"
        :disabled="!canSend"
        @click="submit"
      >
        <ArrowUp :size="16" aria-hidden="true" />
      </button>
    </div>

    <div class="composer__foot" aria-live="polite">
      <span v-if="disabled === true" class="composer__disabled">服务未就绪</span>
      <template v-if="busy">
        <span class="dot dot--live" aria-hidden="true" />
        <span class="composer__phase">{{ phase === '' ? '正在分析…' : phase }}</span>
      </template>
      <template v-else-if="awaitingAnswer === true">
        <span class="composer__phase composer__phase--ask">已向你提问，补充后会自动继续</span>
      </template>
      <template v-else>
        <span class="composer__keys">回车发送 · Shift+回车换行</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.composer-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.quote-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-micro);
}

.quote-chip__x {
  display: inline-flex;
  color: var(--accent-ink);
  opacity: 0.7;
}

.quote-chip__x:hover {
  opacity: 1;
}

.paste-hint {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: var(--radius-control);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-micro);
}

/*
 * 输入框本体：圆角、淡底、无边框。
 *
 * 静止：一行高（40px），右侧只留发送键，视觉上像「随时可以插一句」；
 * 展开：高度随内容增长到 200px，附件与发送并列显示。
 * 用 `background` 与 `box-shadow` 表达状态，不画边框——边框会让它看起来像表单。
 */
/*
 * 输入框：静止时是矮条，聚焦后**真的变高**。
 *
 * ## 为什么用 `:focus-within` 而不是 JS 的 focused 状态
 * 高度变化是**纯视觉反馈**，必须与浏览器真实的焦点一致。依赖 JS 状态时，
 * 一旦某个 `blur`（例如上层抢焦点、或合成事件顺序不同）没被处理，
 * 高度就不会变——实测正是这样：聚焦了但框没长大。
 * `:focus-within` 由浏览器判定，只要 input 真的拿到焦点就成立。
 */
/*
 * 输入框本体：CSS Grid，两个状态两套布局。
 *
 * 收起（单行）：
 *   ┌──────────────────────────────┬────┬────┐
 *   │ 输入（占整行）                │ + │ ↑  │
 *   └──────────────────────────────┴────┴────┘
 *
 * 展开（三行）：
 *   ┌────────────────────────────────────────┐
 *   │ 输入（三行）                            │
 *   │                                        │
 *   │                                        │
 *   │ + 上传日志                    [↑]      │
 *   └────────────────────────────────────────┘
 *
 * 用 `grid-template-areas` 切换，DOM 结构不变——按钮始终是同一个元素，
 * 焦点、hover、click 目标在状态切换时不会丢。
 */
.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas: 'input attach send';
  align-items: end;
  gap: 4px;
  padding: 6px;
  border-radius: var(--radius-field);
  background: var(--paper-inset);
  box-shadow: inset 0 0 0 1px transparent;
  transition:
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.composer--expanded,
.composer:focus-within {
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'input input'
    'attach send';
  min-height: 92px;
}

.composer:hover:not(:focus-within) {
  background: var(--paper-sunken);
}

.composer--focus {
  background: var(--paper-raised);
  box-shadow:
    inset 0 0 0 1px var(--accent-line),
    0 0 0 3px var(--accent-soft),
    var(--shadow-sm);
}

.composer__input {
  grid-area: input;
  min-width: 0;
  min-height: 32px;
  max-height: 200px;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-family: inherit;
  font-size: var(--fs-body);
  line-height: 1.55;
  resize: none;
  outline: none;
}

.composer:focus-within .composer__input {
  min-height: 80px;
}

.composer__input::placeholder {
  color: var(--ink-4);
}

/* 加号：收起时在发送键左边，展开时沉到左下角 */
/*
 * 加号：收起时在发送键左边，展开时沉到左下角。
 *
 * `align-self: end` + `justify-self: start` 是必须的：
 * grid 项的默认值会让它在展开态**拉伸占满整列**（attach 那一格横跨整行宽度），
 * 于是 hover 底色填满一整条——看起来像选中了整行，而不是一个按钮。
 */
.composer__attach {
  grid-area: attach;
  align-self: end;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  padding: 0 8px;
  border-radius: 9px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.composer__attach:hover:not(:disabled) {
  background: var(--paper-sunken);
  color: var(--ink-2);
}

.composer__attach:disabled {
  opacity: 0.45;
}

/* 收起态只要图标；展开态连文字一起给，避免加号被读成「新建对话」 */
.composer__attach-text {
  display: none;
}

.composer--expanded .composer__attach-text,
.composer:focus-within .composer__attach-text {
  display: inline;
}

/* 发送/停止同理：只占自身尺寸，不随网格拉伸 */
.composer__send,
.composer__stop {
  grid-area: send;
  align-self: end;
  justify-self: end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}

.composer__send {
  background: var(--accent);
  color: var(--paper-raised);
}

.composer__send:hover:not(:disabled) {
  background: var(--accent-ink);
}

.composer__send:disabled {
  background: var(--rule-strong);
  color: var(--paper-raised);
  opacity: 0.65;
}

.composer__stop {
  background: var(--warn-soft);
  color: var(--warn);
}

.composer__stop:hover {
  background: var(--warn);
  color: var(--paper-raised);
}

.composer__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 16px;
  padding: 0 4px;
  color: var(--ink-4);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.composer__keys {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.01em;
}

.composer__phase {
  font-size: var(--fs-micro);
}

.composer__phase--ask {
  color: var(--accent-ink);
}

.composer__link {
  margin-left: auto;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
}

.composer__link:hover:not(:disabled) {
  color: var(--accent);
  text-decoration-color: var(--accent-line);
}

.composer__disabled {
  margin-left: auto;
  color: var(--warn);
}

/* 静止时把提示行也藏掉一半：只留快捷键说明，不打扰 */
.composer-wrap:not(.composer-wrap--expanded) .composer__foot {
  opacity: 0.8;
}

@media (max-width: 599px) {
  .composer {
    padding: 5px;
  }

  .composer--expanded,
  .composer:focus-within {
    min-height: 84px;
  }

  .composer:focus-within .composer__input {
    min-height: 72px;
  }

  /*
   * 移动端：展开后仍显示「上传日志」四字。
   * 加号在小屏上极易被读成「新建对话」——用户一旦开始输入，
   * 就必须让这个入口的含义明确，而不是靠猜。
   */
  .composer--expanded .composer__attach,
  .composer:focus-within .composer__attach {
    padding: 0 10px;
    justify-content: flex-start;
  }
}
</style>
