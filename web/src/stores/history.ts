/**
 * 本机会话历史（界面状态）。
 *
 * 数据源是 `lib/history.ts` 的 localStorage。这里包一层 Pinia，是因为
 * 会话栏与对话状态机都要改它：发送成功后要立刻出现在左侧栏，而不是等刷新。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  clearHistory,
  forgetSession,
  listHistory,
  type HistoryEntry,
} from '@/lib/history'

export const useHistoryStore = defineStore('history', () => {
  const entries = ref<HistoryEntry[]>([])

  function refresh(): void {
    entries.value = listHistory()
  }

  function remove(sessionId: string): void {
    forgetSession(sessionId)
    refresh()
  }

  function clear(): void {
    clearHistory()
    refresh()
  }

  return { entries, refresh, remove, clear }
})
