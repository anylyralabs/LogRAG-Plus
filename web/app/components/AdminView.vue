<script setup lang="ts">
/**
 * 管理页。
 *
 * 与对话页同一套排版语言：栏目标记 + 发丝线 + 等宽元信息，不用卡片。
 * 它是后台，信息密度可以高，但结构必须与前台同源——两份界面长得不一样，
 * 用户会以为是两个产品。
 */
import { ApiError } from '../lib/api'

const token = ref('')
const busy = ref(false)
const entries = ref<Array<{ id: string; text: string; createdAt: number }>>([])
const records = ref<
  Array<{ cacheKey: string; logId: string; overall: number; mode: string; createdAt: number }>
>([])
const status = ref<'idle' | 'ok' | 'not-found' | 'unauthorized' | 'error'>('idle')
const message = ref('')
const newText = ref('')

const KEY = 'lograg.adminToken'

onMounted(() => {
  token.value = localStorage.getItem(KEY) ?? ''
  if (token.value !== '') void load()
})

function authHeaders(): Record<string, string> {
  return token.value === '' ? {} : { 'x-admin-token': token.value }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  })
  // 三态必须分开：未开启(404) / 未配令牌(404) / 令牌不匹配(401)
  if (res.status === 404) {
    status.value = 'not-found'
    throw new ApiError(404, '管理接口未开启')
  }
  if (res.status === 401) {
    status.value = 'unauthorized'
    throw new ApiError(401, '令牌不正确')
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  status.value = 'ok'
  return (await res.json()) as T
}

async function load(): Promise<void> {
  message.value = ''
  busy.value = true
  try {
    const d = await call<{ entries?: Array<{ id: string; text: string; createdAt: number }> }>(
      '/v1/admin/domain-knowledge',
    )
    entries.value = d.entries ?? []
    const r = await call<{
      records?: Array<{ cacheKey: string; logId: string; overall: number; mode: string; createdAt: number }>
    }>('/v1/admin/records?limit=20')
    records.value = r.records ?? []
    localStorage.setItem(KEY, token.value)
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function addEntry(): Promise<void> {
  const text = newText.value.trim()
  if (text === '') return
  busy.value = true
  try {
    await call('/v1/admin/domain-knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    newText.value = ''
    await load()
    useToast().add({ title: '已添加', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    useToast().add({
      title: '添加没有成功',
      description: e instanceof Error ? e.message : '',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function removeEntry(id: string): Promise<void> {
  try {
    await call(`/v1/admin/domain-knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    useToast().add({
      title: '删除没有成功',
      description: e instanceof Error ? e.message : '',
      color: 'error',
    })
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 sm:px-6">
    <header class="border-b border-[var(--ui-border)] py-7">
      <h1 class="text-[21px] leading-snug font-semibold text-[var(--ui-text-highlighted)]">管理</h1>
      <p class="mt-1.5 max-w-[24em] text-[13px] leading-relaxed text-[var(--ui-text-toned)]">
        领域知识与分析记录。管理接口默认关闭，需要在服务端设置
        <code class="font-mono text-[11px]">ADMIN_ENABLED</code> 与
        <code class="font-mono text-[11px]">ADMIN_TOKEN</code>。
      </p>
    </header>

    <!-- 令牌 -->
    <section class="grid gap-3 border-b border-[var(--ui-border)] py-6 sm:grid-cols-[7.5rem_1fr]">
      <div class="dossier-label h-fit">访问令牌</div>
      <div>
        <form class="flex max-w-md gap-2" @submit.prevent="load">
          <UInput
            v-model="token"
            type="password"
            placeholder="ADMIN_TOKEN"
            class="flex-1"
            :ui="{ base: 'font-mono text-[11px]' }"
          />
          <UButton type="submit" :loading="busy" color="neutral" variant="subtle">连接</UButton>
        </form>

        <div v-if="status === 'not-found'" class="mt-3 max-w-md border-l-2 border-[var(--ui-warning)] pl-3">
          <p class="text-[13px] font-medium text-[var(--ui-warning)]">管理接口未开启</p>
          <p class="mt-1 text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            服务端没有启用管理面。这与「令牌错误」是两件事——先去打开配置项，而不是反复换令牌。
          </p>
        </div>
        <div
          v-else-if="status === 'unauthorized'"
          class="mt-3 max-w-md border-l-2 border-[var(--ui-error)] pl-3"
        >
          <p class="text-[13px] font-medium text-[var(--ui-error)]">令牌不正确</p>
          <p class="mt-1 text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            令牌已配置但不匹配，核对服务端的 ADMIN_TOKEN。
          </p>
        </div>
        <p v-if="message !== ''" class="mt-2 font-mono text-[11px] text-[var(--ui-text-muted)]">
          {{ message }}
        </p>
      </div>
    </section>

    <template v-if="status === 'ok'">
      <!-- 领域知识 -->
      <section class="grid gap-3 border-b border-[var(--ui-border)] py-6 sm:grid-cols-[7.5rem_1fr]">
        <div class="dossier-label h-fit">领域知识 {{ entries.length }}</div>
        <div>
          <p class="mb-3 max-w-[24em] text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
            这些条目会直接拼进系统提示词，作为强制先验规则，模型无权修改。单条控制在 200 字内。
          </p>

          <ul v-if="entries.length > 0" class="flex flex-col">
            <li
              v-for="e in entries"
              :key="e.id"
              class="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b border-[var(--ui-border-muted)] py-2 last:border-b-0"
            >
              <span class="text-[13px] leading-relaxed text-[var(--ui-text)]">{{ e.text }}</span>
              <UButton
                icon="i-lucide-trash-2"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="删除这条"
                @click="removeEntry(e.id)"
              />
            </li>
          </ul>
          <p v-else class="text-[11px] text-[var(--ui-text-dimmed)]">还没有条目。</p>

          <form class="mt-4 flex max-w-md gap-2" @submit.prevent="addEntry">
            <UInput
              v-model="newText"
              placeholder="一条规则，例如 FCL 内置 JDK 17 在 Kirin 芯片上会崩"
              class="flex-1"
              :ui="{ base: 'text-[11px]' }"
            />
            <UButton
              type="submit"
              :disabled="newText.trim() === ''"
              :loading="busy"
              color="neutral"
              variant="subtle"
            >
              添加
            </UButton>
          </form>
        </div>
      </section>

      <!-- 分析记录 -->
      <section class="grid gap-3 py-6 sm:grid-cols-[7.5rem_1fr]">
        <div class="dossier-label h-fit">最近分析 {{ records.length }}</div>
        <div>
          <table v-if="records.length > 0" class="w-full border-collapse">
            <tbody>
              <tr
                v-for="r in records"
                :key="r.cacheKey"
                class="border-b border-[var(--ui-border-muted)] last:border-b-0"
              >
                <td class="py-2 pr-3 font-mono text-[11px] text-[var(--ui-text-toned)]">{{ r.logId }}</td>
                <td class="py-2 pr-3 font-mono text-[10px] text-[var(--ui-text-dimmed)]">{{ r.mode }}</td>
                <td class="py-2 text-right">
                  <span
                    class="line-no font-mono text-[11px] font-medium"
                    :class="
                      r.overall >= 80
                        ? 'text-[var(--ui-success)]'
                        : r.overall >= 60
                          ? 'text-[var(--ui-warning)]'
                          : 'text-[var(--ui-error)]'
                    "
                  >{{ r.overall }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-[11px] text-[var(--ui-text-dimmed)]">还没有记录。</p>
        </div>
      </section>
    </template>
  </div>
</template>
