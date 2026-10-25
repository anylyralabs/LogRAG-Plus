# LogRAG+ WebUI

案卷式 Agent 工作台：左侧会话、中间报告、右侧原始日志与证据。
Vue 3 + Vite + TypeScript，构建产物由后端托管在 `/logshare/` 子路径。

## 快速开始

```bash
cd web
npm install          # 用 npm：Termux 下 pnpm 报 lock_shared() not supported
npm run dev          # http://127.0.0.1:5173/logshare/，/v1 与 /health 已代理到 8788
npm run build        # → web/dist
npm run typecheck    # vue-tsc
npm run test         # vitest
```

后端默认从 `<项目根>/web/dist` 读产物，因此 `npm run build` 后启动服务即可访问
`http://127.0.0.1:8788/logshare/`。也可用 `WEB_DIR` 指向别处。

## 设计取向

这不是一个通用聊天框，而是**一份可以翻阅的现场记录**。大厂 Agent 产品的结构
被借用了，皮肤没有：

| 参考 | 借用的结构 | 在本产品里的落点 |
|---|---|---|
| ChatGPT | 左侧会话栏、居中阅读列、底部输入、回到最新 | 会话历史、报告线程、输入区、`ChatThread` 的滚动锚定 |
| Claude | 思维链折叠、右侧文档面板、停止生成 | 调查过程折叠、日志案卷、`AbortController` |
| Gemini Deep Research | 可见的研究进度与来源列表 | 工具调用时间线、证据列表 |
| Perplexity | 结论与引用分离、引用可回跳 | 结论脊柱、证据定位到日志行 |
| Cursor / Devin | Agent 执行时间线、每步状态 | `tool` / `tool_result` / `limit` / `reflection` 帧可视化 |

**刻意不做**：气泡堆叠、渐变、玻璃拟态、Emoji、满屏圆角卡片。

### 视觉语言

- 浅色「纸」`#f6f4ef` + 深色「石墨」`#121211`，强调色是深松绿而非品牌蓝紫
- 圆角最大 2px；层级靠 1px 发丝线与字级差，不靠阴影
- 中文正文行高 1.65（`--lh-body`，早先 1.8 段内行距过松）；ID、行号、工具名、计数一律等宽 + tabular numerals
- 不下载网络字体（离线构建 + 中文首屏）
- 图标用 `lucide-vue-next`

### 字阶

| 令牌 | 用途 |
|---|---|
| `--fs-micro` 11px | 行号、栏目标记、极小标注 |
| `--fs-meta` 12px | 辅助说明、按钮、元信息 |
| `--fs-body` 14px | 正文 |
| `--fs-lead` 16px | 判定、强调句 |
| `--fs-title` 20px | 页面标题 |
| `--fs-display` 28px | 入口页标题 |

## 信息架构

```
/                             官网首页（静态 landing.html，与应用程序分离）
/logshare/                    应用首页 = 聊天界面，打开即可提问
/logshare/new                 同上（保留旧链接）
/logshare/:logId              日志工作台（七位 ID，正则约束）
/logshare/s/:sessionId        会话回放；native 上传的正文归属会话自身
/logshare/admin               管理台（懒加载，单独分包）
```

**首页就是聊天**：日志是可选附件，不是入场券。把「输入编号 / 上传 / 粘贴」
摆在首屏，等于先让人填一张表才能开始问问题；这类入口已收进输入区的回形针
与提示行。

**输入区的加号是「补材料」**：已有会话时走 `POST /v1/session/{id}/append`，
不新建、不跳转；没有会话时才上传并新建。上传响应里的 `logId` 是**会话 ID**
（`s` 开头），必须跳 `/logshare/s/{id}`——按七位日志路由跳会直接 404。

**官网在根路径**，由 `src/server/static.ts` 直接托管 `web/public/landing.html`，
不经 Vue。第一次来的人先看「这是什么」；把产品说明塞进应用首屏，两边都做不好。
`landing.html` 缺失时回退为重定向到 `/logshare/`（正常降级，不报错）。

