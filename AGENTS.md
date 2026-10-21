# LogRAG+ 项目上下文

> 本文件记录项目架构、关键决策与踩坑经验。修改内容与本文档不符时，同步更新。

> **⚠️ 上下文被压缩后，先读 [`MISSION.md`](./MISSION.md)**——那是当前工作任务的指挥文件与进度看板。

## 项目定位

**LogRAG+ 是独立的 AI 日志排障产品**，不限于 Minecraft，不限于 LogShare 用户。

与 LogShare 的关系是「高度联动但可独立运行」：

| 维度 | LogShare | LogRAG+ |
|---|---|---|
| 职责 | 日志**托管**（上传/存储/分享） | 日志**分析**（AI 排障） |
| 技术栈 | PHP 8.5 + Hyperf + Swoole | Node.js + TypeScript + DeepAgents |
| 数据 | 日志正文、元数据、Admin 控制台 | 会话、消息、分析记录 |

**过渡期说明**：LogShare 自带的 RAG 与 Agent 后续会**彻底废弃**，由本服务接管。
因此知识库与索引构建管线归本服务所有（不放在 LogShare）。

## 两个入口

```
主入口：agent.logshare.cn
  ├─ 直接提问              → 纯对话（可用 RAG / GitHub / web 工具）
  ├─ 粘贴日志正文          → 立即分析，不依赖 LogShare
  └─ 上传日志文件          → 走 LogShare 处理（脱敏 + 反混淆）后分析

联动入口：logshare.cn/{id}
  → 点击「LogRAG+ 深度分析」→ agent.logshare.cn/logshare/{id}
```

**会话保留期**：独立发起 48 小时；携带 LogShare ID 的跟随日志 TTL（当前 7 天）。

## 数据边界（核心原则）

| 数据 | 归属 | 本服务权限 |
|---|---|---|
| 日志正文 / 附件 / 元数据 | MariaDB | **只读**（专用只读账号 `lograg_ro`） |
| 会话 / 消息 / 上传副本 | 自有 SQLite | 读写 |
| 自定义供应商配置 | 自有 SQLite | 读写（key 加密存储） |
| RAG 索引 | 自有 SQLite | 读写（本服务构建） |
| 缓存 / 配额 | Redis `agent:*` | 读写（前缀隔离） |

**为什么 Node 不写 MariaDB**：LogShare 的写入路径含五个不可绕过的机制——12 个 Filter
脱敏链、SpinYarn 反混淆（PHP C 扩展）、xxh128 去重指纹、EventQueue 安全审核、分区回收。
Node 复现成本高且会绕过安全边界。**所有写入走 PHP，Node 只读。**

## 目录结构

