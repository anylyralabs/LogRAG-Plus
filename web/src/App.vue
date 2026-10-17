<script setup lang="ts">
/**
 * 应用外壳（instrument rig）。
 *
 * 顶部只有四样东西：记号、当前日志、管理入口、设置。无登录无收费，所以没有
 * 头像 / 套餐 / 通知这些占位——这一条是刻意的：**光是「有哪些元素」就说明了
 * 这是什么产品**，摆一个空头像位会让人以为这里以后会有账号体系。
 *
 * 记号是一个 10px 的青瓷方块 + 等宽产品名。不做 Logo 图形：这个产品的辨识度
 * 应该来自它把日志变成证据的方式，不是来自一个图案。
 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import ProviderSheet from './components/ProviderSheet.vue';

const route = useRoute();
const sheetOpen = ref(false);

const boundLogId = computed(() => {
  const p = route.params['logId'];
  return typeof p === 'string' && p !== '' ? p : null;
});
</script>

<template>
  <div class="shell">
    <header class="rig">
      <RouterLink class="mark" to="/">
        <span class="mark__glyph" aria-hidden="true" />
        <span class="mark__name mono">LogRAG+</span>
      </RouterLink>

      <span class="rig__sep" aria-hidden="true" />

      <span v-if="boundLogId !== null" class="rig__ctx mono" :title="`当前日志 ${boundLogId}`">
        {{ boundLogId }}
      </span>
      <span v-else class="rig__ctx rig__ctx--idle">未绑定日志</span>

      <span class="grow" />

      <RouterLink class="rig__link" to="/admin" title="管理面">
        <Icon name="shield" :size="16" />
        <span class="rig__link-text">管理</span>
      </RouterLink>

      <button type="button" class="icon-btn" aria-label="设置" title="设置" @click="sheetOpen = true">
        <Icon name="settings" :size="17" />
      </button>
    </header>

    <main class="shell__main">
      <RouterView />
    </main>

    <ProviderSheet :open="sheetOpen" @close="sheetOpen = false" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
}

.rig {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--s3);
  height: var(--rig-h);
  padding: 0 var(--s4);
  padding-top: env(safe-area-inset-top);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.mark {
  display: flex;
  align-items: center;
  gap: var(--s3);
  color: var(--text);
  text-decoration: none;
}

.mark__glyph {
  width: 10px;
  height: 10px;
  background: var(--accent);
  border-radius: 1px;
}

.mark__name {
  font-size: var(--t-h5);
  font-weight: 500;
  letter-spacing: -0.01em;
}

.rig__sep {
  width: 1px;
  height: 18px;
  background: var(--line-2);
}

.rig__ctx {
  font-size: var(--t-caption);
  color: var(--text-2);
}

.rig__ctx--idle {
  color: var(--text-3);
  font-family: var(--font-text);
}

.grow {
  flex: 1;
}

.rig__link {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  height: 32px;
  padding: 0 var(--s3);
  border-radius: var(--r1);
  color: var(--text-2);
  font-size: var(--t-small);
  text-decoration: none;
}

.rig__link:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* 窄屏把「管理」两个字去掉，只留盾牌图标：顶栏上文字比图标占得贵 */
@media (max-width: 560px) {
  .rig__link-text {
    display: none;
  }
}

.shell__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
</style>
