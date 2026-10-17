<script setup lang="ts">
/**
 * 对话页（产品主入口）。
 *
 * ## 版面：日志在左、对话在右（宽屏），日志在上、对话在下（窄屏）
 *
 * 三条进入路径都要落到同一页：
 *
 * 1. `agent.logshare.cn/logshare/{日志ID}`（LogShare 跳转）→ 路由参数 `logId`
 * 2. `agent.logshare.cn/logshare/?log={日志ID}`（外部系统拼链接）→ 查询参数
 * 3. `agent.logshare.cn/logshare/`（独立使用）→ 用户自己上传或粘贴
 *
 * 「日志是常驻的一栏」而不是「点开才出现的浮层」，是因为**引用日志里的某几行**
 * 是本产品的核心动作：一份 2600 行的日志与一个聊天框若不同屏，用户就得在
 * 两者之间来回切换、凭记忆记行号。窄屏放不下两栏，于是日志折成一条摘要条，
 * 需要时展开（占 40vh）——牺牲一点阅读面积，保住「看得到日志」这件事。
 *
 * ## 自动滚动只在用户本来就在底部时生效
 *
 * 否则用户往上翻看证据时会被流式输出一直拽下来，那是移动端最恼人的体验。
 *
 * ## 状态行放在输入框之上
 *
 * 正在调用哪个工具、第几轮，是「它还在干活」的唯一凭据。放在消息流末尾会变成
 * 「翻到底才知道跑完了」；贴在输入框上沿则始终在视野里，像仪器的读数。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import Composer, { type Quote } from '../components/Composer.vue';
import EntryPlate from '../components/EntryPlate.vue';
import Icon from '../components/Icon.vue';
import LogPane from '../components/LogPane.vue';
import MessageItem from '../components/MessageItem.vue';
import { useChat } from '../stores/chat.ts';
import { useSettings } from '../stores/settings.ts';

const props = defineProps<{ logId?: string }>();

const route = useRoute();
const chat = useChat();
const settings = useSettings();

const scroller = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const uploadError = ref<string | null>(null);
const uploadBusy = ref(false);
const pinnedToBottom = ref(true);
const quotes = ref<Quote[]>([]);
const folded = ref(true);
const pasteOpen = ref(false);
const pasteText = ref('');

/** 首次进入时按 URL 绑定日志 */
onMounted(async () => {
  const idFromRoute = props.logId ?? (typeof route.query['log'] === 'string' ? route.query['log'] : undefined);
  if (idFromRoute !== undefined && idFromRoute.trim() !== '') chat.useLogId(idFromRoute);

  const sessionFromQuery = typeof route.query['session'] === 'string' ? route.query['session'] : undefined;
  if (sessionFromQuery !== undefined && sessionFromQuery !== '') {
    const err = await chat.replaySession(sessionFromQuery);
    if (err !== null) uploadError.value = err;
  }
});

const messages = computed(() => chat.messages.value);
const hasLog = computed(() => chat.hasLog.value);
const empty = computed(() => messages.value.length === 0);

const EXAMPLES = [
  '为什么会崩？给出根因和解决步骤',
  '是哪个模组的问题？',
  '这个报错我看不懂，用大白话解释一下',
];

/* ── 滚动 ─────────────────────────────────────────────── */

function onScroll(): void {
  const node = scroller.value;
  if (node === null) return;
  pinnedToBottom.value = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

async function scrollToBottom(force = false): Promise<void> {
  if (!force && !pinnedToBottom.value) return;
  await nextTick();
  const node = scroller.value;
  if (node !== null) node.scrollTop = node.scrollHeight;
}

watch(() => messages.value.length, () => void scrollToBottom(true));
watch(
  () => {
    const last = messages.value[messages.value.length - 1];
    return last === undefined ? '' : `${last.content.length}:${last.items.length}`;
  },
  () => void scrollToBottom(),
);

/* ── 日志入口 ─────────────────────────────────────────── */

function pickFile(): void {
  fileInput.value?.click();
}

async function onFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = input.files === null ? [] : Array.from(input.files);
  input.value = '';
  if (files.length === 0) return;

  uploadError.value = null;
  uploadBusy.value = true;
  try {
    const err = await chat.uploadFiles(files);
    if (err !== null) uploadError.value = err;
  } finally {
    uploadBusy.value = false;
  }
}