```
src/
├── config.ts              环境变量配置（无配置文件依赖；需动态的字段写成 getter）
├── logshare/id.ts         LogShare 日志 ID 编解码（与 PHP 逐位对齐）
│   └── client.ts          LogShare 客户端（读日志、内部 API 写入）
├── security/
│   ├── clientIp.ts        客户端真实 IP 解析（严格信任代理校验）
│   ├── ssrf.ts            自定义供应商 URL 校验（防 SSRF + DNS Rebinding）
│   └── adminAuth.ts       管理接口鉴权（timing-safe；fail-closed 三态）
├── github/
│   ├── registry.ts        仓库注册表（已修正 LogShare 的 4/6 失效问题）
│   └── client.ts          GitHub 客户端（repo 可选 + 全局检索）
├── rag/
│   ├── loader.ts          知识库文件加载
│   ├── chunker.ts         分块（按 ## 二级标题）
│   ├── build.ts           索引构建（原子替换）
│   ├── build-cli.ts       构建 CLI（默认 ./knowledge → ./data/rag/index.db）
│   └── search.ts          检索（FTS5 BM25 + LIKE 兜底 + 同源配额）
├── knowledge/
│   └── domain.ts          已知领域知识（注入 + 工具双通道、审计、CRUD）
├── eval/
│   ├── anchors.ts         证据锚点提取与落地核对
│   ├── scorer.ts          四维自评（grounding/verification/actionability/economy）
│   └── records.ts         分析记录持久化与看板聚合（结构化表，非单文件归档）
├── text/
│   ├── anchor.ts          窗口锚点定位（结构性标记优先）
│   ├── window.ts          窗口提取（多窗口）
│   └── obfuscation.ts     混淆特征检测（反混淆就绪判定）
├── store/                 SQLite（会话、消息、迁移登记、分析记录）
│   ├── server/
│   │   ├── index.ts         HTTP 服务（路由、配额、SSE 编排）
│   │   └── static.ts        前端产物托管（/logshare/*，结构性防路径遍历）
│   └── agent/
│       ├── model.ts         模型构造（自定义供应商适配）
│       ├── runner.ts        多轮工具循环（评分在末尾挂上，不影响分析）
│       ├── prompt.ts        系统提示词拼接（精确工具清单 + 领域知识注入）
│       ├── structured.ts    结尾结构化 JSON 解析
│       └── tools/           工具集（log / rag / github / knowledge）

前端 `web/`              Vue 3 + Vite 案卷式 Agent 工作台（详见 web/README.md）
├── public/landing.html   官网首页（/ 静态托管，不经 Vue）
├── src/pages/             Workspace / Admin / NotFound（应用首页即 Workspace）
├── src/components/        layout / entry / chat / report / log / settings / admin
├── src/lib/               api / sse / markdown / logdoc / structured / upload
├── src/stores/            chat / log / settings / health / history / admin
└── tests/                 SSE / Markdown XSS / 日志解析 / 上传 / 组件 / 对比度 / 路径

knowledge/                 RAG 知识库（领域知识，回答「这是什么、怎么修」）
├── patterns/              单签名 → 单故障的判据卡
└── cases/                 多签名共现 → 现场判断的实战串讲（必须写「与相邻故障怎么区分」）
prompts/                   提示词资产（方法论，回答「怎么搜、怎么判断」）
docker/Dockerfile          服务镜像（四阶段：前端 / 编译 / 生产依赖 / 运行时）
docker/compose.yaml        单服务编排（反代不在内，交由既有 nginx 一层）
.dockerignore              关键一条：排除 `.env`（令牌绝不进镜像层）
tsconfig.build.json        编译配置（rootDir=src，产物入口 dist/server.js）
data/corpus/               线上语料（只读挖掘用，data/ 已 gitignore）
.env.example               环境变量样例（与 config.ts 双向守门）
```

## 关键设计决策

### 0. 知识库的维度：面向 Minecraft，而非启动器

**这是最容易犯的错误，务必先读。**

知识库有三个维度，按权重排序：

| 维度 | 权重 | 内容 |
|---|---|---|
| **① 游戏本体** | **主体** | 客户端/服务端、世界/存档、渲染管线、数据包、资源包、性能、网络 |
| **② 加载器** | **主体** | Fabric / Forge / NeoForge / Quilt 的加载流程、依赖解析、Mixin 体系、类加载时机、版本兼容矩阵 |
| **③ 启动器特有** | **附属（但必须记录）** | 日志格式包装、Java 运行时注入、LWJGL 装配、渲染器选择 |

**核心认知**：启动器只是**传输层**——它决定「Java 怎么注入、LWJGL 怎么装配、日志怎么包装」，
但**不改变 MC 问题本身**。「模组缺前置」在 FCL / axolotl / ZL2 上完全一样。

**反面案例（本项目实际犯过）**：
- 早期把 `axolotl` 启动器当成一个知识分类来补 → 过拟合
- `pc-launcher-issues.md` 有 47 处启动器提及 vs 7 处游戏概念 → 组织维度错了

**正确做法**：

```
错误：O(启动器数 × 问题数)   ← 无限增长，且同一问题重复写
正确：O(MC 问题空间) + O(启动器日志格式)   ← 有界
```

**生产数据佐证**：`DXfMZ59`（ZL2 + GL4ES）与 `6dVOYpi`（FCL + Krypton）是
**同一个 MC 26.3 的 SDL3 问题**，只是启动器表现不同。若按启动器分写，就是两份重复内容。

**写作纪律**：
- 涉及启动器差异时，写成「MC 问题 + 各启动器的表现差异」，而非「FCL 的某问题」
- 不设「### FCL」「### axolotl」这类按启动器分的小节
- 但**启动器特有的东西必须记录**（如 ZL2 的 `launcher_crash.log`、FCL 的 `Before Start` 分节），
  它们是「日志怎么读」与「环境怎么注入」的知识，属维度 ③

**目录分工（`patterns/` 与 `cases/` 不能混为一谈）**：

