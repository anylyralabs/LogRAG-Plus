# LogRAG+ 交接文档（压缩上下文后从这里恢复）

> 更新：2026-10-24（迁移到 Debian 13 容器后校对）。
> 口径：`AGENTS.md` 是架构与决策的唯一来源；本文件只记录**状态与待办**。

## 1. 路径

| 内容 | 路径 |
|---|---|
| 本项目 | `/home/YanSui/Project/LogRAG-Plus` |
| 上游参考（只读） | `/home/YanSui/LogShare`（Node 不写它） |
| Plan/实测报告 | `/home/YanSui/.opencode/plan/` |
| 临时文件 | `/tmp/`（系统 `/tmp` 可写） |

## 2. 恢复步骤（按序）

1. `cd /home/YanSui/Project/LogRAG-Plus && npm install`
2. 启动本机 MariaDB 与 Redis（Debian 容器）：
   `sudo systemctl start mariadb redis-server`
   首次部署需建库授权（`.env` 里的 `DB_USER` / `DB_PASSWORD`）：
   ```sql
   CREATE DATABASE lograg CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'lograg'@'127.0.0.1' IDENTIFIED BY '<见 .env>';
   GRANT ALL ON lograg.* TO 'lograg'@'127.0.0.1';
   GRANT ALL ON `lograg_test_%`.* TO 'lograg'@'127.0.0.1';  -- 测试建库用
   ```
3. `npx tsc --noEmit -p tsconfig.json`（必须 0 错误）
4. 跑测试（测试进程**不读 `.env`**，库连接要显式给）：
   ```bash
   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=lograg DB_PASSWORD=... \
     node --test --experimental-strip-types tests/*.test.ts
   ```
   当前 **33 个文件 / 386 项全绿**；每个测试文件自建独立库 `lograg_test_<hex>`，用完 DROP。
5. `npx tsx src/rag/build-cli.ts`（重建 `data/rag/index.db`）
   ⚠️ 索引易过期：新增知识文件后**必须重建**，否则新文件检索不到。
   校验方法：比对 `SELECT COUNT(DISTINCT source) FROM docs` 与
   `find knowledge -name '*.md' | wc -l`（当前 45 文件 / 431 分块）。
6. `npm run build && bash scripts/restart.sh`
   建表在启动时自动完成（`startServer()` 先跑迁移再监听）；失败会直接退出，
   不会带着半截 schema 对外服务。
7. 健康检查：`curl http://127.0.0.1:8788/health`

旧 SQLite 数据（领域知识 / 分析记录）用
`npx tsx scripts/migrate_sqlite_to_mariadb.ts --dry-run` 预演，去掉 `--dry-run` 执行；
幂等，可重跑。

## 3. 环境变量（只记名，不记值）

| 变量 | 说明 |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 自有 `lograg` 库（读写），会话/正文/追加段/分析记录/领域知识 |
| `LOGSHARE_DB_*` | 导入日志的只读库；主机/端口默认继承 `DB_HOST`/`DB_PORT`，未配置时走公网 API |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 模型供应商（本地为 `127.0.0.1:8765` + `hy4-preview-f`） |
| `GITHUB_TOKENS` | 逗号分隔的 GitHub PAT（轮询与限流冷却） |
| `LOGSHARE_ADMIN_TOKEN` | 线上 `api.logshare.cn` 管理接口（仅 `scripts/mine_*.py` 用） |
| `RAG_INDEX_PATH` | 索引路径，默认 `./data/rag/index.db` |
| `SPINYARN_SO` / `SPINYARN_MAPPINGS_DIR` / `SPINYARN_REDIS_URL` | 反混淆动态库与 mappings；任一项为空即禁用（fail-open） |
| `PORT` | 服务端口，本地用 8788 |

⚠️ **密钥处理**：GitHub PAT 与线上 admin token 已在聊天中明文出现过，**必须轮换**，
**禁止写入任何文件**（已全库确认未落盘）。恢复后重新提供。

