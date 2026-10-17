/**
 * 路由。
 *
 * `createWebHistory('/logshare/')` 里的 base 必须与 vite 的 `base` 一致：
 * 部署形态是「应用挂在 `/logshare/` 子路径下，日志 ID 是应用内第一段路由」，
 * 即 `/logshare/{日志ID}` 由 LogShare 跳转而来。base 写错的表现是
 * 「首屏正常、一刷新就 404」，且 dev 下不容易发现。
 *
 * 路由顺序有讲究：静态段必须声明在动态段 `:logId` 之前，否则 `/logshare/admin`
 * 会被当成「一个叫 admin 的日志 ID」。
 */

import { createRouter, createWebHistory } from 'vue-router';
import ChatPage from './pages/ChatPage.vue';

export const router = createRouter({
  history: createWebHistory('/logshare/'),
  routes: [
    { path: '/', name: 'home', component: ChatPage },
    {
      path: '/admin',
      name: 'admin',
      // 管理面单独分包：普通用户永远不会加载到它（移动端流量敏感）
      component: () => import('./pages/AdminPage.vue'),
    },
    { path: '/:logId', name: 'chat-with-log', component: ChatPage, props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