| 目录 | 形态 | 回答的问题 | 什么时候该新写一篇 |
|---|---|---|---|
| `patterns/` | 单签名 → 单故障的判据卡 | 「看到这个报错，是不是它？」 | 出现一个可独立判定、能写清置信度线索的故障 |
| `cases/` | 多签名共现 → 现场判断的实战串讲 | 「这几行同时出现，先怀疑谁？」 | 单看某个签名会误判，需要相邻故障的区分判据 |

`cases/` 的价值全在**区分**上：只有签名罗列，它就退化成 `patterns/` 的重复内容
（检索时还会互相挤占结果位）。因此每篇 `cases/` 都必须写明「怎么与相邻故障区分」。

**抽样数据的纪律（第二轮踩过的坑）**：`GET /v1/admin/logs` 是
`ORDER BY created DESC` 且 `created` 为**秒级精度**，同秒记录多 ⇒ `LIMIT/OFFSET`
分页漂移，同一查询两次返回的 700 个 logId 只有约 1/4 重合。
因此知识条目里的频次**不能写绝对值**，只能写量级，或给出可逐日志复算的例证
（「`H7Oey7r` 内 57 次」）。这条与「出现频率高 ≠ 有价值」是同一类问题的两面：
**分母不牢，分子就没有意义。**

### 1. 知识库与方法论必须分离

| 内容 | 归属 | 判据 |
|---|---|---|
| 签名 / 含义 / 常见触发 / 修复步骤 / 置信度线索 | `knowledge/` | 「这是什么故障、怎么修」——随生态变化 |
| 日志分层判定 / 检索词提取 / 工具选择 / 输出规格 | `prompts/` | 「怎么搜、怎么判断」——跨故障通用 |

**为什么**：方法论混入知识库会被当作事实检索出来，模型可能把「排查流程」当成
「答案」输出；且方法论的高频通用词会稀释 BM25 信号。

**守门**：`tests/knowledge-boundary.test.ts` 强制此边界，禁止方法论小节名出现在
`knowledge/`，且小节名必须在白名单内。

### 2. 知识条目结构固定

```markdown
# 标题

## 签名 (Signature)     日志原文匹配模式
## 含义                这个故障的本质
## 常见触发            什么情况会导致（可用 ### 触发 A/B/C）
## 修复步骤            怎么修（分触发写）
## 置信度线索          什么证据能确认是它
```

必须用 `##` 二级标题——这是检索的分块单元。无 `##` 结构的文件只会切出 1 个 chunk，
检索时极易被多 chunk 文件挤出（实测中 LogShare 的 `日志分析/` 目录 17 个文件
各只有 1 chunk）。

### 3. 窗口锚点：结构性标记绝对优先

**实测依据**：27 份真实日志中，原实现（首次匹配 Tier1/Tier2）有 **14/17 份错过真崩溃**，
最大偏差 4734 行。成因是 Tier1 正则会命中**启动期正常告警**：

| 日志 | 误命中内容 | 真崩溃位置 |
|---|---|---|
| KBj3hBs | `[Lightload] ... java.io.IOException: Cannot run program` | SIGSEGV @5290 |
| irzZ67E | `FML appears to be missing any signature data` | Crash Report @1723 |

**修复**：`crash-report` / `hs_err` / `<启动器> Crash Report` / `Minecraft has crashed!` /
`Failed to load a library` 等**确定性标记**绝对优先。

**验证结果**：错过率从 86% 降至 **0%**（覆盖 19/19）。

### 4. GitHub 仓库白名单已修正

LogShare 的 6 个白名单仓库中 **4 个不可用**（API 逐个核验）：

| 原仓库 | 问题 | 修正为 |
|---|---|---|
| `Amethyst-Launcher/Amethyst` | 404 | `AngelAuraMC/Amethyst-Android` |
| `Glow-Worm-Project/PojavLauncher-Glow-Worm` | 404 | `Vera-Firefly/Pojav-Glow-Worm` |
| `sparrow-app/MobileGlues` | 404（服务端实录 422） | `MobileGL-Dev/MobileGlues-release` |
| `PojavLauncherTeam/PojavLauncher` | 已归档 | `MojoLauncher/MojoLauncher` |
| （缺失） | — | `ZalithLauncher/ZalithLauncher2`（实测 13/27 份日志来源） |