桌面端三栏；窄屏（<960px）会话栏与案卷都变成 Sheet，主列保持可读宽度。

## 关键实现约定

### 1. 全程不用 `v-html`

模型输出里必然混着日志原文（`<`、`&`、用户自己贴的 HTML）。Markdown 走
`marked.lexer()` → 自有块结构 → Vue 模板（默认转义）。`tests/security.test.ts`
静态扫描 `v-html` / `innerHTML` / `eval` / `marked.parse`。

链接协议白名单只放行 `http/https/mailto`；图片一律降级为文本，不加载远程资源
（避免泄漏阅读者 IP）。

### 2. SSE 解析器是纯函数

`lib/sse.ts` 对应用户最容易踩的五个坑：跨块残余、流式解码、多行 `data:`、
不能用 `EventSource`、先检查 `content-type`。`tests/sse.test.ts` 用构造字节流
覆盖了「一帧切成 3 字节」这种极端分包。

### 3. 调查过程在答案之前，且流式时固定高度

顺序按真实发生的时间：**调查 → 提问 → 结论 → 自检**。之前把调查过程放在结论之后，
读起来像附录——用户要先读完答案才看到依据，叙事是反的。

流式时自动展开，但给一个 **240px 的滚动窗口**（窄屏 200px）：思维链能到上万字，
自然撑开会让整页不断跳动、结论被挤出视口。结束后自动收起成一行摘要；
用户手动点开过则不再自动收起。

### 3b. 追问（`ask_user`）必须可恢复

模型信息不足时会提问。问题同时走三条路：

1. 流内 `status` 帧 `type=ask` —— 当轮立刻渲染输入块；
2. `done.asks` —— 兜底，防止状态帧被代理合并；
3. 消息 `meta.asks` 落库 —— 刷新、换设备回放后仍能作答。

「是否已回答」不设额外字段：**其后是否出现过用户消息**就是判据，
对话历史本身是唯一事实来源。前端 `AskBlock.vue` 把每个问题渲染成一个输入位，
提交时按「问题：答案」拼成普通用户消息发回——不发明新协议。

### 3c. 空正文不是成功

后端对空正文有硬性约定，前端严格跟随：有 `done` 但正文为空 → `status: 'empty'`，
显示「无结论」与下一步建议，不渲染成功卡。`error` / `aborted` 保留已生成正文。

### 4. API Key 只存浏览器

沿用决策 D44：自定义供应商的 Key 默认写 localStorage，随请求逐次带上，
不落服务端。设置里可改「仅本次会话」（sessionStorage）。
管理令牌相反，默认只存 sessionStorage。

### 5. 日志正文不落盘

粘贴的日志只在内存里（`chat.pendingLog`），刷新即丢，界面明确提示。
这避免多出一条未经 LogShare 脱敏的原始日志数据路径。

### 6. 日志面板不折行 + 虚拟滚动

固定 20px 行高：虚拟滚动依赖它，且「一屏多少行」是读日志的直觉。
5 万行的分节、严重度、错误行索引在 Web Worker 里算，主线程只渲染窗口。

### 7. 筛选后的 `total` 与列表同集合

管理台分页依赖这一条。后端曾返回全表条数，导致筛选后出现大量空页；
`tests/eval-records.test.ts` 有回归。

### 8. 会话自动复用限定在同一匿名主体内

日志 ID 在 URL 里，是公开的。服务端按 `(owner, logId)` 复用会话，
而不是只按 `logId`——否则两个陌生访客会进入同一会话，看到彼此的追问内容。
显式 `sessionId` 仍可跨设备回放（无登录产品的 bearer 取舍）。

## 目录

