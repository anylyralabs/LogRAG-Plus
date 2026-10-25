<script setup lang="ts">
/**
 * 设置抽屉。
 *
 * 自定义供应商的 API Key **默认只存 localStorage**，随请求逐次带上，不落服务端——
 * 无登录产品里把它存服务端就必须回答「谁有权读它」；不存则这个问题不存在。
 * 另提供「仅本次会话」，供共用设备使用。
 *
 * 不做「连通性测试」：服务端会在真正发起分析时返回上游的具体错误，
 * 一个假的测试按钮只会增加一条与真实链路不同的代码路径。
 */
import { computed, reactive, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import ModalShell from '@/components/ui/ModalShell.vue'
import { useSettingsStore, type ThemeChoice } from '@/stores/settings'
import type { HealthResponse } from '@/lib/types'

const props = defineProps<{
  open: boolean
  health: HealthResponse | null
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const settings = useSettingsStore()

const form = reactive({ baseUrl: '', apiKey: '', model: '' })
const sessionOnly = ref(false)
const saved = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.baseUrl = settings.provider.baseUrl
    form.apiKey = settings.provider.apiKey
    form.model = settings.provider.model
    sessionOnly.value = settings.sessionOnlyKey
    saved.value = false
  },
)

const valid = computed(() => {
  const base = form.baseUrl.trim()
  if (base === '') return form.model.trim() === '' && form.apiKey === ''
  return /^https?:\/\//i.test(base) && form.model.trim() !== ''
})

const serverModel = computed(() => {
  const cfg = props.health?.config ?? {}
  const raw = cfg['defaultProvider']
  return typeof raw === 'string' ? raw : '未配置'
})

const ragSummary = computed(() => {
  const chunks = props.health?.rag.chunks ?? 0
  const files = props.health?.rag.files ?? 0
  if (chunks === 0) return '知识库索引不可用，分析仍可进行但检索会降级'
  return `${files} 个文件 / ${chunks} 个分块`
})

function save(): void {
  if (!valid.value) return
  settings.saveProvider(
    { baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model },
    sessionOnly.value,
  )
  saved.value = true
  setTimeout(() => {
    saved.value = false
    emit('update:open', false)
  }, 260)
}

function useServerDefault(): void {
  form.baseUrl = ''
  form.apiKey = ''
  form.model = ''
  settings.clearProvider()
  saved.value = true
  setTimeout(() => {
    saved.value = false
    emit('update:open', false)
  }, 260)
}

function setTheme(value: ThemeChoice): void {
  settings.setTheme(value)
}
</script>

<template>
  <ModalShell
    :open="open"
    variant="drawer"
    title="设置"
    description="自定义模型供应商与界面偏好"
    @update:open="emit('update:open', $event)"
  >
    <div class="panel__head">
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm"
        aria-label="关闭"
        @click="emit('update:open', false)"
      >
        <X :size="15" aria-hidden="true" />
      </button>
    </div>

    <div class="panel__body">
      <section class="section">
        <div class="label">模型供应商</div>
        <p class="section__lead">
          留空则使用服务端默认（当前：<code>{{ serverModel }}</code>）。
          填写后仅保存在本机浏览器，不会上传到服务端。
        </p>

        <div class="field">
          <label for="provider-base">接口地址</label>
          <input
            id="provider-base"
            v-model="form.baseUrl"
            class="input mono"
            inputmode="url"
            autocomplete="off"
            placeholder="https://api.example.com/v1"
          />
          <span class="field-help">OpenAI 兼容端点，通常需要包含 /v1。</span>
        </div>

        <div class="field">
          <label for="provider-key">API Key</label>
          <input
            id="provider-key"
            v-model="form.apiKey"
            class="input mono"
            type="password"
            autocomplete="off"
            placeholder="sk-…"
          />
        </div>

        <div class="field">
          <label for="provider-model">模型名</label>
          <input
            id="provider-model"
            v-model="form.model"
            class="input mono"
            autocomplete="off"
            placeholder="gpt-4o-mini"
          />
        </div>

        <label class="check">
          <input v-model="sessionOnly" type="checkbox" />
          <span>仅本次会话保存（关闭浏览器后需要重新填写）</span>
        </label>

        <p v-if="!valid" class="alert alert--warn">
          接口地址需以 http(s):// 开头，且必须填写模型名。要使用服务端默认，请把三项都留空。
        </p>
      </section>

      <section class="section">
        <div class="label">外观</div>
        <div class="seg" role="group" aria-label="主题">
          <button
            type="button"
            class="seg__item"
            :class="{ 'seg__item--active': settings.theme === 'system' }"
            @click="setTheme('system')"
          >
            跟随系统
          </button>
          <button
            type="button"
            class="seg__item"
            :class="{ 'seg__item--active': settings.theme === 'light' }"
            @click="setTheme('light')"
          >
            浅色
          </button>
          <button
            type="button"
            class="seg__item"
            :class="{ 'seg__item--active': settings.theme === 'dark' }"
            @click="setTheme('dark')"
          >
            深色
          </button>
        </div>

        <label class="check">
          <input
            :checked="settings.autoScroll"
            type="checkbox"
            @change="settings.setAutoScroll(($event.target as HTMLInputElement).checked)"
          />
          <span>分析过程中自动跟随最新内容</span>
        </label>
      </section>

      <section class="section">
        <div class="label">服务</div>
        <dl class="facts">
          <div class="facts__row">
            <dt>知识库</dt>
            <dd>{{ ragSummary }}</dd>
          </div>
          <div class="facts__row">
            <dt>版本</dt>
            <dd class="num">{{ health?.version ?? '未知' }}</dd>
          </div>
          <div class="facts__row">
            <dt>会话保留</dt>
            <dd>独立会话 48 小时；绑定日志的会话跟随日志 TTL</dd>
          </div>
        </dl>
      </section>
    </div>

    <footer class="panel__foot">
      <button type="button" class="btn btn--sm" @click="useServerDefault">用服务端默认</button>
      <span class="panel__spacer" />
      <button type="button" class="btn btn--primary btn--sm" :disabled="!valid" @click="save">
        {{ saved ? '已保存' : '保存' }}
      </button>
    </footer>
  </ModalShell>
</template>

<style scoped>
/* 容器与遮罩由 ModalShell 提供；这里只负责内部排版 */

.panel__head {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}

.panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  padding-top: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.section__lead {
  margin-top: -6px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.6;
  cursor: pointer;
}

.check input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.seg {
  display: flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius-control);
  overflow: hidden;
}

.seg__item {
  flex: 1;
  padding: 6px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  border-right: 1px solid var(--rule);
}

.seg__item:last-child {
  border-right: 0;
}

.seg__item--active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.facts__row {
  display: grid;
  grid-template-columns: 5.5em 1fr;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  line-height: 1.65;
}

.facts__row dt {
  color: var(--ink-4);
}

.facts__row dd {
  color: var(--ink-2);
}

.panel__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
}

.panel__spacer {
  flex: 1;
}
</style>