同时 **`repo` 参数改为可选**：省略时走 GitHub 全站检索。实测证明全站检索有效——
一次搜索同时命中 5 个启动器的同类解法。

### 5. 检索同源配额独立生效

**实测依据**：原实现同源重叠率 38%，`rag_search("Mixin")` 返回 5 条全部来自同一文件。
成因是 `SOURCE_QUOTA` 只在 rerank 开启时生效。

**修复**：同源配额独立生效，且 `k` 语义改为「k 个来源」（不足时用同源 chunk 补足）。

### 6. 评分：按文本核对「证据落地性」，不按工具调用次数

**这是本会话最重要的修正，改动前务必读完整段。**

LogShare 原评分器的 `evidenceSufficiency` 是**工具调用次数的阶跃函数**
（0→20、1→60、2→80、≥3→95）。实测铁证：

| 样本 | 条数 | overall |
|---|---|---|
| 0 次工具调用 + 结论完整 | 253 | **全部恰好 68** |
| 1–3 次工具调用 + 结论完整 | 1478 | 均值 93.3 |

也就是说 `overall` 的差异几乎完全由「调了几次工具」决定，与答案质量无关。
一个用完整日志上下文一眼看出的正确结论，会被系统性打低分；
而对着日志乱调几次工具反而得高分。

**若这个缺陷没被修掉，本次会话所有「低分样本」的分析结论都是错的**——
低分不等于差，它有 254 条属于 `correct_underrated`。

**新口径**（`src/eval/scorer.ts`）：

| 维度 | 权重 | 依据 |
|---|---|---|
| `grounding` | 0.40 | 从 `rootCause`/`evidence` 提取锚点，逐条回日志正文与工具结果中查找 |
| `verification` | 0.20 | 是否给出了核实动作与未核实项的标注 |
| `actionability` | 0.25 | 用户能否照做（UI 路径而非私有目录、术语是否解释） |
| `economy` | 0.15 | 空结果调用与重复调用（**不是**调用次数本身） |

三条不可动摇的规则：

1. **零工具调用不扣分**（中性满分）。简单问题不该被迫调工具。
2. **无可用语料时 `grounding` 返回 `null` 并从加权中剔除**，而不是记 0——
   「未采集」与「计数为零」必须可区分。
3. **同一调用同时命中「失败」与「空结果」时只计失败**，否则
   「检索方向错」与「工具不可用」两类问题的比例会失真。

### 7. 分析记录：结构化表，不是单文件归档

LogShare 的分析记录是「Redis ZSET + 602MB 单文件归档」。任何统计都得把整文件读一遍，
因此「低分样本长什么样」这种问题在实践中**没人问得起**——上面那个评分缺陷
就这样长期无人发现。

`src/eval/records.ts` 把评分结果落进 SQLite 结构化表，于是下列查询变成一次索引扫描：
哪个维度没有区分度、哪种扣分理由最常见、同一份日志多次分析的结果差异。

**两条硬性约束**（都有回归守门）：

- `listAnalysisRecords()` 的 `limit` 被夹到 `records.maxPageSize`（HTTP 层**不得**放宽）；
- 内部聚合（`analysisStats()`）必须显式放宽到 `records.maxAggregateRows`。
  否则均值会**静默**退化为「最近 N 条的均值」——
  生产看板 `totalAnalyses` 曾长期恒等于 100 且没有任何报错。

### 8. 管理接口 fail-closed 且统一前缀门禁

领域知识会**原文注入全局系统提示词**。一旦可匿名写入，等于任何人都能改写所有用户的结论。

三态设计（缺任一条都会留下敞口）：

| 状态 | 响应 |
|---|---|
| `ADMIN_ENABLED` 未开 | **404**（与普通未知路由同形，不暴露管理面存在） |
| 已开但 `ADMIN_TOKEN` 为空 | **仍 404** |
| 已开且有 Token | 校验 `x-admin-token`，不匹配 **401**（timing-safe 比较） |

全部管理接口挂在 `/v1/admin/` 前缀下，**门禁在入口处统一做一次**——
逐条路由各加一道检查是漏洞的常见来源（新增子路由时忘加），
集中在前缀上检查则不存在「忘记」的可能。

### 9. 环境变量必须双向守门

