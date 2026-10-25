<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
</script>

<template>
  <div class="nf">
    <div class="nf__card">
      <p class="label">404</p>
      <h1>这个地址没有对应的页面。</h1>
      <p class="nf__lead">
        日志编号是七位字母或数字；管理台在 <code>/logshare/admin</code>。
      </p>
      <p class="nf__path mono">{{ route.fullPath }}</p>
      <div class="nf__actions">
        <button type="button" class="btn btn--primary" @click="router.push('/')">回到入口</button>
        <button type="button" class="btn" @click="router.back()">返回上一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: var(--sp-4);
}

.nf__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-width: 420px;
}

h1 {
  font-size: var(--fs-title);
}

.nf__lead {
  color: var(--ink-2);
  line-height: var(--lh-body);
}

.nf__path {
  padding: 6px 8px;
  border-left: 2px solid var(--rule-strong);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  overflow-wrap: anywhere;
}

.nf__actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
</style>
