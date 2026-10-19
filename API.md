# LogRAG+ API

AI 日志排障服务。读取 Minecraft 崩溃日志，给出带证据的根因判断与可操作步骤。

- 默认监听 `http://127.0.0.1:8788`（`HOST` / `PORT` 可改；端口被占用时自动递增）
- 全部接口返回 JSON，**对话接口返回 SSE 流**
- 管理接口默认关闭，需显式开启并配令牌
- 本仓库**不含前端**。前端产物可用 `WEB_DIR` 挂到 `/logshare/`，未配置时服务为纯 API

---

## 目录

| 接口 | 用途 |
|---|---|
| `GET /health` | 健康检查与运行配置摘要 |
| `POST /v1/chat` | 发起一轮分析（SSE 流式） |
| `GET /v1/log/{logId}` | 取日志正文与附件（只读，不计配额） |
| `GET /v1/session/{sessionId}` | 回放历史会话 |
| `POST /v1/upload` | 上传日志（脱敏 → 去重 → 异步反混淆） |
| `GET /v1/topics` | 知识库目录概览 |
| `/v1/admin/*` | 管理接口（领域知识、分析记录） |

---

## 通用约定

### 错误响应

非流式接口在失败时返回 HTTP 4xx/5xx，正文统一为：

```json
{ "ok": false, "error": "可读的中文说明" }
```

`error` 文案**直接面向用户**，可原样展示。不要用状态码自行编造文案——服务端知道具体原因
（例如「日志不存在或已过期」与「日志 ID 格式非法」都是 4xx，但处置完全不同）。

| 状态码 | 含义 |
|---|---|
| 400 | 请求体非法、字段缺失、ID 格式错误 |
| 401 | 管理令牌无效或缺失 |
| 404 | 资源不存在 / 已过期 / 路由不存在 / 管理接口未开启 |
| 429 | 配额用尽（带 `remaining: 0`） |
| 503 | 未配置模型供应商 |
| 500 | 服务端异常（正文含可读原因） |

### 跨域

所有响应带：

```
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS
```

`OPTIONS` 预检返回 `204`。同源部署时无需处理。

### 客户端标识（配额）

配额按「设备指纹优先、IP 兜底」计算，用于在无登录产品里做成本分层软限制。
请求体可传 `fingerprint`（任意稳定字符串，建议浏览器端生成后存 localStorage）。
不传则按 `User-Agent` + 服务端解析出的真实客户端 IP 计算。

配额不消耗的接口：`/health`、`/v1/log/*`、`/v1/session/*`、`/v1/topics`。

---

## `GET /health`

探活与运行状态。启动脚本以它判断「服务真的起来了」。

**响应 200**

```json
{
  "ok": true,
  "service": "lograg-plus",
  "version": "0.1.0",
  "rag": { "chunks": 413, "files": 42 },
  "config": {
    "server": 8788,
    "logshare": "(独立运行模式)",
    "db": "(未配置)",
    "redis": "(未配置，降级)",
    "ragIndex": "./data/rag/index.db",
    "ragEmbedding": "BAAI/bge-m3",
    "defaultProvider": "hy4-preview-f",
    "github": "0 个 Token",
    "quota": "chat=1000/logId=1000/upload=1000 每日, 50 轮/会话"
  }
}
```

`config` 是**人读摘要**，字段值可能是中文说明（如 `(未配置)`）。
不要把它当机器可解析的配置源——需要程序判断时看 `rag.chunks > 0` 这类数值字段。

`rag.chunks` 为 0 表示索引不可用，此时检索类工具会降级，但分析仍可进行。

---

## `POST /v1/chat`

发起一轮分析。**响应是 SSE 流**，不是 JSON。

### 请求

