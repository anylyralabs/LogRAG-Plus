/**
 * 本地设置（主题、自定义供应商、管理令牌、接口基地址）。
 *
 * 设计取舍：
 *
 * - **只存 localStorage，不落服务端**。这是刻意的：无登录无收费的产品里，
 *   把「用户自己的 API Key」存在服务端就要回答「谁有权读它」，
 *   而那正是本项目宁愿回避的问题。存本地则密钥从不离开用户设备——
 *   每轮请求由前端带在请求体里（服务端按请求使用、不落库）。
 * - **主题跟随系统**，同时允许手动覆盖：移动端用户的系统深色设置是稳定的
 *   信息来源，手动开关留给「就想用另一套」的场景，两者不冲突。
 */

import { computed, ref, watch } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ProviderConfig {
  /** 是否启用自定义供应商（关闭时用服务端默认，普通用户不需要配置） */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const LS = {
  theme: 'lograg.theme',
  provider: 'lograg.provider',
  admin: 'lograg.adminToken',
  apiBase: 'lograg.apiBase',
} as const;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch {
    return fallback;
  }
}

// ── 主题 ────────────────────────────────────────────────

/**
 * 默认深色。
 *
 * 这不是「偏好」而是设计的一部分：本产品的使用场景是**夜里、手机上、读崩溃
 * 日志**，深色是它的常规形态（方向 A「仪器台」即以此为基准色）。仍然保留
 * 「跟随系统」与「浅色」两个选项，只是初次打开不再由系统代答。
 */
const themeMode = ref<ThemeMode>((localStorage.getItem(LS.theme) as ThemeMode | null) ?? 'dark');

/** 当前实际生效的浅/深（system 时跟随媒体查询） */
const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  systemDark.value = e.matches;
});

export const isDark = computed(() =>
  themeMode.value === 'system' ? systemDark.value : themeMode.value === 'dark',
);

function applyTheme(): void {
  document.documentElement.dataset['theme'] = isDark.value ? 'dark' : 'light';
}
watch(isDark, applyTheme, { immediate: true });
watch(themeMode, (mode) => {
  localStorage.setItem(LS.theme, mode);
});

// ── 自定义供应商 ────────────────────────────────────────

const provider = ref<ProviderConfig>(
  readJson<ProviderConfig>(LS.provider, { enabled: false, baseUrl: '', apiKey: '', model: '' }),
);

watch(
  provider,
  (p) => {
    localStorage.setItem(LS.provider, JSON.stringify(p));
  },
  { deep: true },
);

/** 是否配好了可用供应商（用于提示「未配置则用服务端默认模型」） */
export const providerReady = computed(
  () => provider.value.enabled && provider.value.baseUrl.trim() !== '' && provider.value.model.trim() !== '',
);

// ── 管理模式令牌 ────────────────────────────────────────

const adminToken = ref(localStorage.getItem(LS.admin) ?? '');
watch(adminToken, (t) => {
  if (t === '') localStorage.removeItem(LS.admin);
  else localStorage.setItem(LS.admin, t);
});

export function useSettings() {
  return {
    themeMode,
    isDark,
    provider,
    providerReady,
    adminToken,

    setProvider(next: Partial<ProviderConfig>): void {
      provider.value = { ...provider.value, ...next };
    },

    clearAdminToken(): void {
      adminToken.value = '';
    },
  };
}
