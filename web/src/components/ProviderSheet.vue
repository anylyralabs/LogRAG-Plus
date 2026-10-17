<script setup lang="ts">
/**
 * 设置抽屉：外观、自定义模型供应商、接口地址、管理入口。
 *
 * ## 三条必须说清楚的事实（上一版也说，重做不改）
 *
 * 1. **API Key 只存本机**（localStorage），随每轮请求体发给服务端使用、不落库。
 *    无登录产品里把用户的密钥存到服务端，就必然要回答「谁有权读它」；
 *    不存则这个问题不存在。界面上必须写明白，否则用户会以为 key 被收走了。
 * 2. **供应商地址的合法性由服务端判定**（`src/security/ssrf.ts`：解析 DNS 后
 *    拒绝私网与回环，除非显式放行）。前端不重复实现一遍——重复实现只会
 *    产生「前端说不行、后端说行」这类不一致。
 * 3. **「不使用自定义供应商」是默认且正常的状态**，不是「未配置」。
 *    因此开关关闭时不留任何「去配置」的催促文案。
 *
 * 呈现上：深色面板 + 发丝线分节 + 等宽字段标签。抽屉从右侧推入（宽屏）
 * 或自底部升起（窄屏），两者都是 `translate` 位移，尊重 reduced-motion。
 */
import { ref, watch } from 'vue';
import { apiBase, health, setApiBase } from '../api/client.ts';
import type { Health } from '../api/types.ts';
import { useSettings } from '../stores/settings.ts';
import Icon from './Icon.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const settings = useSettings();

const baseUrlInput = ref(apiBase());
const probe = ref<{ ok: boolean; text: string } | null>(null);
const probing = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) baseUrlInput.value = apiBase();
  },
);

watch(baseUrlInput, (value) => {
  setApiBase(value);
  probe.value = null;
});

async function checkHealth(): Promise<void> {
  probing.value = true;
  probe.value = null;
  try {
    const h: Health = await health();
    const rag = h.rag;
    const ragText =
      rag !== undefined && typeof rag.chunks === 'number'
        ? `知识库 ${rag.chunks} 分块 / ${String(rag.files ?? '?')} 文件`
        : '知识库状态未知';
    const version = typeof h.version === 'string' ? `版本 ${h.version}` : '版本未知';
    probe.value = { ok: true, text: `服务正常（${version}，${ragText}）` };
  } catch (e) {
    probe.value = { ok: false, text: e instanceof Error ? e.message : '服务无响应' };
  } finally {
    probing.value = false;
  }
}

const THEMES: Array<{ value: 'system' | 'light' | 'dark'; label: string; icon: string }> = [
  { value: 'system', label: '跟随系统', icon: 'monitor' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];
</script>

<template>
  <div v-if="open" class="sheet-root">
    <div class="sheet-backdrop" @click="emit('close')" />

    <aside class="sheet" role="dialog" aria-modal="true" aria-label="设置">
      <header class="sheet__head">
        <span class="sheet__title mono">设置</span>
        <span class="grow" />
        <button type="button" class="icon-btn" aria-label="关闭" @click="emit('close')">
          <Icon name="x" :size="17" />
        </button>
      </header>

      <div class="sheet__body">
        <!-- 外观 -->
        <section class="sec">
          <h3 class="sec__h mono">外观</h3>
          <div class="seg" role="group" aria-label="主题">
            <button
              v-for="t in THEMES"
              :key="t.value"
              type="button"
              class="seg__item"
              :aria-pressed="settings.themeMode.value === t.value"
              :class="settings.themeMode.value === t.value ? 'seg__item--on' : ''"
              @click="settings.themeMode.value = t.value"
            >
              <Icon :name="t.icon" :size="15" />
              {{ t.label }}
            </button>
          </div>
        </section>

        <!-- 模型 -->
        <section class="sec">
          <h3 class="sec__h mono">模型</h3>

          <label class="switch">
            <input v-model="settings.provider.value.enabled" type="checkbox" class="switch__input" />
            <span class="switch__track" aria-hidden="true"><i /></span>
            <span class="switch__text">使用自定义模型供应商</span>
          </label>

          <p class="hint">
            不开启时用服务端默认模型。填自己的供应商后每轮请求会带上它；
            <strong>API Key 只保存在本机浏览器</strong>，不落服务端数据库。
          </p>

          <template v-if="settings.provider.value.enabled">
            <div class="field">
              <label class="field__label" for="pv-base">接口地址（OpenAI 兼容）</label>
              <input
                id="pv-base"
                v-model="settings.provider.value.baseUrl"
                class="input mono"
                placeholder="https://api.example.com/v1"
                autocomplete="off"
              />
              <span class="hint">私网与回环地址会被服务端拒绝，除非服务端显式放行。</span>
            </div>

            <div class="field">
              <label class="field__label" for="pv-model">模型名</label>
              <input
                id="pv-model"
                v-model="settings.provider.value.model"
                class="input"
                placeholder="例如 deepseek-chat"
                autocomplete="off"
              />
            </div>

            <div class="field">
              <label class="field__label" for="pv-key">API Key</label>
              <input
                id="pv-key"
                v-model="settings.provider.value.apiKey"
                class="input mono"
                type="password"
                placeholder="只存本机"
                autocomplete="off"
              />
            </div>
          </template>
        </section>

        <!-- 接口地址 -->
        <section class="sec">
          <h3 class="sec__h mono">接口地址</h3>
          <div class="field">
            <label class="field__label" for="pv-api">后端基地址</label>
            <input
              id="pv-api"
              v-model="baseUrlInput"
              class="input mono"
              placeholder="留空即同源（推荐）"
              autocomplete="off"
            />
            <span class="hint">前端与后端不同源时填这里，例如 http://127.0.0.1:8788。</span>
          </div>
          <div class="probe">
            <button type="button" class="btn" :disabled="probing" @click="checkHealth">
              <Icon name="refresh" :size="14" />
              {{ probing ? '检测中' : '检测服务' }}
            </button>
            <span
              v-if="probe !== null"
              class="probe__text"
              :class="probe.ok ? 'probe__text--ok' : 'probe__text--err'"
            >
              <i class="dot" :class="probe.ok ? 'dot--ok' : 'dot--error'" />
              <span class="hint">{{ probe.text }}</span>
            </span>
          </div>
        </section>

        <!-- 管理 -->
        <section class="sec">
          <h3 class="sec__h mono">管理</h3>
          <p class="hint">
            知识库条目、分析记录看板在管理页，需要服务端开启管理接口并提供访问令牌。
          </p>
          <RouterLink class="btn" to="/admin" @click="emit('close')">
            <Icon name="shield" :size="15" />
            进入管理页
          </RouterLink>
        </section>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.sheet-root {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 6, 10, 0.55);
  animation: fade 140ms ease;
}

