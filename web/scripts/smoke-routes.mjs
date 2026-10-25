/**
 * 深链冒烟：用真实构建产物 + jsdom 逐个打开路由。
 *
 * ## 为什么需要它
 * `vite build` 成功只说明能打包；`vitest` 测的是组件与纯函数。两者都覆盖不到
 * 「构建后的 chunk 名称、路由懒加载、首次挂载时解析 URL」这条路径——而线上
 * 最常见的白屏恰恰出在这里。
 *
 * ## 为什么每个用例一个子进程
 * 入口模块在顶层执行 `app.mount('#app')`，一个进程只能挂载一次。
 * 「点链接切路由」与「直接用某个地址打开」也不是同一条路径：真实用户打开
 * `/logshare/s/xxx` 时服务端返回 index.html，前端**首次挂载**就解析 URL。
 * 本脚本只测后者。
 *
 * ## 用法
 * ```bash
 * cd web && npm run build
 * node scripts/smoke-routes.mjs
 * ```
 * 退出码非零表示某个路由未渲染或出现运行时异常。
 */
import { JSDOM } from 'jsdom'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const DIST = join(process.cwd(), 'dist')

/** 每个用例：路径、期望文本（够独特即可，不追求整段匹配） */
const CASES = [
  { path: '/', expect: '把问题说清楚', label: '聊天首页' },
  { path: '/new', expect: '把问题说清楚', label: '纯对话页' },
  { path: '/kalkLqQ', expect: 'kalkLqQ', label: '工作台（日志编号）' },
  { path: '/kalkLqQ', expect: '反混淆处理中', label: '日志面板（反混淆提示）' },
  { path: '/kalkLqQ', expect: 'huge.log', label: '日志面板（省略附件提示）' },
  { path: '/s/sabc123', expect: '加载器互不兼容', label: '会话回放（结论脊柱）' },
  { path: '/s/sabc123', expect: '二选一并迁移模组', label: '会话回放（处置步骤）' },
  { path: '/admin', expect: '管理台', label: '管理台门禁' },
  { path: '/not-a-route', expect: '这个地址没有对应的页面', label: '404' },
]

/* ── 固定桩数据 ─────────────────────────────────────────── */

const SESSION = {
  ok: true,
  session: { id: 'sabc123', logId: null, createdAt: 1729000000, expiresAt: 1999999999 },
  rounds: { allowed: true, remaining: 9 },
  messages: [
    { role: 'user', content: 'Fabric 和 Forge 能混装吗？', createdAt: 1729000000 },
    {
      role: 'assistant',
      content:
        '不能直接混装。\n\n```json\n{"rootCause":"加载器互不兼容","confidence":0.9,"steps":["二选一并迁移模组"],"evidence":["Forge 与 Fabric 的 Mixin 体系不同"]}\n```',
      reasoning: '先判断加载器',
      createdAt: 1729000010,
      score: {
        overall: 85,
        deliverable: true,
        dimensions: { grounding: null, verification: 100, actionability: 90, economy: 100 },
        deductions: [],
        missingAnchors: [],
      },
    },
  ],
}

const LOG_DOC = {
  ok: true,
  logId: 'kalkLqQ',
  source: 'fcl/1.3.4',
  createdAt: 1729000000,
  maybeObfuscating: true,
  docs: [
    {
      name: 'main.log',
      bytes: 200,
      lines: 6,
      content: [
        '===== latest.log =====',
        '[12:00:00] [main/INFO]: Loading',
        '[12:00:01] [main/ERROR]: java.lang.NoSuchMethodError',
        '  at com.example.CoolMod.onInit(CoolMod.java:42)',
        '[12:00:02] [main/WARN]: odd',
        '===== crash-report.txt =====',
      ].join('\n'),
      truncated: false,
    },
  ],
  omitted: ['huge.log'],
}

const EMPTY_STATS = {
  total: 0,
  sampled: 0,
  truncated: false,
  avgOverall: null,
  dimensions: { grounding: null, verification: null, actionability: null, economy: null },
  deliverableRate: null,
  avgRounds: null,
  avgToolCalls: null,
  scoreBuckets: {},
  topDeductions: [],
  byModel: {},
  lowScoreCount: 0,
}

const EMPTY_DOMAIN_STATS = {
  total: 0,
  enabled: 0,
  methodLike: 0,
  unclear: 0,
  byTag: {},
  injectedChars: 0,
  injectedCount: 0,
  skippedCount: 0,
}

