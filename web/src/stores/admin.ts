/**
 * 管理面状态。
 *
 * 令牌默认只在 `sessionStorage`：管理接口能**改写所有用户的系统提示词**，
 * 把它长期留在共用设备上不合适。勾选「记住本机」才写 localStorage。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { ApiError, api, classifyAdminError, type AdminGateState } from '@/lib/api'
import type {
  AnalysisRecord,
  AnalysisStats,
  AuditRecord,
  DomainKnowledge,
  DomainKnowledgeStats,
  InjectionPreview,
} from '@/lib/types'

const TOKEN_KEY = 'lograg.adminToken'
const REMEMBER_KEY = 'lograg.adminRemember'

export const useAdminStore = defineStore('admin', () => {
  const token = ref('')
  const remember = ref(false)
  const gate = ref<AdminGateState>('idle')
  const message = ref('')
  const busy = ref(false)

  const entries = ref<DomainKnowledge[]>([])
  const stats = ref<DomainKnowledgeStats | null>(null)
  const audit = ref<AuditRecord[]>([])
  const injection = ref<InjectionPreview | null>(null)

  const records = ref<AnalysisRecord[]>([])
  const recordsTotal = ref(0)
  const recordsStats = ref<AnalysisStats | null>(null)

  const authorized = computed(() => gate.value === 'ok')

  function loadToken(): void {
    try {
      const remembered = localStorage.getItem(REMEMBER_KEY) === '1'
      remember.value = remembered
      token.value = remembered
        ? (localStorage.getItem(TOKEN_KEY) ?? '')
        : (sessionStorage.getItem(TOKEN_KEY) ?? '')
    } catch {
      /* ignore */
    }
  }

  function saveToken(value: string, rememberOnDevice: boolean): void {
    token.value = value.trim()
    remember.value = rememberOnDevice
    try {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
      if (token.value === '') return
      localStorage.setItem(REMEMBER_KEY, rememberOnDevice ? '1' : '0')
      if (rememberOnDevice) localStorage.setItem(TOKEN_KEY, token.value)
      else sessionStorage.setItem(TOKEN_KEY, token.value)
    } catch {
      /* ignore */
    }
  }

  function logout(): void {
    token.value = ''
    gate.value = 'idle'
    entries.value = []
    stats.value = null
    audit.value = []
    injection.value = null
    records.value = []
    recordsTotal.value = 0
    recordsStats.value = null
    try {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }

  /**
   * 把一次失败映射成门禁状态。
   *
   * 404 有两种可能（未开启 / 已开启但没配令牌），后端刻意让它们同形，
   * 前端**不能假装能区分**。这里统一给「检查两个配置项」的文案。
   */
  function noteError(e: unknown): void {
    const state = classifyAdminError(e)
    gate.value = state
    if (state === 'disabled') {
      message.value = '管理接口不可用。请检查服务端的 ADMIN_ENABLED 与 ADMIN_TOKEN 是否都已配置。'
    } else if (state === 'unauthorized') {
      message.value = '管理令牌不正确。请核对 ADMIN_TOKEN。'
    } else {
      message.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
    }
  }

  async function verify(): Promise<boolean> {
    if (token.value === '') {
      gate.value = 'idle'
      message.value = ''
      return false
    }
    busy.value = true
    message.value = ''
    try {
      await api.domainKnowledge({ limit: 1 }, token.value)
      gate.value = 'ok'
      return true
    } catch (e) {
      noteError(e)
      return false
    } finally {
      busy.value = false
    }
  }

  async function loadKnowledge(options: { keyword?: string; enabledOnly?: boolean; tag?: string } = {}): Promise<void> {
    busy.value = true
    message.value = ''
    try {
      const r = await api.domainKnowledge({ ...options, limit: 500 }, token.value)
      entries.value = r.entries
      stats.value = r.stats
      gate.value = 'ok'
    } catch (e) {
      noteError(e)
    } finally {
      busy.value = false
    }
  }

  async function loadAudit(): Promise<void> {
    try {
      const r = await api.domainKnowledgeAudit(token.value, 100)
      audit.value = r.records
    } catch (e) {
      noteError(e)
    }
  }

  async function loadInjection(): Promise<void> {
    try {
      injection.value = await api.injectionPreview(token.value)
    } catch (e) {
      noteError(e)
    }
  }

  async function loadRecords(
    options: {
      limit?: number
      offset?: number
      minScore?: number
      maxScore?: number
      deliverable?: boolean
      logId?: string
      model?: string
      orderBy?: 'created' | 'overall' | 'rounds' | 'tool_calls'
      ascending?: boolean
    } = {},
  ): Promise<void> {
    busy.value = true
    message.value = ''
    try {
      const r = await api.records(options, token.value)
      records.value = r.records
      recordsTotal.value = r.total
      gate.value = 'ok'
    } catch (e) {
      noteError(e)
    } finally {
      busy.value = false
    }
  }

  async function loadRecordsStats(days?: number): Promise<void> {
    try {
      const r = await api.recordsStats(token.value, days)
      recordsStats.value = r.stats
    } catch (e) {
      noteError(e)
    }
  }

  async function removeEntry(id: string): Promise<boolean> {
    try {
      await api.removeDomainKnowledge(id, token.value)
      await loadKnowledge()
      return true
    } catch (e) {
      noteError(e)
      return false
    }
  }

  async function removeRecord(id: string): Promise<boolean> {
    try {
      await api.deleteRecord(id, token.value)
      await loadRecords()
      return true
    } catch (e) {
      noteError(e)
      return false
    }
  }

  async function purge(): Promise<number> {
    try {
      const r = await api.purgeRecords(token.value)
      await loadRecords()
      await loadRecordsStats()
      return r.deleted
    } catch (e) {
      noteError(e)
      return 0
    }
  }

  return {
    token,
    remember,
    gate,
    message,
    busy,
    entries,
    stats,
    audit,
    injection,
    records,
    recordsTotal,
    recordsStats,
    authorized,
    loadToken,
    saveToken,
    logout,
    verify,
    loadKnowledge,
    loadAudit,
    loadInjection,
    loadRecords,
    loadRecordsStats,
    removeEntry,
    removeRecord,
    purge,
  }
})
