/**
 * 服务状态。
 *
 * `/health` 的 `config` 是**人读摘要**，字段值可能是中文说明（如「未配置」）。
 * 因此只有 `rag.chunks` / `rag.files` 这类数值字段可作程序判断，
 * 其余按原样展示，不要尝试解析。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api } from '@/lib/api'
import type { HealthResponse } from '@/lib/types'

export const useHealthStore = defineStore('health', () => {
  const data = ref<HealthResponse | null>(null)
  const loading = ref(false)
  const error = ref('')

  const ready = computed(() => data.value !== null)
  const ragAvailable = computed(() => (data.value?.rag.chunks ?? 0) > 0)
  const defaultProvider = computed(() => {
    const raw = data.value?.config['defaultProvider']
    return typeof raw === 'string' ? raw : '(未配置)'
  })

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      data.value = await api.health()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '无法连接到服务'
    } finally {
      loading.value = false
    }
  }

  return { data, loading, error, ready, ragAvailable, defaultProvider, load }
})
