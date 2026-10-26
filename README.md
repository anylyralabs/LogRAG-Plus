# LogRAG+

Minecraft 日志排障服务。上传日志后，模型在知识库、GitHub 与日志检索工具之间多轮取证，
输出根因、修复步骤与结构化结论，并给出可核对的自评分数。

可独立运行，也可作为 LogShare 的深度分析入口（读取 LogShare 已有日志，追加内容只写本服务自己的库）。

## 主要能力

- **日志会话**：上传主日志后可持续追问；支持后续追加崩溃报告、启动器日志等分段材料，会话 ID 与链接不变。
- **工具化排障**：日志 grep / 分段读取、本地 RAG 知识库、GitHub 仓库与 issue 检索（可选）、已知领域知识。
- **自评与记录**：四维评分（grounding / verification / actionability / economy），分析记录入库，可用于看板与回归。
- **反混淆**：通过 koffi 直调 SpinYarn 的 C ABI，与 LogShare 共用映射目录与 Redis 缓存；未配置时自动跳过。
- **多供应商**：支持 OpenAI 兼容端点，也可在请求里携带自定义供应商。

## 架构与数据边界

同一个 MariaDB 实例、两个库，权限分开：

| 库 | 权限 | 内容 | 保留期 |
|---|---|---|---|
| `lograg` | 读写 | 会话、消息、日志正文与追加段、分析记录、领域知识 | 会话/正文 48 小时 |
| `logshare` | 只读 | 从 LogShare 导入的日志正文 | 跟随 LogShare（默认 7 天） |

- 追加段永远只写 `lograg`，LogShare 一行不写。
- 两个库默认同实例（共用 `DB_HOST` / `DB_PORT`），也可完全独立部署。
- 本服务上传的日志**不做脱敏**（会改写原文、影响排障判断），依赖短保留期与访问控制兜底；
  经 LogShare 导入的日志仍由 LogShare 侧完成脱敏。

RAG 索引是构建产物，放在 `data/rag/index.db`（SQLite，只读），不进版本库，部署时需要重建。

## 环境要求

- Node.js **24+**
- MariaDB **10.5+ / 11.x**
- Redis（可选）：仅用于反混淆的共享缓存（`SPINYARN_REDIS_URL`）；限流计数在进程内
- SpinYarn（可选）：反混淆动态库
- 前端构建产物由本服务托管，构建需要 Node 24

## 快速开始

### 1. 安装依赖

```bash
npm install
npm --prefix web install
```

### 2. 建库与授权

```sql
CREATE DATABASE lograg CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'lograg'@'127.0.0.1' IDENTIFIED BY '<密码>';
GRANT ALL PRIVILEGES ON lograg.* TO 'lograg'@'127.0.0.1';
-- 测试会用独立库 lograg_test_<hex>，只在需要跑测试时授予：
GRANT ALL PRIVILEGES ON `lograg_test_%`.* TO 'lograg'@'127.0.0.1';
```

表结构在**服务启动时自动迁移**（`lograg_migrations` 记账，幂等）；迁移失败会直接退出，
不会带着半截 schema 对外提供服务。

### 3. 配置

```bash
cp .env.example .env
```

至少填写：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=lograg
DB_PASSWORD=<密码>
DB_NAME=lograg

AI_BASE_URL=https://<供应商>/v1
AI_MODEL=<模型名>
AI_API_KEY=<密钥>
```

完整变量见 `.env.example`，常用项：

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 监听地址与端口，默认 `0.0.0.0:8080`，仓库示例用 `8788` |
| `AI_*` | 默认模型供应商；也可由请求级 `provider` 覆盖 |
| `LOGSHARE_DB_*` | 导入日志的只读库；不配置则走 LogShare 公网 API |
| `ADMIN_ENABLED` / `ADMIN_TOKEN` | 管理接口开关与令牌（未配置时管理路由一律 404） |
| `SPINYARN_*` | 反混淆动态库、映射目录、共享缓存 Redis URL |
| `RAG_INDEX_PATH` | 索引路径，默认 `./data/rag/index.db` |
| `TRUSTED_PROXIES` | 可信反代网段，用于解析真实客户端 IP |

### 4. 构建 RAG 索引

```bash
npx tsx src/rag/build-cli.ts
```

索引是按 `##` 二级标题切分后写入 SQLite FTS5 的构建产物；知识库改动后必须重建，
否则新条目检索不到。重建是原子替换，失败会保留旧索引。