function submitPaste(): void {
  const t = pasteText.value.trim();
  if (t === '') return;
  chat.useTextAsLog(t);
  pasteText.value = '';
  pasteOpen.value = false;
}

function clearLog(): void {
  chat.setLog(null);
  quotes.value = [];
}

/* ── 对话 ─────────────────────────────────────────────── */

/**
 * 把引用的日志行拼进发言。
 *
 * 拼成「引用日志 X 第 a–b 行」+ 围栏代码块，而不是把行直接倒进正文：模型需要
 * 知道这几行是**从这份日志的哪个位置**取出来的（它可能正在别处找线索），
 * 而纯文本混排会丢掉这个坐标信息。
 */
function composeMessage(text: string): string {
  const body = text.trim();
  if (quotes.value.length === 0) return body;
  const blocks = quotes.value.map((q) => `引用日志 ${q.label}：\n\`\`\`\n${q.text}\n\`\`\``);
  return body === '' ? blocks.join('\n\n') : `${body}\n\n${blocks.join('\n\n')}`;
}

async function handleSend(text: string): Promise<void> {
  if (text.trim() === '' && quotes.value.length === 0) return;
  const payload = composeMessage(text);
  quotes.value = [];
  await chat.send(payload);
}

function addQuote(q: Quote): void {
  // 同一段重复引用没有意义，但不同段必须都能留下
  if (quotes.value.some((x) => x.label === q.label)) return;
  quotes.value = [...quotes.value, q];
}

const pasteChars = computed(() => pasteText.value.length);
</script>

