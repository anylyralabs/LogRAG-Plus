<script setup lang="ts">
/**
 * 工作台（日志 + 报告）。
 *
 * 布局：
 *  - 宽屏：左侧会话栏 | 中间报告线程 | 右侧案卷面板；
 *  - 窄屏：会话栏与案卷都是全屏 Sheet，主列始终保持可读宽度。
 *
 * 三种进入方式：
 *  1. `/logshare/{logId}`：从 LogShare 跳转，或直接打开编号；
 *  2. `/logshare/s/{sessionId}`：纯对话会话；
 *  3. 入口页粘贴 / 上传后带草稿进来（正文只在内存里，刷新即丢）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ClipboardPaste, Upload } from 'lucide-vue-next'

import AppSidebar from '@/components/layout/AppSidebar.vue'
import AppTopBar from '@/components/layout/AppTopBar.vue'
import AskDock from '@/components/chat/AskDock.vue'
import ChatThread from '@/components/chat/ChatThread.vue'
import Composer from '@/components/chat/Composer.vue'
import ChatStart from '@/components/entry/ChatStart.vue'
import LogStart from '@/components/entry/LogStart.vue'
import DossierPanel from '@/components/log/DossierPanel.vue'
import ModalShell from '@/components/ui/ModalShell.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import { api } from '@/lib/api'
import type { HistoryEntry } from '@/lib/history'
import { prepareUpload, UploadError } from '@/lib/upload'
import { useChatStore } from '@/stores/chat'
import { useHealthStore } from '@/stores/health'
import { useLogStore } from '@/stores/log'
import { useSettingsStore } from '@/stores/settings'

const route = useRoute()
const router = useRouter()

const chat = useChatStore()
const log = useLogStore()
const health = useHealthStore()
const settings = useSettingsStore()

const settingsOpen = ref(false)
const sidebarOpen = ref(false)
const dossierOpen = ref(false)
const quote = ref('')
const uploading = ref(false)
const uploadError = ref('')
const uploadNotes = ref<string[]>([])

const composer = ref<InstanceType<typeof Composer> | null>(null)

const logId = computed(() => chat.logId)
const hasMessages = computed(() => chat.messages.length > 0)

/**
 * 待回答的追问。
 *
 * 取**最后一条**助手消息的 `asks`，并确认它之后没有用户发言——
 * 「已回答」由对话历史判定，不设额外状态字段（刷新、回放都自动正确）。
 * 已回答的追问不会消失：它仍留在那条消息里（MessageItem 里的痕迹），只是不再占输入区。
 */
const pendingAsks = computed(() => {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]
    if (m === undefined) continue
    if (m.role === 'user') return []
    if (m.role === 'assistant') {
      return m.asks.length > 0 && m.status !== 'streaming' ? m.asks : []
    }
  }
  return []
})
const showDossier = computed(() => logId.value !== '' || chat.pendingLog !== null)

const routeLogId = computed(() => {
  const raw = route.params['logId']
  return typeof raw === 'string' && raw !== '' ? raw : ''
})
const routeSessionId = computed(() => {
  const raw = route.params['sessionId']
  return typeof raw === 'string' && raw !== '' ? raw : ''
})

/** 从 URL 恢复状态 */
async function initFromRoute(): Promise<void> {
  const id = routeLogId.value
  if (id !== '') {
    if (chat.logId !== id) {
      chat.bindLog(id)
      log.reset()
      void log.load(id)
    }
    if (chat.messages.length === 0) {
      await chat.replayByLog(id)
    }
    return
  }

  const sessionId = routeSessionId.value
  if (sessionId !== '') {
    if (chat.sessionId !== sessionId || chat.messages.length === 0) {
      const ok = await chat.replay(sessionId, api.replaySession)
      if (ok) {
        if (chat.logId !== '') void log.load(chat.logId)
      } else {
        void router.replace('/')
      }
    }
    return
  }

  // `/new`：纯对话。若没有正在进行的会话、也没有粘贴草稿，就开一个干净的。
  // 有草稿时必须保留——粘贴内容只在内存里，重置会把用户刚贴的日志丢掉。
  if (route.path === '/new' && chat.pendingLog === null && chat.messages.length === 0) {
    if (chat.sessionId !== '') chat.reset()
  }
}

/** 引用的日志片段：格式化后插入输入区 */
function applyQuote(payload: { label: string; text: string }): void {
  quote.value = `引用日志 ${payload.label}：\n\`\`\`\n${payload.text}\n\`\`\``
  dossierOpen.value = false
  void nextTick(() => composer.value?.focus())
}

