# LogRAG+ 交接文档（压缩上下文后从这里恢复）

> 更新：2026-10-17。项目未提交过任何 commit（`git status` 全为 untracked）。
> 口径：`AGENTS.md` 是架构与决策的唯一来源；本文件只记录**状态与待办**。

## 1. 路径

| 内容 | 路径 |
|---|---|
| 本项目 | `/data/data/com.termux/files/home/Project/LogRAG-Plus` |
| 上游参考（只读） | `/data/data/com.termux/files/home/LogShare`（Node 不写它） |
| Plan/实测报告 | `/data/data/com.termux/files/home/.opencode/plan/` |
| 临时文件 | `/data/data/com.termux/files/usr/tmp/`（系统 `/tmp` 只读） |

## 2. 恢复步骤（按序）

1. `cd /data/data/com.termux/files/home/Project/LogRAG-Plus && npm install`
2. `npx tsc --noEmit -p tsconfig.json`（必须 0 错误）
3. `node --test --experimental-strip-types tests/*.test.ts`（当前 138 项全绿，见 §5）
4. `npx tsx src/rag/build-cli.ts`（重建 `data/rag/index.db`）
   ⚠️ 索引易过期：新增知识文件后**必须重建**，否则新文件检索不到。
   已实测过一次过期（磁盘 27 文件 / 索引仅 25）。校验方法：比对
   `SELECT COUNT(DISTINCT source) FROM docs` 与 `find knowledge -name '*.md' | wc -l`。
5. 启动服务（端口 8788，环境变量见 §3）：
   `AI_BASE_URL=... AI_MODEL=... AI_API_KEY=... RAG_INDEX_PATH=./data/rag/index.db GITHUB_TOKENS=... PORT=8788 npx tsx src/server.ts`
6. 健康检查：`curl http://127.0.0.1:8788/health`

## 3. 环境变量（只记名，不记值）

| 变量 | 说明 |
|---|---|
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 模型供应商（本地测试用 `127.0.0.1:8765` + `hy4-preview-f`） |
| `GITHUB_TOKENS` | 逗号分隔的 GitHub PAT（逗号分隔多 token 轮询） |
| `LOGSHARE_ADMIN_TOKEN` | 线上 `api.logshare.cn` 管理接口（仅 `scripts/mine_*.py`、`build_regression_set.py` 用） |
| `RAG_INDEX_PATH` | 索引路径，默认 `./data/rag/index.db` |
| `PORT` | 服务端口，本地用 8788 |

⚠️ **密钥处理**：GitHub PAT 与线上 admin token 已在聊天中明文出现过，**必须轮换**，
**禁止写入任何文件**（已全库确认未落盘）。恢复后重新提供。
包管理器用 **npm**（pnpm 在 Termux 上 `lock_shared() not supported`）。

## 4. 当前完成度

| 项 | 状态 |
|---|---|
| `src/` 29 个 TS 文件（config/agent/github/logshare/quota/rag/security/server/store/text） | ✅ 类型检查通过 |
| `tests/` 12 个测试文件 | ✅ 138 项全绿 |
| `knowledge/` **27 个文件**（patterns 16 / format 5 / ecosystem 2 / launcher 1 / server 1 / cases 2） | ✅ 守门测试通过 |
| `prompts/` 2 个（`retrieval-strategy.md`、`output-spec.md`） | ✅ |
| `scripts/` 10 个（含 `mine_cases.py`、`mine_analyses.py`、`build_regression_set.py`） | ✅ |
| `tests/fixtures/regression/`（`cases.json` 12 条 + `REVIEW.md` 待复核） | ⚠️ expect 字段待人工填写 |
| `data/rag/index.db`、`data/sessions.db` | 本地产物，不提交（索引现为 38 文件 / 374 分块） |

## 5. 待办（按优先级）

1. **知识库缺口**（两个子代理因模型限流中断，未完成）：
   - `knowledge/patterns/` 新建：`mixin-refmap-failure.md`、`forge-early-loading-failure.md`、`fabric-loader-failure.md`、`class-loading-failure.md`（加载器维度，生产占比 38%/38%/5%/19%）
   - `knowledge/cases/` 新建：`native-and-java.md`、`mixin-and-modconflict.md`、`world-config-server.md`（已有 `dependency-and-version.md`、`renderer-and-shader.md`）
   - 完成后跑守门测试 + 重建索引
2. **回归集复核**：按 `tests/fixtures/regression/REVIEW.md` 填写 expect，区分真缺陷/评分误判
3. **服务端点**：`src/server/index.ts` 尚未接入会话恢复（`getSession` 未使用）、配额 `consume` 尚未接线
4. **Docker 部署**、`web/` 独立前端、Admin 观测联动（见设计文档 Phase 3–4）

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