环境变量**拼错不会有任何报错**——只是永远取到默认值。因此：
`.env.example` 与 `src/config.ts` 双向比对（`tests/env-example.test.ts`），
配置里读取的变量必须都在样例中出现，样例里出现的变量必须都被配置读取。

同一类缺陷的另一例：`RAG_INDEX_PATH` 原默认空串、构建命令输出到
`./data/rag/index.db` → 构建报告「完成」、检索返回「不可用」，**两边各自都正常**。
默认值已改为与构建输出一致。

### 10. 前端在 `web/`，接口契约仍是唯一依据

前端是仓库内的 `web/`（Vue 3 + Vite），由本服务的静态托管层挂在 `/logshare/`。
但**接口契约与前端实现分离**这条原则不变：`API.md` 是唯一依据，前端不得靠读后端源码猜字段。

- `API.md` 是唯一契约：路由、字段、SSE 帧格式、错误码、管理接口三态、客户端实现要点。
- `tests/api-doc.test.ts` 双向守门：文档写了但代码没有 → 报错；代码有但文档没写 → 也报错。
  这条比格式检查值钱——**新增接口忘了写文档是最常见的漂移方向**。
- `tests/api-contract.test.ts` 守**字段级**契约：只校验路由存在拦不住「上传返回 `id`
  而文档写 `logId`」这类漂移（两边各自都正常，前端拿到 `undefined` 继续跑）。
- 前端测试在 `web/tests/`（Vitest），与后端 `tests/*.test.ts`（node:test）分开跑。

前端的两条安全不变量由静态扫描守住：
- **禁止 `v-html` / `innerHTML` / `eval` / `marked.parse`**（`web/tests/security.test.ts`）；
- **禁止网络字体与远程图片**，避免离线构建失败与阅读者 IP 泄漏。

**页面分工（不可合并）**：
- `/` 是官网首页，`web/public/landing.html` 静态托管，不经 Vue —— 第一次来的人
  先看「这是什么」。文件缺失时回退为重定向到 `/logshare/`。
- `/logshare/` 是应用首页，**打开即聊天**。日志是可选附件，不是入场券：
  「输入编号 / 上传 / 粘贴」三件套已从首屏移除，收进输入区。
- 追问（`ask_user`）必须可恢复：`status` 帧 `type=ask` → `done.asks` → 消息
  `meta.asks` 落库三级通道；「已回答」由**其后是否出现用户消息**判定，不设额外状态。

## 环境适配（踩坑记录）

### 编译产物才会暴露的路径基准缺陷（务必从项目根启动）

**现象**：`tsx src/server.ts` 一切正常，`npm run build && node dist/server.js`
却**静默降级**——默认模型显示「(未配置)」、配额从 1000/日 掉到 30/日、页面 404。

**原因**：`.env` 与 `web/dist` 的默认位置原用 `new URL('../…', import.meta.url)` 推算。
源码直跑时模块在 `src/`，路径正好对；编译后模块在 `dist/src/`，
`../.env` 变成 `dist/.env`、`web/dist` 变成 `dist/web/dist`——都不存在，
于是前者静默 return、后者返回 404。

**为什么危险**：三者都不报错，服务照常启动、`/health` 照常 200。
线上会表现成「模型没配」，而人第一反应是去查 API key——**排查方向第一步就错**。

**纪律**：一切路径基准取**工作目录**（`DATA_DIR=./data`、`PROMPTS_DIR=./prompts`、
`dotEnvPath()`、`webDir()` 四处一致），服务必须从项目根启动。
`tests/path-bases.test.ts` 同时断言「值落在工作目录下」与
「`config.ts` / `static.ts` 不得出现由 `import.meta.url` 推算的路径」——
第二层必须有，因为第一层在源码直跑下对错误实现同样成立。

**相关**：`npm run build` 走 `tsconfig.build.json`（rootDir=src），产物入口是
`dist/server.js`；用根 `tsconfig.json` 编译会得到 `dist/src/server.js`，
`npm start` 会直接失败。

### 重启时的端口占用（不是缺陷，是时序）

**现象**：重启服务报 `listen EADDRINUSE`，或看起来「服务没起来」。

三个因素叠加，缺一不可：① `kill` 后进程未必立刻退出（原先**没有信号处理**，
靠 Node 默认行为，实测滞后数秒）；② 冷启动要 **6–10 秒**（langchain 那一串依赖）
才监听，期间端口不可连、无任何输出；③ 手写 `kill && sleep 2 && start` 不确认
进程消失、不确认端口释放，失败还被 `>log 2>&1` 吞掉。

