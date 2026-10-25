/**
 * 打包路径与静态托管的约定。
 *
 * 这两条曾经以「服务正常、页面 404 / 白屏」的形态出现过：
 *  - Vite `base` 与路由 history base 不一致 → 首屏正常、刷新 404；
 *  - 产物目录与后端 `WEB_DIR` 默认值不一致 → 服务正常、页面 404。
 *
 * 测试直接读配置与后端源码，避免文档与实现漂移。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const WEB_ROOT = resolve(process.cwd())

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), 'utf8')
}

describe('前端挂载路径', () => {
  it('Vite base 是 /logshare/', () => {
    expect(read('/vite.config.ts')).toMatch(/base:\s*'\/logshare\/'/)
  })

  it('路由 history base 与 Vite base 一致', () => {
    expect(read('/src/router/index.ts')).toMatch(/createWebHistory\('\/logshare\/'\)/)
  })

  it('产物目录是 web/dist（与后端默认值一致）', () => {
    expect(read('/vite.config.ts')).toMatch(/outDir:\s*'dist'/)
  })

  it('后端静态托管默认去 web/dist', () => {
    const backend = readFileSync(join(WEB_ROOT, '..', 'src/server/static.ts'), 'utf8')
    expect(backend).toMatch(/resolve\(process\.cwd\(\),\s*'web',\s*'dist'\)/)
    expect(backend).toMatch(/const BASE = '\/logshare'/)
  })

  it('后端资源目录白名单仍允许 Vite 的 assets/', () => {
    const backend = readFileSync(join(WEB_ROOT, '..', 'src/server/static.ts'), 'utf8')
    expect(backend).toContain("'assets/'")
  })
})

describe('入口与标题', () => {
  it('index.html 引用 /src/main.ts 且语言为 zh-CN', () => {
    const html = read('/index.html')
    expect(html).toContain('src="/src/main.ts"')
    expect(html).toContain('lang="zh-CN"')
  })

  it('不引用网络字体（离线构建与中文首屏）', () => {
    const css = read('/src/styles/tokens.css') + read('/src/styles/base.css')
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import\s+url\(https?:/)
  })
})
