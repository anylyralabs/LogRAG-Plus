<script setup lang="ts">
/**
 * 应用顶栏。
 *
 * 只放全局的、与当前上下文无关的东西：品牌、日志编号、新建、设置。
 * 会话列表在左侧栏，不放在这里——两处都能切会话会造成状态归属混乱。
 */
import { computed } from 'vue'
import { FileText, PanelLeft, Plus, Settings, Shield } from 'lucide-vue-next'

const props = defineProps<{
  logId?: string
  /** 窄屏：打开会话栏 */
  showMenu?: boolean
  /** 有日志/草稿时，窄屏顶栏给一个「案卷」入口（替代悬浮按钮） */
  hasDossier?: boolean
}>()

const emit = defineEmits<{
  menu: []
  new: []
  settings: []
  dossier: []
}>()

const title = computed(() => (props.logId !== undefined && props.logId !== '' ? '日志排障' : 'LogRAG+'))
</script>

<template>
  <header class="topbar">
    <button
      v-if="showMenu === true"
      type="button"
      class="btn btn--ghost btn--icon btn--sm only-narrow"
      aria-label="打开会话栏"
      @click="emit('menu')"
    >
      <PanelLeft :size="16" aria-hidden="true" />
    </button>

    <RouterLink to="/" class="brand" aria-label="回到首页">
      <span class="brand__name">{{ title }}</span>
    </RouterLink>

    <span v-if="logId !== undefined && logId !== ''" class="topbar__id num">{{ logId }}</span>

    <div class="topbar__spacer" />

    <!-- 窄屏：案卷入口。放在顶栏而不是悬浮按钮——悬浮按钮会盖住输入区的发送键。 -->
    <button
      v-if="hasDossier === true"
      type="button"
      class="btn btn--ghost btn--icon btn--sm only-narrow"
      aria-label="打开日志案卷"
      title="日志案卷"
      @click="emit('dossier')"
    >
      <FileText :size="16" aria-hidden="true" />
    </button>

    <button
      type="button"
      class="btn btn--ghost btn--icon btn--sm"
      aria-label="新建分析"
      title="新建分析"
      @click="emit('new')"
    >
      <Plus :size="16" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="btn btn--ghost btn--icon btn--sm"
      aria-label="设置"
      title="设置"
      @click="emit('settings')"
    >
      <Settings :size="16" aria-hidden="true" />
    </button>
    <RouterLink to="/admin" class="btn btn--ghost btn--icon btn--sm" aria-label="管理台" title="管理台">
      <Shield :size="15" aria-hidden="true" />
    </RouterLink>
  </header>
</template>

<style scoped>
/* 顶栏属于画布层：无边框、与外壳同色，靠留白与阅读区的纸面区分开 */
.topbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--topbar-h);
  padding: 0 var(--sp-4);
  background: transparent;
  flex: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink);
  text-decoration: none;
}

.brand__name {
  font-size: var(--fs-body);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.topbar__id {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--paper-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.topbar__spacer {
  flex: 1;
}

a.btn {
  text-decoration: none;
}

@media (max-width: 959px) {
  .brand__name {
    display: none;
  }
}
</style>