**现在的做法**：
- `src/server/start.ts` 接管启动：**端口占用时自动递增**（`PORT`、`PORT+1`…，
  上限 20 个；`PORT_AUTO_INCREMENT=0` 可关闭），并打印 `READY port=<真实端口>`
  单行标记供脚本判断就绪。**信号处理必须在打印 READY 之前安装**——
  否则外部脚本看到 READY 就 `kill`，会赶上信号还没接上的窗口（测试抓到过这个竞态）。
- SIGTERM/SIGINT 优雅退出：停止接新连接 → `closeAllConnections` → 关 SQLite →
  关 worker 池 → 退出；5 秒硬超时兜底，二次信号立即强制退出。实测释放端口 **55ms**。
- `scripts/restart.sh`：等「进程消失」「端口释放」两个事实，再等 `READY`，最后校验
  `/health`，全程不猜时长。

**另一个坑**：`pkill -9 -f "dist/server.js"` 会连执行它的 shell 一起杀
（命令行里含该字符串），表现为命令莫名 `Killed`。改用 pidfile 或
`ps -ef | grep ... | grep -v grep` 逐个 kill。

### 前端托管：路径遍历用「结构性不可能」而不是「尝试拦截」

`src/server/static.ts` 里只有一个目录会真正读盘：`assets/`，且文件名必须匹配
`^[A-Za-z0-9._-]+$`；其余任何 `/logshare/**` 一律返回 `index.html`（SPA 深链需要）。
这样「构造奇怪路径读文件」在语义上不成立，而不是靠字符串前缀校验去拦。

**实测补充**：`new URL(req.url, host)` 会解开百分号编码并**归一化 `..` 段**，
于是 `/logshare/assets/%2e%2e/secret.txt` 到业务代码手上已是 `/logshare/secret.txt`，
走的是 SPA 回退而不是 404。因此断言静态托管的不变量时，要写「**永不返回产物目录
之外的内容**」，而不是「返回 404」——后者会放过一个把文件内容当 200 返回的实现。

### 前端挂载路径（给自行开发前端的人）

前端挂 `/logshare/` 子路径。构建工具的 `base` 与路由库的 history base **必须同为**
`/logshare/`。写错的后果不同：前者资源 404（白屏），后者首屏正常但**刷新即 404**；
且前者在 dev 模式下常常看不出来，要到构建后才暴露。

### 本地模型端点始终返回 SSE

**现象**：`127.0.0.1:8765` 端点**忽略 `stream: false`**，无论是否传参都返回
`text/event-stream`。LangChain 的 `ChatOpenAI` 在非流式模式下期望 JSON，
会报 `Cannot read properties of undefined (reading 'message')`。

**解法**：`src/agent/model.ts` 强制 `streaming: true`，走 SSE 路径。

**附带配置**：`streamUsage: false`——多数自建端点不支持 `stream_options.include_usage`。

### pnpm 在 Termux 不可用

**现象**：`ERR_PNPM_STORE_DIR_ACQUIRE_OPERATION_LOCK` + `lock_shared() not supported`。

**原因**：pnpm 的 store 锁用了 `lock_shared()`，Termux 的 flock 实现不支持。

**解法**：本项目用 **npm**（`LogShare-Web-UI` 亦如此）。

### 系统重启后不要重复派发已运行的任务（流程教训）

**现象**：系统重启后，此前派发的后台子代理**会自动恢复并继续写入**。若此时误判为「任务已中断」而重新派发，
会出现**多路并发写同一批文件**——后写者覆盖先写者。

**实测案例**：`knowledge/format/launcher-log.md` 被两路并行写入反复改写（H1 与小节结构在 10:47–11:08
之间变动）。所幸两路子代理都采取了「不覆盖更完整版本」的策略，最终无内容丢失，但这是运气而非设计。

**对策**：
1. 系统重启后，**先检查目标文件是否已被更新**（`find <dir> -newermt '-30 minutes'`），再决定是否重新派发
2. 派发子代理时，若多个子代理可能触及同一文件，应在 prompt 中明确**文件归属边界**（本次已做到：patterns / format 分工清晰）
3. 收到子代理的「并发写入」告警时，务必核查文件完整性（H1、必需小节、结尾段落），而不是默认无碍

