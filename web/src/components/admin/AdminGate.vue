<script setup lang="ts">
/**
 * 管理入口的门禁。
 *
 * 三个事实必须在界面上分清（后端刻意如此）：
 *  - 404：管理接口未开启 **或** 已开启但没配令牌 —— 前端无法区分，
 *    只能提示「检查两个配置项」，不能假装知道是哪一个；
 *  - 401：令牌不正确；
 *  - 网络/500：服务异常。
 *
 * 把 404 说成「令牌错误」会让人反复换令牌，而真正的原因是配置没开。
 */
import { ref } from 'vue'
import { KeyRound, ShieldAlert } from 'lucide-vue-next'
import { useAdminStore } from '@/stores/admin'

const admin = useAdminStore()

const input = ref(admin.token)
const remember = ref(admin.remember)

async function submit(): Promise<void> {
  admin.saveToken(input.value, remember.value)
  await admin.verify()
}
</script>

<template>
  <div class="gate">
    <div class="gate__head">
      <ShieldAlert :size="18" aria-hidden="true" />
      <div>
        <h1 class="gate__title">管理台</h1>
        <p class="gate__lead">
          领域知识会原文注入每一次分析的系统提示词。这里的改动会影响所有用户的结论，
          因此需要服务端配置的管理令牌。
        </p>
      </div>
    </div>

    <form class="gate__form" @submit.prevent="submit">
      <div class="field">
        <label for="admin-token">管理令牌</label>
        <input
          id="admin-token"
          v-model="input"
          class="input mono"
          type="password"
          autocomplete="off"
          placeholder="ADMIN_TOKEN"
        />
        <span class="field-help">对应服务端环境变量 <code>ADMIN_TOKEN</code>。</span>
      </div>

      <label class="check">
        <input v-model="remember" type="checkbox" />
        <span>记住本机（默认只保留到关闭浏览器）</span>
      </label>

      <div class="gate__actions">
        <button type="submit" class="btn btn--primary" :disabled="admin.busy || input.trim() === ''">
          <KeyRound :size="14" aria-hidden="true" />
          {{ admin.busy ? '正在验证…' : '进入' }}
        </button>
      </div>
    </form>

    <p v-if="admin.message !== ''" class="alert alert--warn">{{ admin.message }}</p>

    <details class="gate__help">
      <summary>为什么 404 不一定是令牌错？</summary>
      <p>
        服务端在 <code>ADMIN_ENABLED</code> 未开启，或已开启但 <code>ADMIN_TOKEN</code>
        为空时，都返回与普通未知路由同形的 404——这是刻意的，避免未启用的部署暴露管理面。
        因此界面只能提示你同时检查这两项；只有 401 才代表「令牌值不对」。
      </p>
    </details>
  </div>
</template>

<style scoped>
.gate {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  max-width: 480px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-4);
}

.gate__head {
  display: flex;
  gap: var(--sp-3);
  color: var(--accent);
}

.gate__title {
  color: var(--ink);
  font-size: var(--fs-title);
}

.gate__lead {
  margin-top: 6px;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.75;
}

.gate__form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4) 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.check {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  cursor: pointer;
}

.check input {
  accent-color: var(--accent);
}

.gate__actions {
  display: flex;
  justify-content: flex-end;
}

.gate__help {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.75;
}

.gate__help summary {
  color: var(--ink-2);
  cursor: pointer;
}

.gate__help p {
  margin-top: 6px;
}
</style>