## 4. 当前完成度

| 项 | 状态 |
|---|---|
| `src/` 46 个 TS 文件 | ✅ 类型检查通过 |
| `tests/` 33 个测试文件 | ✅ 386 项全绿（MariaDB 不可用时相关用例 skip） |
| `knowledge/` 45 个文件 | ✅ 索引 431 分块，文件数与索引一致 |
| `prompts/` 2 个 | ✅ |
| `scripts/` 16 个（含 `migrate_sqlite_to_mariadb.ts`） | ✅ |
| 存储 | ✅ MariaDB `lograg`（读写）+ `logshare`（只读） |
| 反混淆 | ✅ 本机已构建 `libspinyarn_capi.so` 并启用（见下） |
| 前端 `web/` | 用户自行开发，未提交 |

## 5. 待办（按优先级）

1. **反混淆**（已完成，留作复现步骤）：Rust 1.96（trixie-backports）+
   `cargo build --release -p spinyarn-capi`，产物
   `/home/YanSui/Project/SpinYarn/target/release/libspinyarn_capi.so`；
   mappings 复用 `/home/YanSui/LogShare/mappings`；`SPINYARN_REDIS_URL`
   与 LogShare 指向同一 Redis 即共用缓存。实测 2.3MB / 4 万行 0.67s。
2. **AI 供应商**：`.env` 指向 `127.0.0.1:8765`；本机该端口已监听，
   真实分析跑通（FCL 日志 99 分）。换机器时确认网关在跑。
3. **LogShare 导入路径**：本机已按 `LogShare/docker/mariadb-init.sql` 建好 `logshare` 库
   （账号 `logshare`），但 LogRAG+ 的 `LOGSHARE_DB_*` 未配置，目前导入日志仍走公网 API。
4. **Docker 部署**与 Admin 观测联动（设计文档 Phase 3–4）。

## 6. Plan 文档索引（`~/.opencode/plan/`）

| 文档 | 状态 |
|---|---|
| `LogRAG-plus-设计文档.md` | ✅ 主文档（独立产品定位） |
| `实测报告-真实日志.md` | ✅ 有效（27 份实测，准确率 93%） |
| `缺陷清单与修复方案.md` | ✅ 有效 |
| `低分样本分析与缺陷定位.md` | ✅ 有效（评分体系缺陷 + 3 个系统缺陷） |
| `生产日志挖掘报告.md` | ✅ 有效（axolotl 18.5%、JSON 配置 27% 等盲区） |
| `实测计划-真实日志.md` | ✅ 有效（方法） |
| `LogRAG-评估报告.md`、`LogRAG-plus-重写方案.md` | ⚠️ 已标注过时，不要据此决策 |
| `Plan.md`、`Technical-Report.md` | ℹ️ FDS.Skill，与本项目无关 |

## 7. 关键约束速查（详见 AGENTS.md）

- 知识库三维度权重：**游戏本体 / 加载器为主体，启动器特有为附属**；禁止按启动器分小节
- 知识库只放领域知识（签名/含义/触发/修复/置信度），方法论归 `prompts/`
- Node 只读 MariaDB（只读账号 `lograg_ro`），所有写入走 LogShare
- CPU 密集工具必须进 `worker_threads`（实测停顿 1423ms）
- 正则警惕：IPv4 脱敏会打坏四段式版本号（`21.1.0.40` → `**.**.**.**`），影响依赖分析
- 系统重启后先查文件更新再决定是否重派子代理（防并发覆盖）

## 8. 本仓库文档（`docs/`，上下文压缩后从这里读）

| 文档 | 内容 |
|---|---|
| `docs/measurements.md` | 全部实测数据：27 份日志清单、锚点对照、核验表、工具消耗、RAG/性能/仓库/生产/协议数据 |
| `docs/decisions.md` | 28 项用户决策与纠正（含根因一句话版） |
| `docs/test-assets.md` | 实测资产位置（SSE 数据、脚本、备份、服务进程、重跑命令） |