function stubFetch(input) {
  const url = typeof input === 'string' ? input : input.url
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  if (url.includes('/health')) {
    return json({
      ok: true,
      service: 'lograg-plus',
      version: '0.1.0',
      rag: { chunks: 413, files: 42 },
      config: { defaultProvider: 'stub-model' },
    })
  }
  if (url.includes('/v1/log/')) return json(LOG_DOC)
  if (url.includes('/v1/session/')) return json(SESSION)
  if (url.includes('/v1/topics')) return json({ ok: true, topics: '- cases：5 个文件' })
  if (url.includes('/v1/admin/domain-knowledge')) {
    return json({ ok: true, entries: [], stats: EMPTY_DOMAIN_STATS })
  }
  if (url.includes('/v1/admin/records/stats')) return json({ ok: true, stats: EMPTY_STATS })
  if (url.includes('/v1/admin/records')) return json({ ok: true, records: [], total: 0 })
  return json({ ok: false, error: 'stub 404' }, 404)
}

/* ── 子进程模式：真正挂载一次 ───────────────────────────── */

async function runOne(pathname, expect) {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  const entry = readdirSync(join(DIST, 'assets')).find(
    (f) => f.startsWith('index-') && f.endsWith('.js'),
  )
  if (entry === undefined) throw new Error('找不到入口 chunk，先执行 npm run build')

  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:8788/logshare${pathname}`,
    pretendToBeVisual: true,
  })
  const w = dom.window

  for (const key of [
    'window',
    'document',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'HTMLElement',
    'SVGElement',
    'Element',
    'Node',
    'Text',
    'Comment',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    if (w[key] !== undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: w[key] })
    }
  }

  w.scrollTo = () => {}
  globalThis.scrollTo = () => {}
  // jsdom 未实现 Element.scrollTo / scrollBy；虚拟列表与线程滚动依赖它们
  w.Element.prototype.scrollTo = function scrollTo(arg) {
    if (typeof arg === 'object' && arg !== null && typeof arg.top === 'number') {
      this.scrollTop = arg.top
    }
  }
  w.Element.prototype.scrollBy = function scrollBy() {}

  globalThis.matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.fetch = stubFetch

  // jsdom 不加载外部资源：Vite 的 CSS 预加载会等 link 的 load 事件，永不触发
  // → 懒加载路由不渲染。补一个 load 事件，绕开的是**测试环境限制**。
  const appendChild = w.Element.prototype.appendChild
  w.Element.prototype.appendChild = function patched(node) {
    const out = appendChild.call(this, node)
    if (node && node.tagName === 'LINK') {
      setTimeout(() => node.dispatchEvent(new w.Event('load')), 0)
    }
    return out
  }

  const errors = []
  process.on('unhandledRejection', (e) => errors.push(String(e?.message ?? e)))

  await import(pathToFileURL(join(DIST, 'assets', entry)).href)

  const deadline = Date.now() + 5000
  let text = ''
  while (Date.now() < deadline) {
    text = w.document.querySelector('#app')?.textContent ?? ''
    if (text.includes(expect)) break
    await new Promise((r) => setTimeout(r, 60))
  }

  if (!text.includes(expect)) {
    throw new Error(`期望包含「${expect}」，实际：${text.replace(/\s+/g, ' ').slice(0, 320)}`)
  }
  if (errors.length > 0) {
    throw new Error(`运行时异常：${errors.join('; ')}`)
  }
}

/* ── 主进程模式：逐个子进程执行 ─────────────────────────── */

if (process.argv[2] === '--one') {
  const pathname = process.argv[3] ?? '/'
  const expect = process.argv[4] ?? ''
  try {
    await runOne(pathname, expect)
    process.exit(0)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

let failed = 0
for (const testCase of CASES) {
  const child = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, '--one', testCase.path, testCase.expect],
    { encoding: 'utf8', cwd: process.cwd() },
  )
  if (child.status === 0) {
    console.log(`OK   ${testCase.path.padEnd(14)} ${testCase.label}`)
  } else {
    failed++
    const reason = (child.stderr || child.stdout || '未知错误').trim().split('\n').slice(-3).join(' ')
    console.error(`FAIL ${testCase.path.padEnd(14)} ${testCase.label}`)
    console.error(`     ${reason}`)
  }
}

if (failed === 0) console.log(`\n${CASES.length} 个路由全部渲染成功`)
process.exit(failed === 0 ? 0 : 1)