async function onSend(text: string): Promise<void> {
  const block = quote.value
  quote.value = ''
  await chat.send(text, {
    ...(settings.activeProvider !== undefined ? { provider: settings.activeProvider } : {}),
    ...(block !== '' ? { quote: block } : {}),
  })
}

async function onRetry(): Promise<void> {
  await chat.retryLast(settings.activeProvider)
}

/** 追问块的回答：当作一条普通用户消息发回去，不发明新协议 */
async function onAnswer(text: string): Promise<void> {
  await onSend(text)
}

/** 粘贴 → 进入工作台（正文只在内存里） */
async function onPasteLog(text: string): Promise<void> {
  // 先解绑旧日志：否则粘贴的新正文会带上旧的 logId，
  // 服务端会优先用旧日志的绑定关系，粘贴内容反而被忽略。
  chat.unbindLog()
  log.reset()
  chat.setPendingLog({ content: text, name: '粘贴的日志' })
  void log.loadLocal('粘贴的日志', text)
  if (routeLogId.value !== '' || routeSessionId.value !== '') {
    await router.push('/new')
  }
  void nextTick(() => composer.value?.focus())
}

/** 上传文件：已有会话时追加，否则新建分析 */
async function onFiles(files: FileList): Promise<void> {
  uploadError.value = ''
  uploadNotes.value = []
  uploading.value = true
  try {
    const prepared = await prepareUpload(files)

    // 输入区加号的天然语义是「给当前对话补材料」：
    // 已有会话就追加，会话 ID 与 URL 都不变，下一轮分析自动读到合并正文。
    if (chat.sessionId !== '') {
      const r = await api.append(chat.sessionId, {
        content: prepared.content,
        ...(prepared.files.length > 0 ? { files: prepared.files } : {}),
        ...(prepared.source !== '' ? { source: prepared.source } : {}),
      })

      const notes = [`已追加第 ${r.seq} 段，当前共 ${r.total} 段`, ...prepared.notes]
      if (r.deobfuscated) notes.push('类名已自动反混淆')
      else if (r.deobfuscateError !== undefined) {
        notes.push(`反混淆未生效（已存原文）：${r.deobfuscateError}`)
      }
      uploadNotes.value = [...new Set(notes)]

      // 纯对话此前没有案卷：追加后正文归属会话自身，案卷面板应出现
      if (chat.logId === '') chat.attachLog(chat.sessionId)
      await log.load(chat.logId !== '' ? chat.logId : chat.sessionId, { force: true })
      return
    }

    // 还没有会话：上传即新建（首次进入时的行为不变）
    const result = await api.upload({
      content: prepared.content,
      ...(prepared.files.length > 0 ? { files: prepared.files } : {}),
      ...(prepared.source !== '' ? { source: prepared.source } : {}),
    })

    // 上传响应里的 `logId` 现在是**会话 ID**（`s` 开头）。
    // 七位日志路由匹配不到它，必须走 `/s/`，否则上传成功却落 404。
    const notes = [...new Set([...prepared.notes, ...(result.notes ?? [])])]
    if (result.deobfuscated === true) notes.push('类名已自动反混淆')
    else if (result.deobfuscateError !== undefined) {
      notes.push(`反混淆未生效（已存原文）：${result.deobfuscateError}`)
    }
    uploadNotes.value = notes

    chat.reset()
    log.reset()
    quote.value = ''
    await router.push(`/s/${result.logId}`)
  } catch (e) {
    uploadError.value =
      e instanceof UploadError ? e.message : e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}

/** 上传入口（从输入区的回形针触发） */
function triggerUpload(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.log,.txt,.text,.yml,.yaml,.json,.zip,.properties,.cfg,.conf,.toml,.ini,.xml,.csv'
  input.addEventListener('change', () => {
    if (input.files !== null && input.files.length > 0) void onFiles(input.files)
  })
  input.click()
}

function newSession(): void {
  chat.reset()
  log.reset()
  quote.value = ''
  sidebarOpen.value = false
  if (route.path !== '/') void router.push('/')
}

function openHistory(entry: HistoryEntry): void {
  sidebarOpen.value = false
  if (entry.logId !== null) {
    if (chat.logId !== entry.logId) {
      chat.bindLog(entry.logId)
      log.reset()
      void log.load(entry.logId)
    }
    void router.push(`/${entry.logId}`)
    // 同一日志下仍按 sessionId 精确回放，避免拿到别的会话
    void chat.replay(entry.sessionId, api.replaySession)
  } else {
    void router.push(`/s/${entry.sessionId}`)
  }
}

function openEvidence(text: string): void {
  // 定位前确保案卷里有解析结果；没有就无从回跳
  if (log.parsed === null) return
  log.locateEvidence([text])
  const hit = log.evidenceHits[0]
  if (hit !== undefined && hit.line !== null) {
    log.jump(hit.line)
    dossierOpen.value = true
  }
}

function unbind(): void {
  chat.unbindLog()
  log.reset()
  quote.value = ''
  void router.push('/')
}

onMounted(async () => {
  health.load()
  // 打开即恢复上次会话（如果有）
  if (route.path === '/' && chat.messages.length === 0) {
    const saved = chat.restoreSessionId()
    if (saved !== '') {
      const ok = await chat.replay(saved, api.replaySession)
      if (!ok) chat.reset()
      else if (chat.logId !== '') void log.load(chat.logId)
    }
  } else {
    await initFromRoute()
  }
})

watch(
  () => route.fullPath,
  () => {
    void initFromRoute()
  },
)
</script>

<template>
  <div class="shell">
    <AppTopBar
      :log-id="logId"
      :show-menu="true"
      :has-dossier="showDossier"
      @menu="sidebarOpen = true"
      @new="newSession"
      @settings="settingsOpen = true"
      @dossier="dossierOpen = true"
    />

    <div class="shell__body">
      <!-- 会话栏：宽屏常驻 -->
      <aside class="shell__sidebar only-wide">
        <AppSidebar
          :active-session-id="chat.sessionId"
          :active-log-id="logId"
          @select="openHistory"
          @new="newSession"
        />
      </aside>

      <!-- 主列 -->
      <main class="shell__main">
        <!-- 上传/反混淆的非致命提示：接口如实返回什么就显示什么，不替用户猜 -->
        <div v-if="uploadNotes.length > 0" class="upload-notes" role="status">
          <span>{{ uploadNotes.join('；') }}</span>
          <button type="button" class="btn btn--ghost btn--sm" @click="uploadNotes = []">
            知道了
          </button>
        </div>

        <div v-if="uploadError !== ''" class="upload-error">
          <p class="alert alert--danger">{{ uploadError }}</p>
        </div>

        <!-- 首屏：没有消息时，无论有无日志都显示引导 + 输入区；
             否则用户在「已绑定日志」的工作台里看不到输入框，必须先点一个建议问题。 -->
        <template v-if="!hasMessages">
          <div class="shell__scroll">
            <div v-if="chat.pendingLog !== null" class="draft-banner">
              <ClipboardPaste :size="13" aria-hidden="true" />
              <span>
                正在分析 <code>{{ chat.pendingLog.name }}</code>
                （{{ chat.pendingLog.content.split('\n').length }} 行，仅本次页面有效，刷新即丢）
              </span>
              <button type="button" class="btn btn--ghost btn--sm" @click="chat.clearPendingLog(); newSession()">
                移除
              </button>
            </div>

            <!-- 有日志：材料概况 + 可以先问 -->
            <LogStart v-if="showDossier" @ask="onSend" />
            <!-- 没有日志：直接聊天。日志是可选附件，不是入场券。 -->
            <ChatStart v-else @ask="onSend" />
          </div>

          <footer class="composer-bar">
            <div class="composer-bar__inner">
              <AskDock
                v-if="pendingAsks.length > 0"
                :asks="pendingAsks"
                :disabled="chat.busy"
                @answer="onAnswer"
              />
              <Composer
                ref="composer"
                :busy="chat.busy"
                :phase="chat.phase"
                :has-log="showDossier"
                :quote="quote"
                :awaiting-answer="chat.awaitingAnswer"
                :session-active="chat.sessionId !== ''"
                @send="onSend"
                @abort="chat.abort"
                @upload="triggerUpload"
                @clear-quote="quote = ''"
                @use-as-log="onPasteLog"
              />
            </div>
          </footer>
        </template>

        <template v-else>
          <div v-if="chat.pendingLog !== null" class="draft-banner">
            <ClipboardPaste :size="13" aria-hidden="true" />
            <span>
              正在分析 <code>{{ chat.pendingLog.name }}</code>
              （{{ chat.pendingLog.content.split('\n').length }} 行，仅本次页面有效，刷新即丢）
            </span>
            <button type="button" class="btn btn--ghost btn--sm" @click="chat.clearPendingLog(); newSession()">
              移除
            </button>
          </div>

          <ChatThread
            :messages="chat.messages"
            :can-locate="log.parsed !== null"
            :busy="chat.busy"
            @locate="openEvidence"
            @retry="onRetry"
            @answer="onAnswer"
          />

          <footer class="composer-bar">
            <div class="composer-bar__inner">
              <AskDock
                v-if="pendingAsks.length > 0"
                :asks="pendingAsks"
                :disabled="chat.busy"
                @answer="onAnswer"
              />
              <Composer
                ref="composer"
                :busy="chat.busy"
                :phase="chat.phase"
                :has-log="showDossier"
                :quote="quote"
                :awaiting-answer="chat.awaitingAnswer"
                :session-active="chat.sessionId !== ''"
                @send="onSend"
                @abort="chat.abort"
                @upload="triggerUpload"
                @clear-quote="quote = ''"
                @use-as-log="onPasteLog"
              />
            </div>
          </footer>
        </template>
      </main>

      <!-- 案卷：宽屏常驻 -->
      <aside v-if="showDossier" class="shell__dossier only-wide">
        <DossierPanel @quote="applyQuote" @unbind="unbind" />
      </aside>
    </div>

    <!-- 窄屏：会话栏抽屉 -->
    <ModalShell
      :open="sidebarOpen"
      variant="drawer"
      title="会话"
      hide-title
      @update:open="sidebarOpen = $event"
    >
      <AppSidebar
        :active-session-id="chat.sessionId"
        :active-log-id="logId"
        :closable="true"
        @select="openHistory"
        @new="newSession"
        @close="sidebarOpen = false"
      />
    </ModalShell>

    <!-- 窄屏：案卷抽屉 -->
    <ModalShell
      :open="dossierOpen"
      variant="center"
      title="日志案卷"
      hide-title
      @update:open="dossierOpen = $event"
    >
      <DossierPanel
        :closable="true"
        @quote="applyQuote"
        @unbind="unbind"
        @close="dossierOpen = false"
      />
    </ModalShell>

    <SettingsPanel v-model:open="settingsOpen" :health="health.data" />

    <!-- 上传中的全局提示：大文件解压/上传可能几秒，必须让用户知道在做什么 -->
    <Teleport to="body">
      <div v-if="uploading" class="uploading" role="status" aria-live="polite">
        <Upload :size="14" class="spin" aria-hidden="true" />
        正在上传并处理日志…
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * 三层深度：画布（外壳）→ 纸面（阅读区）→ 凹陷（导航、引用）。
 *
 * 早先整页只有一个米白底，结构全靠 1px 线，所以每个元素都得画框才看得清。
 * 现在阅读区是一块**抬起的纸面**（圆角 + 细阴影），左右两栏留在画布上——
 * 视线自然落在中间的报告上，不需要装饰性边框去划分区域。
 */
.shell {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  background: var(--paper-sunken);
}

.shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
  padding: 0 var(--sp-2) var(--sp-2);
}