### /tmp 只读

临时文件用 `/data/data/com.termux/files/usr/tmp/` 或项目内 `tmp/`。

## 技术约束

| 约束 | 说明 |
|---|---|
| **CPU 密集工具必须进 worker 线程** | 实测：10MB 日志 grep 导致事件循环停顿 **1423ms**。`readLog`/`grepLog` 必须用 `worker_threads` |
| **`node:sqlite` 可直接复用 RAG 索引** | 实测：Node 24 内置 SQLite 3.53.0 与 PHP `pdo_sqlite` 版本一致，FTS5 / `bm25()` / BLOB 全兼容 |
| **SpinYarn 无法迁移** | PHP C 扩展，反混淆必须留在 LogShare |
| **依赖体积** | `deepagents` + LangChain 全栈 `node_modules` 137MB，导入后 RSS 169MB |

## 验证命令

```bash
npm test                    # 全部单元测试（32 个文件 369 项）
npm run typecheck           # TypeScript 类型检查
npm run build && npm start  # 编译产物冒烟（必须能跑通：另有一条与 tsx 不同的路径）
bash scripts/restart.sh     # 重启服务（等端口释放 + 等 READY + 校验 /health，不靠 sleep 猜）
npx tsx src/rag/build-cli.ts    # 重建知识库索引（./knowledge → ./data/rag/index.db）
npx tsx scripts/smoke-deepagent.ts   # DeepAgents 冒烟测试
npx tsx scripts/verify-anchor.ts <日志目录>    # 窗口锚点验证
npx tsx scripts/verify-rag.ts       # RAG 检索验证（默认索引路径已可用）
GITHUB_TOKENS=... npx tsx scripts/verify-github.ts  # GitHub 客户端验证
python3 scripts/analyze_scores.py   # 生产语料评分复核（读 data/corpus/）

```

**注意**：测试必须写成 `tests/*.test.ts`——写成 `tests/` 目录形式会失败。
每个测试文件独立进程，因此可以在文件顶部直接设 `process.env`
（`tests/path-bases.test.ts` 就用这个特性验证默认路径）。

**前端构建产物由本服务托管**：`npm run build:all` 会先构建前端（`web/dist`）再编译后端；
或分开执行 `cd web && npm run build` 与 `npm run build`，然后 `npm start`，访问 `/logshare/`。
未构建时 `/logshare/*` 落普通 404，`/v1/*` 不受影响；启动日志会打印「前端页面: 未布置」，
此时是预期状态，不是故障。

**前端测试与后端测试是两套**：
```bash
npm test              # 后端 node:test（tests/*.test.ts）
npm run web:test      # 前端 vitest（web/tests/*.test.ts）
npm run web:typecheck # vue-tsc
```

**知识库改动后必须重建索引**，否则新条目检索不到（`rag_search` 返回「索引不可用」
或命中旧分块）。重建前先确认没有子代理在写 `knowledge/`
（`find knowledge -newermt '-30 minutes'`），避免读到写了一半的文件。

## 与用户的协作约定（不可省略）

- **工程脚本与文档一律保留，不得删除。** `scripts/`、`docs/`、`MISSION.md`、
  `HANDOFF.md`、`data/corpus/` 里的实测数据，以及历史排查脚本，都是
  「某个结论是怎么来的」证据链。后续优化要回头复算（例如「这条签名到底多少份
  日志命中」），删掉就等于把结论降级成传闻。清理前必须确认没有任何文档引用它。
- 使用简体中文与用户交流与推理；术语可保留英文，但表述须以中文为准。
- **不要替用户猜测成本与取舍**：改提示词、改阈值、改默认值这类「影响输出质量」的
  改动，先量化收益再动手，量化不了就先说不确定。

## 实测数据摘要（27 份真实移动端日志）

| 指标 | 值 |
|---|---|
| 根因准确率 | **93%**（25/27） |
| 平均工具调用 | 12.5 次/份 |
| 平均思维链 | 15584 字/份 |
| `grep + read` 占比 | **46%**（弥补窗口缺陷） |
| `github_get_content` | 仅 8 次（前置检索失败，无条目可读） |
| 正文为空（流截断） | 1 份 |

**核心结论**：模型推理能力不是瓶颈，瓶颈在「给它什么上下文」与「结果如何交付」。