/**
 * 宽屏从右侧推入、窄屏自底部升起。两者共用一套结构（`inset` 决定方向），
 * 因此不需要两份模板。
 */
.sheet {
  position: absolute;
  display: flex;
  flex-direction: column;
  top: 0;
  right: 0;
  height: 100%;
  width: min(440px, 100%);
  background: var(--surface);
  border-left: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
  animation: slide-x 180ms ease;
}

@media (max-width: 560px) {
  .sheet {
    top: auto;
    bottom: 0;
    left: 0;
    width: 100%;
    height: min(86vh, 100%);
    border-left: none;
    border-top: 1px solid var(--line-2);
    animation: slide-y 180ms ease;
  }
}

.sheet__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s3) var(--s4);
  padding-top: calc(var(--s3) + env(safe-area-inset-top));
  border-bottom: 1px solid var(--line);
}

.sheet__title {
  font-size: var(--t-h5);
}

.grow {
  flex: 1;
}

.sheet__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--s4);
  padding-bottom: calc(var(--s7) + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: var(--s6);
}

.sec {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}

/* 分节标题：等宽、小、三级灰。不做大写加宽字距——那是模板腔 */
.sec__h {
  font-size: var(--t-caption);
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.1em;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}

/* 分段控件：底槽用 input 底色，选中项用面板底色 + 上沿强调线 */
.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: var(--r1);
}

.seg__item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s2);
  flex: 1;
  min-height: 32px;
  border-radius: 1px;
  color: var(--text-2);
  font-size: var(--t-small);
  transition: background 120ms ease, color 120ms ease;
}

.seg__item:hover {
  color: var(--text);
}

.seg__item--on {
  background: var(--surface-3);
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
}

/* 开关：用原生 checkbox 承载状态（可键盘操作），外观自带 */
.switch {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-height: 32px;
  cursor: pointer;
}

.switch__input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.switch__track {
  flex: none;
  width: 36px;
  height: 20px;
  padding: 2px;
  background: var(--input-bg);
  border: 1px solid var(--line-2);
  border-radius: var(--r-pill);
  transition: background 140ms ease, border-color 140ms ease;
}

.switch__track i {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: var(--r-pill);
  background: var(--text-3);
  transition: transform 140ms ease, background 140ms ease;
}

.switch__input:checked + .switch__track {
  background: var(--accent-quiet);
  border-color: var(--accent);
}

.switch__input:checked + .switch__track i {
  transform: translateX(16px);
  background: var(--accent);
}

.switch__input:focus-visible + .switch__track {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.switch__text {
  font-size: var(--t-small);
}

.probe {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
}

.probe__text {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
}

.probe__text--err .hint {
  color: var(--sev-error);
}

.probe__text--ok .hint {
  color: var(--text-2);
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

@keyframes slide-x {
  from {
    transform: translateX(16px);
    opacity: 0.5;
  }
}

@keyframes slide-y {
  from {
    transform: translateY(24px);
    opacity: 0.5;
  }
}
</style>
