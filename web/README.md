# LogRAG+ 前端（Nuxt 4 + Nuxt UI v4）

对话式日志排障界面。构建产物由 Node 服务托管在 `/logshare/` 子路径下，
入口形态是 `https://agent.logshare.cn/logshare/{日志ID}`（由 LogShare 跳转过来）。

## 设计方向：勘验卷宗

这不是一个聊天窗口，而是一份**可以翻阅的现场记录**。排版据此决定，配色不据此决定。

**配色全部沿用 Nuxt UI 默认**（primary=green / neutral=slate / error=red / warning=yellow），
不做任何覆盖。唯一的例外是圆角收到 `0.125rem`——纸不是胶囊。

**排版原则**（这是重做时真正变化的部分）：

| 手段 | 用它做什么 | 刻意不用什么 |
|---|---|---|
| 发丝线 `border-b` | 分隔栏与栏 | 卡片包裹、圆角、阴影 |
| 字阶 5 档 | 表达层级（10/11/13/15/21px） | 10 档半像素字号（改前实测） |
| `.dossier-label` | 栏目标记（中文 + 一条线） | 全大写 eyebrow、中间点拼的 meta |
| 等宽 | 编号、行号、日志、计数 | 把它当装饰性小字 |
| 左对齐 | 全部正文 | 居中摆段落 |

**三个结构决定**：

1. **结论在前，正文在后，取证过程收起。** 玩家先要知道「是什么、该怎么做」，
   依据是支撑不是主角。结论用「判定 → 处置 → 依据」的竖线结构，
   不用卡片——卡片表达不出三者的主次。
2. **编号只用在真是序列的地方。** 「处置」的步骤是序列，所以有 `01 02 03`；
   其余地方不编号（编号当装饰是通用模板最常见的痕迹）。
3. **材料与报告分栏。** 宽屏左边是原始日志（材料），右边是报告；窄屏日志进抽屉——
   2600 行日志不该挤掉输入框。

**行长**用 `em` 而不是 `ch`：`1ch` ≈ 半个汉字宽，用 `ch` 会让中文行宽翻倍。
正文 `max-w-[34em]`（约 34 个汉字），标题 `19em`。

## 可访问性（有数值守门）

`tests/contrast.test.ts` 用 Nuxt UI 默认色板的语义取值算 WCAG 对比度，
覆盖深色与浅色两套主题的 7 组「前景/背景」组合，纯计算、无依赖。

实测发现并修掉的两处：

| 问题 | 实测 | 处置 |
|---|---|---|
| 浅色下行号用 `text-dimmed` | 2.34:1 | 改用 `toned`（7.58:1） |
| 浅色主按钮默认 green-600 白字 | 3.30:1 | 组件层压到 green-700（5.02:1） |

另外：`:focus-visible` 全局定义；日志行可 `Tab` 聚焦、`Enter`/`Space` 选取；
`prefers-reduced-motion` 下关掉过渡。

## 开发与构建

```bash
cd web
npm install          # 用 npm：本机 pnpm 在 Termux 上报 lock_shared() not supported
npm run dev          # http://127.0.0.1:5173/logshare/ ，/v1 与 /health 已代理到 8788
npm run build        #  → .output/public（后端默认从这个目录读）
npm run typecheck    # vue-tsc
```

**构建产物路径是 `web/.output/public`**，不是 Vite 时代的 `web/dist`。
后端 `src/server/static.ts` 的默认值与之对应；`_nuxt/` 与旧的 `assets/` 都按
「单段文件名 + 白名单字符集」放行，路径遍历在结构上不可能。

## 目录

```
app/
├── app.vue               卷宗头（身份 + 当前日志编号 + 两个图标开关）
├── app.config.ts         只设圆角；配色不覆盖
├── assets/css/main.css   字阶、结构件（dossier-label / rule / evidence / line-no）
├── components/
│   ├── ChatView.vue      阅读区（材料栏 + 报告栏 + 命令行）
│   ├── EntryPanel.vue    投放台（三条途径，发丝线表格）
│   ├── LogPanel.vue      日志面板（分节跳转、错误行导航、选行引用）
│   ├── MessageItem.vue   一条记录（结论 → 正文 → 取证过程）
│   ├── ConclusionSpine.vue  判定 → 处置 → 依据
│   ├── MarkdownView.vue  无 v-html 的 Markdown 渲染
│   ├── Composer.vue      命令行（左侧 › 提示符）
│   ├── ProviderSheet.vue 供应商设置
│   └── AdminView.vue     管理页（同一套排版语言，无卡片）
├── composables/useChat.ts  对话状态机（SSE 帧 → 界面数据）
└── lib/                  api.ts（SSE 解析）、logdoc.ts（分节/严重度）、
                          structured.ts（结论 JSON 拆分）、types.ts
```

## 三个刻意的实现决定

**一、全程不用 `v-html`。** 模型输出里必然混着用户日志原文（`<`、`&`、
用户自己贴的 HTML 都是常态）。`MarkdownView` 把文本解析成结构化节点后交给
Vue 模板渲染，Vue 默认转义——XSS 从机制上不成立，而不是靠过滤器拦截。

**二、`/logshare/{日志ID}` 是 SPA 深链，不是文件路径。** 服务端只有资源目录会读盘，
且文件名必须匹配 `^[A-Za-z0-9._-]+$`；其余任何路径一律返回入口页。

**三、自定义供应商的 API Key 只存 localStorage**，随请求逐次带上，不落服务端。

## 待办

- 自定义供应商的连通性探测（服务端已有 `/config/test-ai`，前端未接）。