```
POST /v1/chat
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "message": "这份日志为什么崩溃？",
  "logId": "kalkLqQ",
  "sessionId": "smvbpsiilbn2nl0p6",
  "fingerprint": "fp_abc123",
  "provider": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `message` | **是** | 用户发言。空或全空白返回 400。可含引用的日志片段（见下文「引用日志」） |
| `logId` | 否 | 绑定的日志 ID（七位）。会话一旦绑定，后续轮次可省略 |
| `sessionId` | 否 | 延续既有会话。省略则按 `logId` 复用或新建 |
| `fingerprint` | 否 | 设备指纹（配额用） |
| `provider` | 否 | 自定义模型供应商。省略则用服务端默认 |
| `logContent` | 否 | 直接传日志正文（免去按 ID 取回）。与 `logId` 同时给时以 `logContent` 为准 |

**会话解析优先级**：

1. 显式传入的 `sessionId`（多轮延续）
2. 按 `logId` 查找未过期会话（同一日志不重复建会话）
3. 新建

会话已绑定日志时，后续轮次省略 `logId` 也能用日志工具——绑定关系在服务端。

### 响应（推流前失败）

若在开始推流前就失败（参数非法、配额用尽、供应商未配置），返回**普通 JSON** 而非流：

```json
{ "ok": false, "error": "未配置模型供应商。请在设置中填写，或联系管理员配置服务端默认供应商。", "remaining": 999 }
```

因此客户端必须检查 `content-type`：不是 `text/event-stream` 时按 JSON 错误处理。

### 响应（SSE 流）

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

帧格式如下，**帧之间以空行分隔**：

#### 状态帧

```
event: status
data: {"type":"thinking","delta":"先看最后 200 行…"}
```

| `type` | 载荷 | 含义 |
|---|---|---|
| `thinking` | `delta` | 思维链增量 |
| `tool` | `name`, `arguments` | 模型要调用某个工具 |
| `tool_result` | `name`, `summary`, `truncated` | 工具返回摘要 |
| `limit` | `rounds` | 已达工具轮次上限，即将进入收尾 |
| `reflection` | `message` | 状态说明（如「检测到重复检索，正在整理结论」） |
| `queued` | `message` | 排队中（启用微队列时） |

#### 正文帧

**无 `event:` 行**，沿用 OpenAI 兼容形状：

```
data: {"choices":[{"delta":{"content":"根因是"}}]}
```

#### 结束帧

```
event: done
data: {
  "status": "completed",
  "sessionId": "smvbpsiilbn2nl0p6",
  "remaining": 999,
  "score": {
    "overall": 92,
    "deliverable": true,
    "dimensions": { "grounding": 79, "verification": 100, "actionability": 100, "economy": 100 },
    "deductions": ["6 条断言没有可核实的标识…"],
    "missingAnchors": []
  }
}
```

| 字段 | 说明 |
|---|---|
| `sessionId` | **必须保存**，下一轮用它延续会话 |
| `remaining` | 今日剩余次数 |
| `nearLimit` | 仅在接近上限时出现（布尔） |
| `score` | 自评。`grounding` 按「结论中的引用能否在日志里核对上」打分，**不按工具调用次数** |
| `score.missingAnchors` | 正文里声称有依据但未能核对的条目，可据此提示用户「这几条我没办法确认」 |

#### 错误帧

```
event: error
data: {"error":"分析失败：上游返回 502"}
```

错误帧之后流即结束，不会有 `done`。客户端应把已有正文保留，并在界面上标注「未完成」。

#### 心跳

服务端每 15 秒发一行注释：

```
: keep-alive
```

按 SSE 规范忽略以 `:` 开头的行即可。

### 空正文的处理

后端对「空正文」有硬性约定：**空正文一律视为失败**，不伪装成功。具体：

- 上游截断（只出思维链）= 失败，但会**自动重试一次**
- 撞工具轮次上限 = 先强制一次「只综合、不调工具」的收尾轮
- 模型把工具调用写成正文 = 视为本轮流产，转收尾轮重做
- 收尾轮仍为空 = 如实失败，`event: error`

客户端不应把「有 `done` 帧」等同于「有结论」，要同时检查正文是否为空。

### 引用日志片段

要让模型聚焦某几行，把片段拼进 `message` 即可，建议保留出处：

```
这几行为什么会报错？