```
web/
├── index.html              应用入口（/logshare/）
├── public/landing.html     官网首页（/，静态托管，不经 Vue）
├── vite.config.ts          base='/logshare/'，/v1 代理，vitest 配置
├── tsconfig.json
├── src/
│   ├── main.ts / App.vue / router/
│   ├── pages/              Workspace / Admin / NotFound（首页即 Workspace）
│   ├── components/
│   │   ├── layout/         AppTopBar / AppSidebar
│   │   ├── entry/          LogStart / ChatStart
│   │   ├── chat/           ChatThread / MessageItem / Composer / AskBlock
│   │   ├── report/         ConclusionSpine / MarkdownView / ScorePanel / StepsPanel / ThinkingPanel
│   │   ├── log/            DossierPanel / LogViewer / LogLine
│   │   ├── settings/       SettingsPanel
│   │   └── admin/          AdminGate / KnowledgeList / KnowledgeEditor /
│   │                       InjectionPreview / AuditList / RecordsBoard / RecordDetail
│   ├── stores/             chat / log / settings / health / history / admin
│   ├── lib/                api / sse / types / logdoc / structured /
│   │                       markdown / upload / history / logparse
│   ├── workers/            log.worker.ts
│   └── styles/             tokens.css / base.css
└── tests/                  sse / markdown / parsing / upload / components /
                            contrast / security / paths
```

## 测试

```bash
npm run test        # 194 项
npm run typecheck
npm run build
npm run smoke       # 构建后逐条深链冒烟（真实产物 + jsdom）
```

`npm run smoke` 会为每个路由起一个子进程、按「直接打开该地址」的方式挂载构建产物。
它抓的是 `vite build` 与组件测试都覆盖不到的一类问题：chunk 名错、懒加载失败、
首次挂载解析 URL 出错——也就是线上最常见的白屏。

| 文件 | 守的是什么 |
|---|---|
| `sse.test.ts` | 跨块残余、UTF-8 切分、多行 data、心跳、末尾无空行、非流式错误 |
| `markdown.test.ts` | XSS：HTML 当文本、危险协议、图片不加载；结构解析 |
| `parsing.test.ts` | 结论拆分、置信度归一化、分节/严重度/错误导航、证据锚点定位 |
| `upload.test.ts` | 服务端同款限额、ZIP 解压、重名改名、空文件、来源格式 |
| `components.test.ts` | 结论、自检、调查步骤、思维链、输入区的真实交互路径与渲染顺序 |
| `contrast.test.ts` | 两套主题 11 组前景/背景 ≥ WCAG AA（读 tokens.css，不抄色值） |
| `security.test.ts` | 禁止 `v-html` / `innerHTML` / `eval` / `marked.parse` |
| `paths.test.ts` | Vite base 与路由 base 一致、产物目录与后端默认值一致、不引网络字体 |
| `home-shape.test.ts` | 首页就是聊天、官网独立、追问可恢复、移动端不溢出、品牌标记已移除 |
| `ask-block.test.ts` | 追问面板：自动弹出、部分作答、稍后再答、已回答不弹 |
| `ask-state.test.ts` | 追问后不自检：状态不转圈、不算无结论、回放仍可作答 |
| `scripts/smoke-routes.mjs` | 构建后逐条深链打开，断言渲染成功且无运行时异常 |

## 构建与部署

```bash
# 前端
cd web && npm ci && npm run build

# 后端（会托管 web/dist）
cd .. && npm run build && npm start
```

Docker 构建已在 `docker/Dockerfile` 里包含前端阶段（`COPY web/` → `npm run build`），
无需额外步骤。容器内 `WEB_DIR=/app/web/dist`。

## 已知边界

- 后端没有「列出我的会话」接口，历史只存本机 localStorage（最多 50 条，过期自动过滤）。
  无登录产品下，服务端也无法安全地把会话归属到某个人。
- 日志面板单份最多显示 2MB、总量 6MB（服务端约束），超出会明确标注
  `truncated` / `omitted`，不会静默少几行。
- 管理接口的「未开启」与「已开启但未配 Token」都返回 404，前端无法区分——
  只能提示同时检查 `ADMIN_ENABLED` 与 `ADMIN_TOKEN`，不假装知道是哪一个。
