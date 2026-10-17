<script setup lang="ts">
/**
 * 图标组件：数据在 `src/icons.ts`，此处只负责渲染与无障碍属性。
 *
 * `aria-hidden` + `focusable=false`：图标永远与文字标签同现，让读屏器把整段
 * 念成「发送」而不是「图像 发送」。若将来出现「只有图标没有文字」的按钮，
 * 请在该按钮上写 `aria-label`，而不要给图标加 title。
 */
import { computed } from 'vue';
import { ICONS } from '../icons.ts';

const props = withDefaults(
  defineProps<{
    name: string;
    /** 尺寸（px） */
    size?: number;
    /** 线宽 */
    width?: number;
  }>(),
  { size: 18, width: 1.75 },
);

const paths = computed<string[]>(() => ICONS[props.name] ?? ICONS['alert'] ?? []);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="width"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="icon"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  display: block;
  flex: none;
}
</style>
