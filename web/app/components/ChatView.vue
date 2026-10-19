<script setup lang="ts">
/**
 * 对话页。
 *
 * 排版意图：卷宗的阅读区。定宽 5xl 居中、单栏正文，宽度靠 max-w-[34em] 限制——
 * 长行会让眼睛在回扫时丢行，而这份内容是要**逐条照着做**的。
 * 宽屏时日志作为左侧栏常驻（它是材料），窄屏折叠进抽屉（它不该挤掉输入）。
 */
import type { LogDoc, LogDocsResponse } from '../lib/types'
import { logDocs } from '../lib/api'

const route = useRoute()
const router = useRouter()
const chat = useChat()
const toast = useToast()

const logDoc = ref<LogDoc | null>(null)
const logLoading = ref(false)
const logError = ref('')
const showLogDrawer = ref(false)
const sheetOpen = ref(false)

const currentLogId = computed(() => {
  const p = route.params['id']
  const fromPath = Array.isArray(p) ? p[0] : p
  return typeof fromPath === 'string' && fromPath !== '' ? fromPath : ''
})

onMounted(() => {
  if (currentLogId.value !== '') {
    chat.logId.value = currentLogId.value
    void loadLog(currentLogId.value)
  } else {
    const saved = chat.restoreSessionId()
    if (saved !== '') void chat.replay(saved)
  }
})

watch(currentLogId, (id, prev) => {
  if (id === prev) return
  if (id === '') {
    chat.logId.value = ''
    logDoc.value = null
    return
  }
  chat.logId.value = id
  void loadLog(id)
})

async function loadLog(id: string): Promise<void> {
  logLoading.value = true
  logError.value = ''
  try {
    const r: LogDocsResponse = await logDocs(id)
    const first = r.docs[0]
    if (first === undefined) {
      logError.value = '这份日志里没有可显示的正文'
      return
    }
    logDoc.value = first
    if (r.omitted.length > 0) {
      toast.add({
        title: '部分附件未显示',
        description: r.omitted.join('、'),
        color: 'warning',
        icon: 'i-lucide-paperclip',
      })
    }
  } catch (e) {
    logError.value = e instanceof Error ? e.message : '读取日志失败'
  } finally {
    logLoading.value = false
  }
}

function unbind(): void {
  void router.push('/')
  chat.logId.value = ''
  logDoc.value = null
  showLogDrawer.value = false
}

const quoteBlock = ref('')

function onQuote(payload: { label: string; text: string }): void {
  quoteBlock.value = `引用日志 ${payload.label}：\n\`\`\`\n${payload.text}\n\`\`\``
  showLogDrawer.value = false
}

async function onSend(text: string): Promise<void> {
  const block = quoteBlock.value
  quoteBlock.value = ''
  await chat.send(text, block)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <!-- 材料：宽屏常驻左栏 -->
    <aside
      v-if="chat.logId.value !== ''"
      class="hidden shrink-0 border-r border-[var(--ui-border)] lg:flex lg:w-[min(42vw,560px)] lg:flex-col"
    >
      <LogPanel
        :doc="logDoc"
        :log-id="chat.logId.value"
        :loading="logLoading"
        :error="logError"
        @quote="onQuote"
        @unbind="unbind"
      />
    </aside>

    <!-- 阅读区 -->
    <section class="flex min-h-0 flex-1 flex-col">
      <div
        class="flex items-center gap-2 border-b border-[var(--ui-border)] px-4 py-2 lg:px-6"
      >
        <UButton
          v-if="chat.logId.value !== ''"
          icon="i-lucide-file-text"
          color="neutral"
          variant="ghost"
          size="xs"
          class="lg:hidden"
          @click="showLogDrawer = true"
        >
          <span class="font-mono">{{ chat.logId.value }}</span>
        </UButton>
        <span
          v-else
          class="font-mono text-[11px] text-[var(--ui-text-dimmed)]"
        >未绑定日志</span>

        <div class="flex-1" />

        <span v-if="chat.remaining.value !== null" class="font-mono text-[10px] text-[var(--ui-text-dimmed)]">
          今日 {{ chat.remaining.value }} 次
        </span>
        <UButton
          v-if="chat.logId.value !== ''"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="解除绑定"
          class="hidden lg:inline-flex"
          @click="unbind"
        />
        <UButton
          icon="i-lucide-sliders-horizontal"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="设置"
          @click="sheetOpen = true"
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <EntryPanel v-if="chat.messages.value.length === 0" />

          <div v-else class="flex flex-col gap-8 py-6">
            <MessageItem v-for="(m, i) in chat.messages.value" :key="i" :message="m" />
          </div>
        </div>
      </div>

      <!-- 命令行 -->
      <div class="border-t border-[var(--ui-border)] px-4 pb-safe pt-3 sm:px-6">
        <div class="mx-auto w-full max-w-5xl">
          <div v-if="quoteBlock !== ''" class="mb-2 flex items-center gap-2">
            <span class="font-mono text-[10px] text-[var(--ui-primary)]">已选中日志片段</span>
            <UButton color="neutral" variant="link" size="xs" class="!p-0 !text-[10px]" @click="quoteBlock = ''">
              取消
            </UButton>
          </div>
          <Composer
            :busy="chat.busy.value"
            :has-log="chat.logId.value !== ''"
            :phase="chat.phase.value"
            @send="onSend"
            @abort="chat.abort"
          />
        </div>
      </div>
    </section>

    <!-- 窄屏：日志抽屉 -->
    <USlideover v-model:open="showLogDrawer" side="bottom" :ui="{ content: 'h-[85dvh]' }">
      <template #content>
        <LogPanel
          :doc="logDoc"
          :log-id="chat.logId.value"
          :loading="logLoading"
          :error="logError"
          @quote="onQuote"
          @unbind="unbind"
        />
      </template>
    </USlideover>

    <ProviderSheet v-model:open="sheetOpen" :chat="chat" />
  </div>
</template>
