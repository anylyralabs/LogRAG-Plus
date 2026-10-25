<script setup lang="ts">
/**
 * 应用壳。
 *
 * 只做两件事：首屏前恢复「仅本次会话」的供应商配置，以及托管路由出口。
 * 布局由页面自己决定——入口页与工作台的结构不同，套同一个三栏壳反而别扭。
 */
import { onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

onMounted(() => {
  settings.restoreSessionOnly()
})
</script>

<template>
  <RouterView />
</template>