引用日志 main.log:1204-1210：
```
[12:00:03] [main/ERROR]: java.lang.NoSuchMethodError: ...
  at com.example.CoolMod.onInit(CoolMod.java:42)
```
```

行号由客户端加、不要让模型去猜——它拿不到原始行号。

---

## `GET /v1/log/{logId}`

取日志正文与附件，供界面阅读、分节跳转与选行引用。**只读、不消耗配额**。

| 路径参数 | 说明 |
|---|---|
| `logId` | 七位日志 ID（长度与字符集都校验，非法返回 400） |

**响应 200**

```json
{
  "ok": true,
  "logId": "kalkLqQ",
  "source": "fcl/1.3.0",
  "createdAt": 1729000000,
  "maybeObfuscating": false,
  "docs": [
    { "name": "main.log", "bytes": 259525, "lines": 2604, "content": "…", "truncated": false }
  ],
  "omitted": []
}
```

| 字段 | 说明 |
|---|---|
| `docs[].content` | 正文。**多份文件已按 `===== 文件名 =====` 分节合并** |
| `docs[].truncated` | 该份文档超过 2MB 被截断。界面上要说明「面板只显示前 2MB」 |
| `docs[].bytes` | **原始**字节数（不是截断后的长度） |
| `omitted` | 因总量预算（6MB）完全未下发的文档名。非空时界面应提示 |

**关于附件**：只有配置了内部 API（`LOGSHARE_INTERNAL_URL`）时才有独立的 `docs[]`
多文档；公网路径返回的是已合并的全文，因此 `docs` 长度为 1。
两条路径下**分节信息都能从正文的 `===== 名称 =====` 标记还原**。

**结果缓存**：成功结果进程内缓存 5 分钟（同 ID 直接命中）。**失败不缓存**——
上游抖动恢复后应能立即读到。

**错误**

| 状态 | 场景 |
|---|---|
| 400 | ID 格式非法（不是七位 / 含非法字符） |
| 404 | 日志不存在、已过期，或上游读不到正文 |

错误文案来自具体失败的那条路径，不会用「未配置内部 API」掩盖真实原因。

---

## `GET /v1/session/{sessionId}`

回放历史会话，用于刷新页面或换设备后恢复对话。

**响应 200**

```json
{
  "ok": true,
  "sessionId": "smvbpsiilbn2nl0p6",
  "logId": "kalkLqQ",
  "messages": [
    { "role": "user", "content": "这份日志为什么崩溃？", "createdAt": 1729000000 },
    {
      "role": "assistant",
      "content": "根因是…",
      "createdAt": 1729000012,
      "score": { "overall": 92, "deliverable": true, "dimensions": {}, "deductions": [], "missingAnchors": [] }
    }
  ]
}
```

| 状态 | 场景 |
|---|---|
| 404 | 会话不存在或已过期 |

会话保留期：独立会话 48 小时（`SESSION_TTL_HOURS`），
绑定日志的会话跟随日志 TTL（`storage.storageTime`）。

---

## `POST /v1/upload`

上传日志。委托 LogShare 完成**脱敏 → 去重 → 异步反混淆 → 安全审核**，
本服务只做转发与校验。

### 请求

```json
{
  "content": "日志正文…",
  "files": [
    { "name": "latest.log", "data": "日志正文…" },
    { "name": "crash-report.txt", "data": "崩溃报告…" }
  ],
  "source": "fcl/1.3.0"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `content` | 二选一 | 纯文本正文 |
| `files[]` | 二选一 | 多文件，各含 `name` 与 `data` |
| `source` | 否 | 来源标识（如 `fcl/1.3.0`）。省略时服务端尝试从 User-Agent 推断 |

**校验规则**（任一不满足返回 400）：

- 单文件 ≤ 10MB、≤ 50,000 行
- 最多 200 个文件，总量 ≤ 12MB
- 只接受文本；**不处理 ZIP**（客户端解压后逐文件上传）

### 响应 200

```json
{ "ok": true, "logId": "kalkLqQ", "remaining": 4, "maybeObfuscating": true }
```

`maybeObfuscating: true` 表示反混淆可能仍在后台进行（创建后 60 秒内）。
此时读 `/v1/log/{logId}` 拿到的可能是未反混淆的正文。

| 状态 | 场景 |
|---|---|
| 400 | 校验失败（`error` 说明具体哪一条） |
| 429 | 上传配额用尽，带 `remaining: 0` |
| 503 | 未配置 LogShare 上传能力 |

---

## `GET /v1/topics`

知识库目录概览，供界面展示「都覆盖了哪些方面」。

**响应 200**

```json
{
  "ok": true,
  "topics": "知识库主题目录（共 42 个文件 / 413 个分块）：\n\n- cases：5 个文件，76 个分块\n- patterns：28 个文件，251 个分块\n…"
}
```

`topics` 是**已排版好的多行文本**，可直接展示。需要结构化数据时自行按行解析
（格式为 `- {目录}：{n} 个文件，{m} 个分块`）。

---

## 管理接口

统一前缀 `/v1/admin/`，默认关闭。

### 鉴权

两种写法都接受：

```
X-Admin-Token: <ADMIN_TOKEN>
Authorization: Bearer <ADMIN_TOKEN>
```

**三种失败必须区分**（这是刻意的设计，界面文案不要合并）：

| 状态 | 含义 | 处置 |
|---|---|---|
| 404 | 管理接口未开启（`ADMIN_ENABLED` 未设） | 去打开配置项 |
| 404 | 已开启但未配令牌 | 去设置 `ADMIN_TOKEN` |
| 401 | 令牌不匹配 | 核对令牌值 |

把 404 说成「令牌错误」会让人反复换令牌，而真正的原因是配置项没开。

### `GET /v1/admin`

端点自述清单（需鉴权）：

```json
{
  "ok": true,
  "endpoints": [
    "GET    /v1/admin/domain-knowledge",
    "POST   /v1/admin/domain-knowledge",
    "POST   /v1/admin/domain-knowledge/analyze",
    "GET    /v1/admin/domain-knowledge/audit",
    "GET    /v1/admin/domain-knowledge/injection",
    "GET    /v1/admin/domain-knowledge/search?q=",
    "GET    /v1/admin/domain-knowledge/{id}",
    "PUT    /v1/admin/domain-knowledge/{id}",
    "DELETE /v1/admin/domain-knowledge/{id}",
    "GET    /v1/admin/records",
    "GET    /v1/admin/records/stats",
    "GET    /v1/admin/records/{id}",
    "DELETE /v1/admin/records/{id}",
    "POST   /v1/admin/records/purge"
  ]
}
```

### 领域知识

运维维护的「已知业务规则」，会**直接拼进系统提示词**作为强制先验，模型无权修改。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/admin/domain-knowledge` | 列表 |
| POST | `/v1/admin/domain-knowledge` | 新增（`{ "text": "…" }`，单条 ≤ 200 字） |
| POST | `/v1/admin/domain-knowledge/analyze` | 判断一段文本的性质（是否适合作为领域知识） |
| GET | `/v1/admin/domain-knowledge/audit` | 变更留痕（`?limit=`） |
| GET | `/v1/admin/domain-knowledge/injection` | 预览实际注入到提示词的文本 |
| GET | `/v1/admin/domain-knowledge/search?q=` | 关键词检索 |
| GET | `/v1/admin/domain-knowledge/{id}` | 单条详情 |
| PUT | `/v1/admin/domain-knowledge/{id}` | 修改 |
| DELETE | `/v1/admin/domain-knowledge/{id}` | 删除 |

### 分析记录

每次分析的完整记录（含自评、工具链、证据核对结果）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/admin/records` | 分页检索（见下方参数表，`limit` 硬上限 100） |
| GET | `/v1/admin/records/stats` | 汇总统计（总量、均分、按模式分布） |
| GET | `/v1/admin/records/{id}` | 单条完整记录 |
| DELETE | `/v1/admin/records/{id}` | 删除单条 |
| POST | `/v1/admin/records/purge` | 按条件批量清理 |

`GET /v1/admin/records` 的查询参数（全部可选）：

| 参数 | 说明 |
|---|---|
| `limit` | 返回条数，默认 50，**硬上限 100**（超出的值会被夹到 100，不是报错） |
| `offset` | 跳过条数 |
| `minScore` / `maxScore` | 总分区间（含端点） |
| `deliverable` | `1` 仅可交付 / `0` 仅不可交付 |
| `logId` | 按日志 ID 过滤 |
| `model` | 按模型名过滤 |
| `orderBy` | `created` / `overall` / `rounds` / `tool_calls` |
| `ascending` | `1` 为升序，默认降序 |

响应除 `records` 外还带 `total`（全量条数，不受 `limit` 影响）：

```json
{ "ok": true, "records": [ … ], "total": 1284 }
```

**注意**：`records` 的 `{id}` 可能含冒号（如 `ai:analysis:kalkLqQ`），
**必须做 URL 编码**。服务端会先解码再匹配；不编码时路由可能无法命中。

---

## 附：SSE 客户端实现要点

自己写前端时，这几处最容易出错（都有对应实测）：

**一、必须保留跨块的残余。** 一个帧常被 TCP 切成两块，按 `\n\n` 切分后要把不完整的尾部留在缓冲区。

**二、必须用流式解码。** `TextDecoder` 要带 `{ stream: true }`，否则 UTF-8 汉字被切在块边界会产生乱码方块。

**三、`data:` 可能有多行。** 规范规定多行 `data:` 以换行拼接，不要只读第一行。

**四、不要用 `EventSource`。** 它只能发 GET，而对话是 POST 带 JSON body 的。
用 `fetch` + `ReadableStream` 手工解析。

**五、先检查 `content-type`。** 推流前失败返回的是 JSON，直接按流解析会得到空结果。

参考实现（`web/` 已移除，逻辑仍适用）：

```ts
const res = await fetch('/v1/chat', { method: 'POST', headers: {...}, body: JSON.stringify(req) })
if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
  const j = await res.json()          // 推流前失败
  throw new Error(j.error)
}
const reader = res.body!.getReader()
const decoder = new TextDecoder('utf-8')
let buffer = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let i = buffer.indexOf('\n\n')
  while (i >= 0) {
    handleFrame(buffer.slice(0, i))
    buffer = buffer.slice(i + 2)
    i = buffer.indexOf('\n\n')
  }
}
if (buffer.trim() !== '') handleFrame(buffer)   // 末尾可能没有空行
```
