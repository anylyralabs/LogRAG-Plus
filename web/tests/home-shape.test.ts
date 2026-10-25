/**
 * 首页形态与追问恢复的守门。
 *
 * 两条都是**结构性决定**，不是样式偏好：
 *
 * 1. **应用首页就是聊天界面**。日志是可选附件，不是入场券。
 *    曾经的首屏是「输入七位编号 / 上传 / 粘贴」三件套——打开先填表，
 *    与「问一句就能开始」的产品定位相反。
 * 2. **官网首页在根路径，与应用分开**。第一次来的人先看「这是什么」；
 *    把产品说明塞进应用首屏，会让两边都做不好。
 *
 * 3. **追问（ask_user）必须可恢复**。问题随消息落库，刷新后仍能作答；
 *    只写在正文或流帧里，等于把「AI 反问你」变成一次性提示。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const WEB = resolve(process.cwd())
const BACKEND = resolve(WEB, '..')

function read(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
}

describe('应用首页 = 聊天界面', () => {
  it('/logshare/ 直接挂工作台，不再有表单式入口页', () => {
    const router = read('src/router/index.ts')
    const home = /path:\s*'\/',[\s\S]*?name:\s*'home',[\s\S]*?component:\s*\(\)\s*=>\s*import\('([^']+)'\)/.exec(
      router,
    )
    expect(home?.[1]).toBe('@/pages/WorkspacePage.vue')
  })

  it('表单式入口组件已移除（避免两套首屏并存）', () => {
    expect(existsSync(join(WEB, 'src/components/entry/EntryPanel.vue'))).toBe(false)
  })

  it('工作台空状态使用聊天引导，而不是上传/编号表单', () => {
    const page = read('src/pages/WorkspacePage.vue')
    expect(page).toContain('<ChatStart')
    expect(page).not.toContain('EntryPanel')
    // 上传入口仍在，但收在输入区
    expect(page).toContain('@upload="triggerUpload"')
  })

  it('上传入口在输入区内，辅助信息只有一行', () => {
    const composer = read('src/components/chat/Composer.vue')
    // 上传入口是输入框里的加号（不再是独立的工具条）
    expect(composer).toContain("emit('upload')")
    expect(composer).toContain('composer__attach')
    // 辅助行只有快捷键那些
    expect(composer).toContain('composer__foot')
    expect(composer).toContain('回车发送')
  })
})

describe('官网首页独立于应用', () => {
  it('landing.html 存在于构建产物目录的源位置（public/）', () => {
    expect(existsSync(join(WEB, 'public/landing.html'))).toBe(true)
  })

  it('后端在根路径返回 landing.html，缺失时回退重定向', () => {
    const backend = readFileSync(join(BACKEND, 'src/server/static.ts'), 'utf8')
    expect(backend).toContain('landing.html')
    expect(backend).toMatch(/path === '\/'/)
    // 回退仍然把用户送到应用，而不是 404
    expect(backend).toContain("location: `${BASE}/`")
  })

  it('官网不引用应用入口脚本，也不加载远程资源', () => {
    const html = read('public/landing.html')
    expect(html).not.toContain('/src/main.ts')
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/)
    expect(html).not.toMatch(/<img[^>]+https?:/)
  })

  it('官网指向应用的入口是 /logshare/', () => {
    const html = read('public/landing.html')
    expect(html).toContain('href="/logshare/"')
  })
})

describe('追问可恢复', () => {
  it('SSE 有独立的 ask 帧', () => {
    const sse = readFileSync(join(BACKEND, 'src/server/sse.ts'), 'utf8')
    expect(sse).toContain("'ask'")
    expect(sse).toMatch(/ask\(questions: string\[\]/)
  })

  it('消息表持久化 meta，并由回放返回', () => {
    // 存储已迁到 MariaDB：SQLite 时代的 `004_messages_meta` 断言会把
    // 「换实现但语义没变」误判为回归。改为钉住迁移表定义与解析链路。
    const migrate = readFileSync(join(BACKEND, 'src/store/migrate.ts'), 'utf8')
    expect(migrate).toContain('002_messages')
    expect(migrate).toMatch(/meta\s+JSON\s+NULL/)

    const session = readFileSync(join(BACKEND, 'src/store/session.ts'), 'utf8')
    expect(session).toContain('parseJsonColumn<MessageMeta>(row.meta)')

    const server = readFileSync(join(BACKEND, 'src/server/index.ts'), 'utf8')
    expect(server).toContain('meta: m.meta')
  })

  it('前端渲染可作答的追问块，而不是纯文本', () => {
    const dock = read('src/components/chat/AskDock.vue')
    expect(dock).toContain("emit('answer'")
    expect(dock).toContain('提交并继续')

    // 追问不再内联在消息里，而是贴在输入框上方（AskDock）
    const page = read('src/pages/WorkspacePage.vue')
    expect(page).toContain('<AskDock')
    expect(page).toContain('pendingAsks')

    const thread = read('src/components/chat/ChatThread.vue')
    // 「已回答」由其后是否出现用户消息判定，不需要额外状态
    expect(thread).toContain('answeredAt')
  })

  it('回放时把 meta.asks 还原到消息', () => {
    const store = read('src/stores/chat.ts')
    expect(store).toContain('m.meta?.asks')
  })
})

describe('移动端适配（官网）', () => {
  const html = () => read('public/landing.html')

  it('移动端网格用 minmax(0, 1fr)，避免日志长行撑破视口', () => {
    // 实测：`1fr` 的最小值是 min-content，日志示例里的不换行长行会把
    // 整列撑到 540px+，在 390px 屏幕上横向溢出、标题右侧被裁。
    expect(html()).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('日志卡片允许收缩，长行在卡片内部滚动', () => {
    expect(html()).toMatch(/\.specimen\s*\{[^}]*min-width:\s*0/s)
    expect(html()).toMatch(/\.specimen__body\s*\{[^}]*overflow-x:\s*auto/s)
  })

  it('移动端有专门的断点，而不是只靠桌面样式', () => {
    const css = html()
    expect(css).toContain('@media (max-width: 900px)')
    // 移动端标题、留白、按钮尺寸都单独调过
    expect(css).toMatch(/h1\s*\{\s*font-size:\s*clamp\(27px/s)
  })

  it('正文行宽用 em 而非 ch（中文 1ch 只有半个汉字宽）', () => {
    expect(html()).toContain('max-width: 31em')
    expect(html()).not.toMatch(/max-width:\s*\d+ch/)
  })

  it('工作台预览是可交互 DOM，而不是图片', () => {
    const page = html()
    // 三个场景的正文必须都在 HTML 里：脚本只切类名，
    // 无 JS 时第一幕仍完整，也不靠 innerHTML 注入。
    expect(page).toContain('data-preview')
    expect(page).toContain('role="tablist"')
    expect(page.match(/data-scene="/g)?.length).toBe(3)
    expect(page).toContain('workspace__anchor')
    expect(page).toContain('workspace__step')
    expect(page).not.toMatch(/<img[^>]*(?:workspace|preview)/)
  })

  it('没有固定像素宽度会超过 390px 的容器', () => {
    const css = html()
    const fixed = [...css.matchAll(/(?:^|\s)(?:min-)?width:\s*(\d{3,})px/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 390)
    expect(fixed).toEqual([])
  })
})

describe('追加材料', () => {
  it('输入区加号：已有会话时追加，没有会话才新建', () => {
    const page = read('src/pages/WorkspacePage.vue')
    expect(page).toContain('api.append(chat.sessionId')
    expect(page).toContain('router.push(`/s/${result.logId}`)')

    const composer = read('src/components/chat/Composer.vue')
    expect(composer).toContain('sessionActive')
    expect(composer).toContain("'追加日志'")
  })

  it('案卷面板不再抢占追加入口，只显示追加段与过期提示', () => {
    const dossier = read('src/components/log/DossierPanel.vue')
    expect(dossier).not.toContain('aria-label="追加日志"')
    expect(dossier).toContain('log.meta?.appended')
    expect(dossier).toContain('log.meta?.note')
  })
})

describe('品牌标记', () => {
  it('顶栏与官网都不再使用方块 LR 标记', () => {
    expect(read('src/components/layout/AppTopBar.vue')).not.toContain('brand__mark')
    expect(read('public/landing.html')).not.toContain('brand__mark')
  })
})