<template>
  <div class="cp" :class="{ 'cp--railless': !hasLog }">
    <!-- 日志栏：宽屏常驻在左，窄屏折成摘要条 -->
    <aside v-if="hasLog" class="rail" :class="{ 'rail--folded': folded }">
      <button
        v-if="folded"
        type="button"
        class="rail__fold"
        @click="folded = false"
      >
        <Icon name="file" :size="14" />
        <span class="mono rail__fold-id">{{ chat.log.value?.logId ?? chat.log.value?.label ?? '日志' }}</span>
        <span class="meta">{{ chat.log.value?.lines ?? 0 }} 行</span>
        <span class="grow" />
        <span class="meta">展开日志</span>
        <Icon name="chevronDown" :size="14" />
      </button>
      <button
        v-else
        type="button"
        class="rail__fold rail__fold--hide"
        @click="folded = true"
      >
        <span class="meta">收起日志</span>
        <Icon name="chevronUp" :size="14" />
      </button>

      <LogPane :log="chat.log.value" @quote="addQuote" @clear="clearLog" />
    </aside>

    <div class="col">
      <div ref="scroller" class="scroll" @scroll="onScroll">
        <div class="inner" :class="{ 'inner--bottom': hasLog && empty }">
          <!-- 提示：脱敏与去重备注（服务端说的，如实转达） -->
          <ul v-if="chat.uploadNotes.value.length > 0" class="notes">
            <li v-for="(n, i) in chat.uploadNotes.value" :key="i" class="notes__item rail rail--info">
              <span>{{ n }}</span>
            </li>
          </ul>

          <div v-if="uploadError !== null" class="notice notice--err rail rail--error">
            <Icon name="alert" :size="15" />
            <span>{{ uploadError }}</span>
          </div>

          <!-- 未绑定日志：讲清三条入口，而不是放一个欢迎横幅 -->
          <EntryPlate
            v-if="!hasLog && empty"
            @use-id="(id) => chat.useLogId(id)"
            @pick-file="pickFile"
            @open-paste="pasteOpen = true"
          />

          <!-- 已绑定日志但没有对话：给三个可以直接点的问法 -->
          <section v-else-if="hasLog && empty" class="starters">
            <h2 class="starters__h">先问一句，或者直接点一个：</h2>
            <div class="starters__list">
              <button
                v-for="ex in EXAMPLES"
                :key="ex"
                type="button"
                class="starter"
                :disabled="chat.sending.value"
                @click="handleSend(ex)"
              >
                <Icon name="arrowRight" :size="14" />
                <span>{{ ex }}</span>
              </button>
            </div>
            <p class="hint">
              分析会自己检索知识库与官方仓库，必要时把日志翻一遍；结论里会写清根因、
              按顺序的处置步骤，以及每条判断依据的日志位置。
            </p>
            <p v-if="!settings.providerReady.value" class="hint">
              当前使用服务端默认模型；想用自己的模型可在右上角设置里配置。
            </p>
          </section>

          <MessageItem v-for="m in messages" :key="m.id" :message="m" />
        </div>
      </div>

      <!-- 状态行：正在调用什么、第几轮。贴在输入框上沿，始终在视野里 -->
      <div v-if="chat.phase.value !== ''" class="phase">
        <i class="dot dot--accent dot--live" />
        <span class="mono phase__text">{{ chat.phase.value }}</span>
        <span class="meta">{{ chat.remaining.value === null ? '' : `本机今日剩 ${chat.remaining.value} 轮` }}</span>
      </div>
      <div v-else-if="chat.nearLimit.value" class="phase phase--warn">
        <i class="dot dot--warn" />
        <span class="mono phase__text">今日额度快用完了（剩 {{ chat.remaining.value ?? 0 }} 轮）</span>
      </div>

      <div class="composer">
        <Composer
          :busy="chat.sending.value"
          :quotes="quotes"
          :has-log="hasLog"
          @send="handleSend"
          @stop="chat.stop()"
          @remove-quote="(i) => (quotes = quotes.filter((_, j) => j !== i))"
          @pick-file="pickFile"
          @open-paste="pasteOpen = true"
          @open-settings="() => {}"
        />
      </div>
    </div>

    <input
      ref="fileInput"
      class="sr-only"
      type="file"
      multiple
      accept=".log,.txt,.zip,.json,.yml,.yaml,.toml,.cfg,.properties,.md"
      @change="onFiles"
    />

    <!-- 粘贴：单独一块，因为粘贴的内容可能几百行 -->
    <div v-if="pasteOpen" class="modal">
      <div class="modal__backdrop" @click="pasteOpen = false" />
      <div class="modal__panel" role="dialog" aria-modal="true" aria-label="粘贴日志文本">
        <header class="modal__head">
          <span class="mono modal__title">粘贴日志</span>
          <span class="grow" />
          <button type="button" class="icon-btn" aria-label="关闭" @click="pasteOpen = false">
            <Icon name="x" :size="16" />
          </button>
        </header>
        <textarea
          v-model="pasteText"
          class="textarea modal__ta"
          rows="10"
          placeholder="把启动器里复制的日志粘在这里。内容不会写入服务器，只随本次对话送出。"
        />
        <footer class="modal__foot">
          <span class="meta">{{ pasteChars }} 字符</span>
          <span class="grow" />
          <button type="button" class="btn" @click="pasteOpen = false">取消</button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="pasteText.trim() === ''"
            @click="submitPaste"
          >
            使用这段文本
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
/**
 * 版面：宽屏两栏（日志 / 对话），窄屏一列（日志在上）。
 * 用 grid 的 `auto minmax(0,1fr)` 而不是 flex，是为了让两边的滚动各自独立：
 * 日志栏滚它自己，对话列滚它自己，互不带动。
 */
.cp {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: calc(100dvh - var(--rig-h));
  min-height: 0;
}