### 5. 构建与启动

```bash
npm --prefix web run build   # 前端 → web/dist
npm run build                # 后端 → dist/
npm start                    # node dist/server.js
```

开发模式：

```bash
npm run dev                  # tsx watch
npm --prefix web run dev     # Vite，/v1 与 /health 已代理到 8788
```

健康检查：

```bash
curl http://127.0.0.1:8788/health
```

响应里的 `config.deobfuscate` 会说明反混淆是否启用、是否走了共享缓存。

## 反混淆（可选）

不配置时全部走原文，不影响分析。启用步骤：

```bash
git clone https://github.com/anylyralabs/SpinYarn.git
cd SpinYarn
cargo build --release -p spinyarn-capi
# 产物：target/release/libspinyarn_capi.so
```

需要 Rust **1.88+**。然后在 `.env` 中配置：

```dotenv
SPINYARN_SO=/opt/SpinYarn/target/release/libspinyarn_capi.so
SPINYARN_MAPPINGS_DIR=/opt/mappings          # 目录下需有 <版本>.tiny.gz
SPINYARN_REDIS_URL=redis://:密码@127.0.0.1:6379/0   # 可选，与 LogShare 共用缓存
```

- 映射文件不自动下载，需自行放置；按需加载，不存在的版本原样透传。
- 动态库与宿主机 libc 必须匹配：Debian/Ubuntu 用 glibc 产物；Alpine 需自行编译 musl 目标。
- 版本识别覆盖游戏日志、崩溃报告、Fabric `intermediary/` classpath、Forge 参数与 maven 坐标等来源。

## 部署

### 原生部署

```bash
npm ci
npm --prefix web ci
npm --prefix web run build
npm run build
npx tsx src/rag/build-cli.ts
NODE_ENV=production node dist/server.js
```

建议用 systemd 或进程管理器守护；仓库内 `scripts/restart.sh` 是开发用的重启脚本
（等端口释放、等 READY、校验 `/health`），也可作为守护配置的参考。

### Docker

```bash
cp .env.example .env       # 填好数据库、模型等
npx tsx src/rag/build-cli.ts   # 索引在宿主机构建，compose 只读挂载
docker compose -f docker/compose.yaml up -d --build
```

- 容器只监听回环 `127.0.0.1:8788`，对外由反代负责。
- `.env` 里的 `DB_HOST` 必须从**容器内**可达：同机 compose 用服务名，宿主机数据库用
  `host.docker.internal` 或宿主内网 IP，不能用 `127.0.0.1`。
- 反混淆的 `.so` 需与镜像 libc 匹配。镜像基于 Debian slim（glibc），可直接使用常规构建产物。

### 反向代理

SSE 必须关闭缓冲，否则前端会等到整段分析结束才一次性出现：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 12m;   # 上传上限 10MB + JSON 开销
}
```

服务自身已发送 `X-Accel-Buffering: no`，但显式关闭更稳妥。反代网段需加入 `TRUSTED_PROXIES`，
否则限流会把所有请求算到反代 IP 上。

## 测试

后端测试需要 MariaDB；测试进程**不读 `.env`**，连接参数要显式给：

```bash
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=lograg DB_PASSWORD=<密码> npm test
npm run typecheck
npm --prefix web run test
```

每个测试文件自建独立库 `lograg_test_<hex>`，用完 DROP；数据库不可用时相关用例会 skip，
不会假绿。当前规模：后端 396 项、前端 197 项。

## 目录

```
src/
├── agent/       模型循环、提示词、工具集、反混淆
├── store/       MariaDB 连接池、迁移、会话、日志正文与追加段
├── server/      HTTP 路由、SSE、静态托管、正文来源解析
├── rag/         知识库加载、分块、索引构建与检索
├── knowledge/   已知领域知识（注入 + 工具双通道）
├── eval/        证据锚点、四维评分、分析记录
├── security/    客户端 IP、SSRF 校验、管理鉴权
web/             Vue 3 工作台（构建产物由服务托管）
knowledge/       RAG 知识库源文件
prompts/         提示词资产
docker/          镜像与单服务编排
```

## 已知限制

- 公开接口按匿名主体（指纹/IP+UA）限流，没有账号体系；分享链接即访问凭据。
- 上传正文不脱敏，请勿用于必须留存的敏感数据。
- 反混淆依赖外部映射文件，不随仓库分发。
- Docker 编排只包含本服务；TLS、WAF、限流由既有反向代理层负责。
