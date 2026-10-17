import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 构建配置。
 *
 * `base: '/logshare/'` 不是随意定的：产品入口是
 *
 *   https://agent.logshare.cn/logshare/{日志ID}
 *
 * 由 LogShare 前端跳转过来，也就是「应用挂在 `/logshare/` 子路径下，日志 ID 是
 * 应用内的第一段路由」。因此 router 的 history base 也必须是 `/logshare/`，
 * 否则深链刷新会 404。独立使用时访问 `/logshare/` 即为首页。
 */
export default defineConfig({
  base: '/logshare/',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 开发期把接口透传给 Node 服务，避免前端再配一份 CORS 白名单
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8788', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 移动端弱网：单包体积比拆分请求数更重要，宁可单块大一点
    chunkSizeWarningLimit: 900,
  },
});
