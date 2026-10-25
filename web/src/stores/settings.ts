/**
 * 设置：供应商、主题、行为偏好。
 *
 * ## 为什么 API Key 只存浏览器
 * 本产品无登录。若把用户的 Key 存到服务端，就必须回答「谁有权读它」；
 * 不存则这个问题不存在（决策 D44）。服务端只在一次请求的生命周期里看到它。
 *
 * 默认写 localStorage（下次打开仍在），另提供「仅本次会话」——
 * 共用设备上这是必要选项。管理令牌则相反，默认 sessionStorage。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { ProviderConfig } from '@/lib/types'

const PROVIDER_KEY = 'lograg.provider.v1'
const SESSION_ONLY_KEY = 'lograg.provider.sessionOnly'
const THEME_KEY = 'lograg.theme'
const AUTO_SCROLL_KEY = 'lograg.autoScroll'

export type ThemeChoice = 'system' | 'light' | 'dark'

const EMPTY_PROVIDER: ProviderConfig = { baseUrl: '', apiKey: '', model: '' }

function loadProvider(): ProviderConfig {
  try {
    const raw = localStorage.getItem(PROVIDER_KEY)
    if (raw === null) return { ...EMPTY_PROVIDER }
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    }
  } catch {
    return { ...EMPTY_PROVIDER }
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  return 'system'
}

/** 当前生效的明暗（system 时按系统偏好） */
function resolveDark(choice: ThemeChoice): boolean {
  if (choice === 'light') return false
  if (choice === 'dark') return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)

  // 移动端地址栏配色跟随页面，避免深色页面配白色状态栏
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta !== null) meta.setAttribute('content', resolveDark(choice) ? '#121211' : '#f6f4ef')
}

export const useSettingsStore = defineStore('settings', () => {
  const provider = ref<ProviderConfig>(loadProvider())
  const sessionOnlyKey = ref(loadBool(SESSION_ONLY_KEY, false))
  const theme = ref<ThemeChoice>(loadTheme())
  const autoScroll = ref(loadBool(AUTO_SCROLL_KEY, true))

  const hasProvider = computed(
    () => provider.value.baseUrl.trim() !== '' && provider.value.model.trim() !== '',
  )

  /** 当前请求应携带的供应商；留空表示用服务端默认 */
  const activeProvider = computed<ProviderConfig | undefined>(() => {
    if (!hasProvider.value) return undefined
    return {
      baseUrl: provider.value.baseUrl.trim(),
      apiKey: provider.value.apiKey,
      model: provider.value.model.trim(),
    }
  })

  function persistProvider(): void {
    try {
      if (sessionOnlyKey.value) {
        localStorage.removeItem(PROVIDER_KEY)
        sessionStorage.setItem(PROVIDER_KEY, JSON.stringify(provider.value))
      } else {
        sessionStorage.removeItem(PROVIDER_KEY)
        localStorage.setItem(PROVIDER_KEY, JSON.stringify(provider.value))
      }
      localStorage.setItem(SESSION_ONLY_KEY, sessionOnlyKey.value ? '1' : '0')
    } catch {
      /* 隐私模式：仅本次进程内生效 */
    }
  }

  /** 启动时若选了「仅本次会话」，从 sessionStorage 恢复 */
  function restoreSessionOnly(): void {
    if (!sessionOnlyKey.value) return
    try {
      const raw = sessionStorage.getItem(PROVIDER_KEY)
      if (raw === null) return
      const parsed = JSON.parse(raw) as Partial<ProviderConfig>
      provider.value = {
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
      }
    } catch {
      /* ignore */
    }
  }

  function saveProvider(next: ProviderConfig, keepOnlyInSession = sessionOnlyKey.value): void {
    provider.value = {
      baseUrl: next.baseUrl.trim(),
      apiKey: next.apiKey,
      model: next.model.trim(),
    }
    sessionOnlyKey.value = keepOnlyInSession
    persistProvider()
  }

  function clearProvider(): void {
    provider.value = { ...EMPTY_PROVIDER }
    try {
      localStorage.removeItem(PROVIDER_KEY)
      sessionStorage.removeItem(PROVIDER_KEY)
    } catch {
      /* ignore */
    }
  }

  function setTheme(next: ThemeChoice): void {
    theme.value = next
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
    applyTheme(next)
  }

  function setAutoScroll(next: boolean): void {
    autoScroll.value = next
    try {
      localStorage.setItem(AUTO_SCROLL_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // 系统主题变化时（system 模式下）重新应用，保证地址栏颜色同步
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') applyTheme('system')
    })
  }

  watch(theme, (v) => applyTheme(v), { immediate: true })

  return {
    provider,
    sessionOnlyKey,
    theme,
    autoScroll,
    hasProvider,
    activeProvider,
    saveProvider,
    clearProvider,
    setTheme,
    setAutoScroll,
    restoreSessionOnly,
  }
})
