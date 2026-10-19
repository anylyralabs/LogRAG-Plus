<script setup lang="ts">
/**
 * 卷宗头。
 *
 * 排版意图：像一份卷宗的封面眉标——左边身份，右边编号。
 * 编号（日志 ID / 体量 / 错误数）是排障者最先要确认的东西，所以它和产品名同一行，
 * 而不是藏在一个徽章里。控制项只留两个图标，不给它们文字。
 */
const route = useRoute()
const colorMode = useColorMode()
const chat = useChat()

const isAdmin = computed(() => route.path.startsWith('/admin'))

/** 卷宗编号：日志 ID 与体量，用于在长会话里随时确认「我在看哪一份」 */
const caseNo = computed(() => (chat.logId.value === '' ? '' : chat.logId.value))

function toggleTheme(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <UApp :toaster="{ position: 'top-center' }">
    <div class="flex min-h-dvh flex-col bg-[var(--ui-bg)]">
      <header class="sticky top-0 z-20 bg-[var(--ui-bg)]/92 backdrop-blur">
        <div
          class="mx-auto flex w-full max-w-5xl items-baseline gap-3 border-b border-[var(--ui-border)] px-4 py-3 sm:px-6"
        >
          <NuxtLink
            to="/"
            class="flex items-baseline gap-2 text-[var(--ui-text-highlighted)] no-underline"
          >
            <span class="font-mono text-[13px] font-semibold tracking-tight">LogRAG+</span>
          </NuxtLink>

          <span class="text-[11px] text-[var(--ui-text-dimmed)]">日志排障</span>

          <span
            v-if="caseNo !== ''"
            class="hidden font-mono text-[11px] text-[var(--ui-text-muted)] sm:inline"
          >
            {{ caseNo }}
          </span>

          <div class="flex-1" />

          <UButton
            :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="colorMode.value === 'dark' ? '切换到浅色' : '切换到深色'"
            @click="toggleTheme"
          />
          <UButton
            :to="isAdmin ? '/' : '/admin'"
            color="neutral"
            variant="ghost"
            size="xs"
            :icon="isAdmin ? 'i-lucide-arrow-left' : 'i-lucide-settings-2'"
            :aria-label="isAdmin ? '返回对话' : '管理设置'"
          />
        </div>
      </header>

      <main class="flex min-h-0 flex-1 flex-col">
        <NuxtPage />
      </main>
    </div>
  </UApp>
</template>
