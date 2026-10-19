<script setup lang="ts">
/**
 * 供应商设置抽屉。
 *
 * 自定义供应商的 API Key **只存 localStorage**，随请求逐次带上，不落服务端——
 * 无登录产品里把它存服务端就必须回答「谁有权读它」；不存则这个问题不存在。
 */
import type { ProviderConfig } from '../composables/useChat'

const props = defineProps<{
  open: boolean
  chat: ReturnType<typeof useChat>
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const form = reactive<ProviderConfig>({ baseUrl: '', apiKey: '', model: '' })
const saving = ref(false)
const healthInfo = ref<string>('')

watch(
  () => props.open,
  (v) => {
    if (v) {
      Object.assign(form, props.chat.provider.value)
      void loadHealth()
    }
  },
)

async function loadHealth(): Promise<void> {
  try {
    const h = await (await import('../lib/api')).health()
    healthInfo.value = `知识库 ${h.rag.chunks} 分块 / ${h.rag.files} 文件 · 服务端默认模型 ${String(h.config['defaultProvider'] ?? '未配置')}`
  } catch {
    healthInfo.value = '无法连接到服务'
  }
}

function save(): void {
  saving.value = true
  props.chat.saveProvider({ ...form })
  setTimeout(() => {
    saving.value = false
    emit('update:open', false)
    useToast().add({ title: '已保存', icon: 'i-lucide-check', color: 'success' })
  }, 180)
}

function clear(): void {
  Object.assign(form, { baseUrl: '', apiKey: '', model: '' })
  props.chat.saveProvider({ baseUrl: '', apiKey: '', model: '' })
  useToast().add({ title: '已改用服务端默认供应商', icon: 'i-lucide-undo-2' })
}

const valid = computed(
  () => form.baseUrl.trim() === '' || (form.model.trim() !== '' && /^https?:\/\//.test(form.baseUrl)),
)
</script>

<template>
  <USlideover :open="open" side="right" :ui="{ content: 'max-w-md' }" @update:open="emit('update:open', $event)">
    <template #content>
      <div class="flex h-full flex-col">
        <div class="flex items-center gap-2 border-b border-[var(--ui-border)] px-4 py-3">
          <UIcon name="i-lucide-sliders-horizontal" class="size-4 text-[var(--ui-primary)]" />
          <span class="text-sm font-medium">设置</span>
          <div class="flex-1" />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="关闭"
            @click="emit('update:open', false)"
          />
        </div>

        <div class="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
          <div>
            <h3 class="mb-1 text-sm font-medium">模型供应商</h3>
            <p class="mb-3 text-xs leading-relaxed text-[var(--ui-text-muted)]">
              留空则使用服务端配置的默认模型。填写后仅保存在本机浏览器，不会上传到服务端。
            </p>

            <div class="flex flex-col gap-3">
              <UFormField label="接口地址" help="OpenAI 兼容端点，需包含 /v1">
                <UInput v-model="form.baseUrl" placeholder="https://api.example.com/v1" class="w-full font-mono text-xs" />
              </UFormField>
              <UFormField label="API Key">
                <UInput
                  v-model="form.apiKey"
                  type="password"
                  placeholder="sk-…"
                  class="w-full font-mono text-xs"
                />
              </UFormField>
              <UFormField label="模型名">
                <UInput v-model="form.model" placeholder="gpt-4o-mini" class="w-full font-mono text-xs" />
              </UFormField>

              <UAlert
                v-if="!valid"
                color="warning"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                description="接口地址需以 http(s):// 开头，且必须填写模型名。"
              />
            </div>
          </div>

          <USeparator />

          <div class="text-xs text-[var(--ui-text-muted)]">
            <p class="mb-1 font-medium text-[var(--ui-text-toned)]">服务状态</p>
            <p>{{ healthInfo }}</p>
          </div>

          <div v-if="chat.remaining.value !== null" class="text-xs text-[var(--ui-text-muted)]">
            今日剩余分析次数：<span class="font-mono">{{ chat.remaining.value }}</span>
          </div>

          <USeparator />

          <UButton
            color="neutral"
            variant="subtle"
            icon="i-lucide-rotate-ccw"
            block
            @click="chat.reset"
          >
            开始新会话
          </UButton>
        </div>

        <div class="flex gap-2 border-t border-[var(--ui-border)] p-4">
          <UButton color="neutral" variant="ghost" @click="clear">用服务端默认</UButton>
          <div class="flex-1" />
          <UButton :disabled="!valid" :loading="saving" @click="save">保存</UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
