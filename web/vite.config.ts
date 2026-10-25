import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * 前端挂载在 `/logshare/` 子路径（与 Node 静态托管一致）。
 *
 * `base` 与路由 history base **必须同为** `/logshare/`：
 * 前者写错 → 资源 404（白屏）；后者写错 → 首屏正常但刷新 404。
 * 两者在 dev 模式下都可能看不出来，只有构建产物才会暴露。
 */
export default defineConfig({
  base: '/logshare/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:8788',
      '/health': 'http://127.0.0.1:8788',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globals: false,
  },
})
