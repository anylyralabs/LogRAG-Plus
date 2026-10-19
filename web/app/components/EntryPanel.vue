<script setup lang="ts">
/**
 * 投放台：尚未绑定日志时的第一屏。
 *
 * 排版意图：一份待填的勘验单。三条途径不是三个卖点，而是三行**不同操作的表格**——
 * 左边是途径，中间是它在现实里长什么样（真实文件名、真实 URL 形状），右边才是动作。
 * 「长什么样」这一列是关键：用户认的是 `latest.log` 这个文件名和自己的地址栏，
 * 不是「上传文件」这四个字。
 */

const chat = useChat()
const toast = useToast()

const idInput = ref('')
const pasted = ref('')
const uploading = ref(false)

const ID_RE = /^[A-Za-z0-9]{7}$/
const idValid = computed(() => ID_RE.test(idInput.value.trim()))

async function bindById(): Promise<void> {
  if (!idValid.value) return
  await navigateTo(`/${idInput.value.trim()}`)
}

async function uploadFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file === undefined) return
  uploading.value = true
  try {
    const text = await file.text()
    const { upload } = await import('../lib/api')
    const r = await upload({ content: text, files: [{ name: file.name, data: text }] })
    chat.logId.value = r.logId
    await navigateTo(`/${r.logId}`)
    toast.add({ title: '日志已收下', description: r.logId, icon: 'i-lucide-check' })
  } catch (err) {
    toast.add({
      title: '上传没有成功',
      description: err instanceof Error ? err.message : String(err),
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function uploadPasted(): Promise<void> {
  if (pasted.value.trim() === '') return
  uploading.value = true
  try {
    const { upload } = await import('../lib/api')
    const r = await upload({ content: pasted.value })
    chat.logId.value = r.logId
    pasted.value = ''
    await navigateTo(`/${r.logId}`)
    toast.add({ title: '日志已收下', description: r.logId, icon: 'i-lucide-check' })
  } catch (err) {
    toast.add({
      title: '提交没有成功',
      description: err instanceof Error ? err.message : String(err),
      color: 'error',
      icon: 'i-lucide-triangle-alert',
    })
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col">
    <!-- 开篇：一句话说清这份东西在做什么，不卖弄 -->
    <section class="border-b border-[var(--ui-border)] px-0 py-8">
      <h1 class="max-w-[19em] text-[21px] leading-snug font-semibold text-[var(--ui-text-highlighted)]">
        把崩溃日志放这儿，我读给你听。
      </h1>
      <p class="mt-2 max-w-[21em] text-[13px] leading-relaxed text-[var(--ui-text-toned)]">
        读完会指出现场是什么、该动哪一处、依据在日志的哪一行。找不到明确原因时，
        我会直接说找不到，而不是编一个。
      </p>
    </section>

    <!-- 三条途径：发丝线表格，不是三张卡片 -->
    <section class="flex flex-col">
      <!-- 一：已有 ID -->
      <div class="grid gap-3 border-b border-[var(--ui-border)] py-6 sm:grid-cols-[7.5rem_1fr]">
        <div class="dossier-label h-fit">已有日志编号</div>
        <div>
          <p class="mb-3 font-mono text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            从 LogShare 跳过来时，地址栏末尾那七位就是它<br />
            agent.logshare.cn/logshare/<span class="text-[var(--ui-primary)]">kalkLqQ</span>
          </p>
          <form class="flex max-w-md gap-2" @submit.prevent="bindById">
            <UInput
              v-model="idInput"
              placeholder="七位编号"
              size="md"
              class="flex-1 font-mono"
              :color="idInput !== '' && !idValid ? 'error' : 'neutral'"
              :ui="{ base: 'font-mono tracking-wider' }"
            />
            <UButton
              type="submit"
              class="btn-primary-solid"
              :disabled="!idValid"
              trailing-icon="i-lucide-arrow-right"
            >
              打开
            </UButton>
          </form>
          <p v-if="idInput !== '' && !idValid" class="mt-1.5 text-[11px] text-[var(--ui-error)]">
            编号是七位字母或数字。
          </p>
        </div>
      </div>

      <!-- 二：上传文件 -->
      <div class="grid gap-3 border-b border-[var(--ui-border)] py-6 sm:grid-cols-[7.5rem_1fr]">
        <div class="dossier-label h-fit">上传文件</div>
        <div>
          <p class="mb-3 font-mono text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            latest.log · crash-report.txt · hs_err_pid*.log<br />
            主日志与崩溃报告一起给，判断会准得多
          </p>
          <label
            class="flex max-w-md cursor-pointer items-center justify-center gap-2 border border-dashed border-[var(--ui-border-accented)] px-4 py-5 text-[13px] text-[var(--ui-text-toned)] transition hover:border-[var(--ui-primary)] hover:text-[var(--ui-text)]"
          >
            <UIcon
              :name="uploading ? 'i-lucide-loader-circle' : 'i-lucide-file-up'"
              class="size-4"
              :class="uploading ? 'animate-spin' : ''"
            />
            {{ uploading ? '正在上传…' : '选择文件' }}
            <input type="file" class="hidden" accept=".log,.txt,.yml,.json" @change="uploadFile" />
          </label>
          <p class="mt-2 text-[11px] text-[var(--ui-text-dimmed)]">
            上传后先脱敏再分析；反混淆在后台进行，不占你的等待时间。
          </p>
        </div>
      </div>

      <!-- 三：粘贴 -->
      <div class="grid gap-3 py-6 sm:grid-cols-[7.5rem_1fr]">
        <div class="dossier-label h-fit">直接粘贴</div>
        <div>
          <p class="mb-3 font-mono text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            只有几行报错，或日志在另一台设备上
          </p>
          <UTextarea
            v-model="pasted"
            :rows="4"
            placeholder="粘贴日志内容…"
            class="max-w-md font-mono text-[11px]"
            :ui="{ base: 'font-mono text-[11px]' }"
          />
          <div class="mt-2 flex max-w-md justify-end">
            <UButton
              :disabled="pasted.trim() === '' || uploading"
              :loading="uploading"
              color="neutral"
              variant="subtle"
              @click="uploadPasted"
            >
              提交这段
            </UButton>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
