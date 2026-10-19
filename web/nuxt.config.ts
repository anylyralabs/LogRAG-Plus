export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  // 关掉字体自动下载：中文本来走系统字体，打包 ibm-plex 只是把 latin 子集带进来，
  // 而构建时联网下载会拖慢且不可离线复现
  fonts: { providers: { google: false, bunny: false } },
  css: ['~/assets/css/main.css'],
  // 纯客户端：后端已提供全部 API，不需要 SSR
  ssr: false,
  devtools: { enabled: false },
  // 与后端静态托管路径一致（src/server/static.ts 的 BASE）
  app: {
    baseURL: '/logshare/',
    head: {
      title: 'LogRAG+ 日志排障',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'color-scheme', content: 'dark light' },
        { name: 'description', content: '把 Minecraft 崩溃日志贴进来，得到有依据、能照着做的排障结论。' },
      ],
    },
  },
  nitro: { preset: 'static' },
  colorMode: { preference: 'system', fallback: 'dark' },
  ui: { colorMode: true },
  vite: {
    server: {
      proxy: {
        '/v1': 'http://127.0.0.1:8788',
        '/health': 'http://127.0.0.1:8788',
      },
    },
  },
})
