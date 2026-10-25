import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由。
 *
 * 入口形态是 `https://agent.logshare.cn/logshare/{日志ID}`——日志 ID 是应用内
 * 第一段路由（与后端静态托管的 SPA 回退一致）。因此：
 *  - `/logshare/:logId` 必须放在最前，但用正则限定为七位字母数字，
 *    避免把 `/admin` 之类的路径吞掉；
 *  - `/logshare/admin` 是独立路由并**懒加载**，管理面不进首屏包。
 *
 * history base 必须与 Vite 的 `base` 同为 `/logshare/`：写错时首屏正常但刷新 404。
 */
const router = createRouter({
  history: createWebHistory('/logshare/'),
  routes: [
    {
      // `/logshare/` 就是聊天首页：打开即可提问，日志是可选附件。
      // 官网式首页在根路径 `/`（由 static.ts 直接托管 landing.html），
      // 与应用分开——第一次来的人先看「这是什么」，而不是先面对输入框。
      path: '/',
      name: 'home',
      component: () => import('@/pages/WorkspacePage.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/pages/AdminPage.vue'),
    },
    {
      path: '/new',
      name: 'new-chat',
      component: () => import('@/pages/WorkspacePage.vue'),
    },
    {
      path: '/s/:sessionId',
      name: 'session',
      component: () => import('@/pages/WorkspacePage.vue'),
    },
    {
      // 七位日志 ID（与后端 isValidLogId 的字符集一致）
      path: '/:logId([A-Za-z0-9]{7})',
      name: 'workspace',
      component: () => import('@/pages/WorkspacePage.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
    },
  ],
  scrollBehavior(to, from, saved) {
    if (saved !== null && saved !== undefined) return saved
    // 同一页面内切换日志时不复位滚动，避免打断阅读
    if (to.name === from.name) return {}
    return { top: 0 }
  },
})

/**
 * 标题：在浏览器标签与移动端任务切换器里能认出是哪份日志。
 * 日志 ID 用等宽不是浏览器能控制的，这里只保证语义正确。
 */
router.afterEach((to) => {
  const logId = typeof to.params['logId'] === 'string' ? to.params['logId'] : ''
  if (to.name === 'admin') document.title = '管理 · LogRAG+'
  else if (logId !== '') document.title = `${logId} · LogRAG+`
  else document.title = 'LogRAG+ · 日志排障'
})

export default router
