# LogRAG+ Web 前端

对话式日志排障界面。构建产物由 Node 服务托管在 `/logshare/` 子路径下，
入口形态是 `https://agent.logshare.cn/logshare/{日志ID}`（由 LogShare 跳转过来）。

## 设计门控声明（按 FDS.Skill 要求，开工前收齐六要素）

技能规定「六要素没齐不许开工，宁可多问一轮」。当时用户在赶进度，因此这里采取
技能许可的另一条路径：**用证据推定 + 技能默认值补齐，并在最前面声明**。
凡与预期不符，改动集中在 `src/styles/tokens.css`（令牌层）与 `src/styles/base.css`
（基础件），不需要动任何业务组件。

| # | 要素 | 取值 | 依据 |
|---|---|---|---|
| 1 | 目标用户 | **终端用户为主**（手机 Minecraft 玩家），管理员为辅 | 生产语料里上传来源集中在 FCL / ZL2 / Pojav / axolotl 等手机启动器；管理员只有运维本人 |
| 2 | 设备 | **移动优先**，同时适配桌面 | 与上同一份证据：用户从启动器内跳转，手机浏览器/WebView 是主场景 |
| 3 | 页面类型 | 拆两型：对话页 **WebApp**、管理页 **Admin** | 技能规定「类型模糊 ⇒ 拆两页分别过门控」，因此两页密度不同 |
| 4 | 浅深色 | **跟随系统 + 手动覆盖**（两套都实现） | 技能默认「跟随系统」；两套都做 ⇒ 不需要靠猜 |
| 5 | 密度 | 对话页 comfortable（触控目标 ≥40px）；管理页 compact（表格行 36px） | 技能规定 compact 仅用于表格/Console |
| 6 | 例外 | 无（不使用 Material You / Material Design / 莫奈低饱和渐变） | 用户全局约定亦禁止高饱和渐变 |

配色取自 FDS 的 `assets/tokens/tokens.json`：Zinc 中性 + 单一 indigo 强调色，
语义层（semantic）是唯一决策层，暗色只重映射语义层。

## 开发与构建

```bash
cd web
npm install          # 注意用 npm：本机 pnpm 在 Termux 上报 lock_shared() not supported
npm run dev          # http://127.0.0.1:5173/logshare/ ，已把 /v1 与 /health 代理到 8788
npm run typecheck    # vue-tsc --noEmit
npm run build        # 产物到 web/dist，由 Node 服务在 /logshare/ 下托管
```

后端默认端口 8788（见根目录 `.env`）。前端默认**同源**请求，因此生产不需要 CORS；
需要跨源调试时在「设置 → 接口地址」里填后端地址（存 localStorage，可随时清空）。

### 路径只在两处，且必须一致

| 位置 | 值 | 写错的后果 |
|---|---|---|
| `vite.config.ts` 的 `base` | `/logshare/` | 资源 404（页面白屏） |
| `src/router.ts` 的 `createWebHistory` base | `/logshare/` | 首屏正常、刷新后 404 |

## 目录

```
src/
├── api/          client.ts（SSE 增量解析）、admin.ts（管理接口 + 错误语义）、types.ts
├── components/   Icon / MarkdownView / TimelinePanel / MessageItem / EvidenceSpine
│                 LogPane（日志面板）/ EntryPlate（未绑定日志时的入口）
│                 Composer / ProviderSheet
├── lib/          structured.ts（结论块拆分 + Markdown 解析）、format.ts
│                 logdoc.ts（日志分节 / 严重度粗筛 / 行窗口）
├── pages/        ChatPage.vue（主入口）、AdminPage.vue（领域知识 + 分析记录）
├── stores/       chat.ts（对话状态机）、settings.ts（主题/供应商/令牌）
└── styles/       tokens.css（三层令牌）、base.css（基础件，只引用令牌）
```

## 三个刻意的实现决定

**一、全程不用 `v-html`。** 模型输出里必然混着用户日志原文（`<`、`&`、
用户自己贴的 HTML 都是常态）。`MarkdownView` 把文本解析成结构化节点后交给
Vue 模板渲染，Vue 默认转义——XSS 从机制上不成立，而不是靠过滤器拦截。

**二、`/logshare/{日志ID}` 是「SPA 深链」，不是文件路径。** 服务端
（`src/server/static.ts`）只有 `assets/` 目录会真正读盘，且文件名必须匹配
`^[A-Za-z0-9._-]+$`；其余任何路径一律返回 `index.html`。这样「构造一个
奇怪路径去读文件」在语义上不可能发生，而不是「试图拦住它」。

**三、空正文不渲染成功卡片。** 后端在撞轮次上限、上游截断、模型没吐字三种
情况下都会先补一次收尾轮，仍为空就如实报失败。前端跟着如实呈现：这类消息带
「无结论」徽章并给出下一步建议。线上真实事故就是「0 字答案 + 288 个事件 +
报 completed」，界面上不能重演它。

## 与后端接口的对应

| 前端动作 | 接口 |
|---|---|
| 发一轮对话（SSE） | `POST /v1/chat` |
| 回放会话 | `GET /v1/session/{id}` |
| 上传日志（脱敏 + 去重 + 异步反混淆） | `POST /v1/upload` |
| 日志面板取正文与附件（只读、不计配额） | `GET /v1/log/{id}` |
| 上传时展示的配额余量 | 响应中的 `remaining` |
| 管理页领域知识 CRUD / 性质判定 / 注入预览 / 留痕 | `/v1/admin/domain-knowledge*` |
| 管理页分析记录看板 | `/v1/admin/records*` |

管理接口的鉴权语义必须区分三种失败，见 `src/api/admin.ts` 顶部说明：
未开启 → 404、未配令牌 → 仍 404、令牌不匹配 → 401。把 404 说成「令牌错误」
会让运维去反复换令牌，而不是去开配置项。

## 待办

- 图标目前是**描边（stroke）**风格（与 FDS 的「描边图标」一致），而项目全局
  约定写的是「图标优先采用非线性图标」。两者冲突，已把整份图标数据收敛在
  `src/icons.ts`，需要改成实心风格时只动这一个文件。
- 自定义供应商的连通性探测（现在只在服务端 `Config::test-ai` 那侧有）。