.cp--railless {
  grid-template-rows: minmax(0, 1fr);
}

@media (min-width: 1024px) {
  .cp {
    grid-template-columns: minmax(340px, 42%) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .cp--railless {
    grid-template-columns: minmax(0, 1fr);
  }
}

.rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--s3);
  border-bottom: 1px solid var(--line);
  gap: var(--s3);
}

@media (min-width: 1024px) {
  .rail {
    border-bottom: none;
    border-right: 1px solid var(--line);
    padding: var(--s4);
    overflow: hidden;
  }
}

/* 窄屏折叠：只留摘要条。宽屏不折 */
.rail--folded {
  padding: var(--s2) var(--s3);
}

@media (max-width: 1023px) {
  .rail--folded .rail__fold + * {
    display: none;
  }
  .rail--folded {
    overflow: hidden;
  }
}

.rail__fold {
  display: flex;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  min-height: 34px;
  text-align: left;
  color: var(--text-2);
}

/* 宽屏不需要摘要条（面板本来就一直开着） */
@media (min-width: 1024px) {
  .rail__fold {
    display: none;
  }
}

.rail__fold-id {
  font-size: var(--t-small);
  color: var(--text);
}

.rail__fold--hide {
  justify-content: flex-end;
}

.grow {
  flex: 1;
}

.col {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.inner {
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: var(--s4) var(--s4) var(--s6);
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}

@media (min-width: 1024px) {
  .inner {
    padding: var(--s6) var(--s5) var(--s7);
  }
}

/**
 * 已绑定日志但还没开口时，把三个问法推到输入框上沿。
 * 宽屏上若把它们留在顶部，中间会空出六七百像素——那不是留白，是没做完的样子；
 * 贴着输入框则读作「日志在这儿，随时可以问」。
 */
.inner--bottom {
  min-height: 100%;
  justify-content: flex-end;
}

.notes {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}

.notes__item {
  font-size: var(--t-caption);
  color: var(--text-2);
  line-height: 1.6;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--s2);
  padding: var(--s2) var(--s3);
  font-size: var(--t-small);
  background: var(--sev-error-wash);
}

.starters {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
  padding-top: var(--s4);
  border-top: 1px solid var(--line);
}

.starters__h {
  font-size: var(--t-h5);
  font-weight: 400;
  color: var(--text-2);
  font-family: var(--font-text);
}

.starters__list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}

/* 问法是一列可点的行，不是一排圆角药丸——药丸在窄屏上会挤成两行还显示不全 */
.starter {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s3) var(--s2);
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-size: var(--t-small);
  color: var(--text-2);
  transition: background 120ms ease, color 120ms ease;
}

@media (hover: hover) {
  .starter:hover {
    background: var(--surface-2);
    color: var(--text);
  }
}

.starter:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.phase {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s2) var(--s4);
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.phase--warn {
  color: var(--sev-warn);
}

.phase--warn .phase__text {
  color: var(--sev-warn);
}

.phase__text {
  font-size: var(--t-caption);
  color: var(--text-2);
}

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

.composer {
  padding: var(--s3) var(--s4);
  padding-bottom: calc(var(--s3) + env(safe-area-inset-bottom));
  background: var(--bg);
  border-top: 1px solid var(--line);
}

/* 输入区与对话列同宽，但不跟随 inner 的居中宽度（避免宽屏上输入框缩在中间） */
@media (min-width: 1024px) {
  .composer {
    padding: var(--s4) var(--s5);
  }
}

.modal {
  position: fixed;
  inset: 0;
  z-index: 60;
}

.modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 6, 10, 0.55);
}

.modal__panel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(720px, calc(100% - 2 * var(--s4)));
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  padding: var(--s4);
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: var(--r1);
  box-shadow: var(--shadow-pop);
}

.modal__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
}

.modal__title {
  font-size: var(--t-h5);
}

.modal__ta {
  min-height: 30vh;
}

.modal__foot {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
</style>