.shell__sidebar {
  width: var(--sidebar-w);
  flex: none;
  min-height: 0;
}

.shell__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--paper-raised);
  border-radius: var(--radius-field);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.shell__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.shell__dossier {
  width: min(var(--dossier-w), 40vw);
  flex: none;
  min-width: 300px;
  min-height: 0;
  margin-left: var(--sp-2);
  background: var(--paper-raised);
  border-radius: var(--radius-field);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.draft-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 18px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-micro);
}

.draft-banner .btn {
  margin-left: auto;
}

.upload-error {
  padding: 10px 18px 0;
}

.upload-notes {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: 6px 14px;
  border-bottom: 1px solid var(--rule);
  background: var(--paper-sunken);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
}

.upload-notes span {
  flex: 1;
  min-width: 0;
}

.composer-bar {
  flex: none;
  background: var(--paper-raised);
  padding-bottom: env(safe-area-inset-bottom);
}

.composer-bar__inner {
  max-width: var(--thread-w);
  margin: 0 auto;
  padding: var(--sp-3) var(--sp-5) var(--sp-3);
}

.uploading {
  position: fixed;
  left: 50%;
  bottom: calc(24px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--rule-strong);
  border-radius: 999px;
  background: var(--paper-raised);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  box-shadow: var(--shadow);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 959px) {
  .composer-bar__inner {
    padding: var(--sp-2) var(--sp-3) 6px;
  }
}
</style>
