# LogRAG+ 通宵开发任务书

> **本文件是本次自主工作的唯一指挥文件。**
> 上下文被压缩后，**第一件事就是读这个文件**，然后读 `HANDOFF.md`、`AGENTS.md`、`docs/measurements.md`。
> 最后更新：2026-10-17 02:0x（测试 225 项全绿；子代理仍在补知识库，索引待其停止后重建）

---

## 一、用户原始指令（逐字，2026-10-17 00:5x）

> 继续开发，对了我要去睡觉了，我给你开了自动批准权限模式，今晚你要做的目的如下：
> 开发 LogRAG+、去 LogShare 下载日志和分析记录，低分到改进高分的做典型，
> 同时还要推子代理或者你自己来大规模丰富知识库，
> LLM 的思维链里面很多在搜索之前会有一个预定目标的，你也可以基于这个方向来丰富知识库内容，
> 知识库内容不是特别嫌多，所以加油，
> 还有就是基于这些数据和知识库内容改进 LogRAG+ 软件本体、还有提示词链和提示词资产，
> 还有就是引入 LogAgent 的已知领域知识体系，并针对性优化这个功能，
> 还有就是现在的 LogRAG+ 的实现其实很极简，你不用抱着极简主义来开发的其实，加油吧！

## 二、目标拆解（7 项）

| # | 目标 | 判据（做到什么算完成） |
|---|---|---|
| G1 | **去 LogShare 下载日志和分析记录** | 本地有可离线挖掘的语料：日志正文 + 分析记录（含 CoT / 工具链） |
| G2 | **低分 → 高分的典型改造** | 挑出真实低分分析记录，重跑或改写为高分，固化为典型与回归用例 |
| G3 | **大规模丰富知识库** | 知识条目显著增长（启动时 27 文件 / 233 分块 → 现 **38 文件 / 374 分块**，仍在增长），且每一条都有生产数据依据 |
| G4 | **按「思维链预定搜索目标」方向补知识** | 从 CoT 里提取模型「动手前想搜什么」，反推知识缺口并补齐 |
| G5 | **改进软件本体 + 提示词链 + 提示词资产** | 代码与 `prompts/` 有实质演进，不抱极简主义 |
| G6 | **引入 LogAgent 已知领域知识体系并优化** | LogRAG+ 具备可运维的「已知领域知识」注入能力，比 LogShare 版本更好用 |
| G7 | **整体不受极简主义约束** | 该加的能力就加，不因「保持极简」而砍功能 |

## 三、关键资源（环境事实）

| 事项 | 值 |
|---|---|
| 项目根 | `/data/data/com.termux/files/home/Project/LogRAG-Plus` |
| 线上 SSH | `ssh logshare`（**服务器默认 shell 是 fish**：一律 `ssh logshare -- bash -c '...'`；复杂逻辑**必须**本地写脚本 → scp → 执行，嵌套引号必炸） |
| 线上目录 | `/home/YanSui/LogShare` |
| 容器 | `logshare-hyperf` / `logshare-nginx` / `logshare-redis` / `logshare-mariadb` / `logshare-acme` |
| **Redis 容器无 bash** | 必须用 `sh -c` |
| DB 凭据 | 容器内环境变量 `$MARIADB_ROOT_PASSWORD`（**不要打印到输出**） |
| 临时目录 | 系统 `/tmp` 只读 → 用 `/data/data/com.termux/files/usr/tmp/` |
| 本地模型 | `http://127.0.0.1:8765/v1`（**当前未启动**） |
| LogShare 本地 | `http://127.0.0.1:9501`（**当前未启动**） |
| LogRAG+ | `http://127.0.0.1:8788` |
| admin token | 环境变量传递，**严禁落盘**；用完提醒用户轮换 |

## 四、已探明的关键事实（2026-10-17 凌晨实测）

1. **线上磁盘**：`/dev/vda3` 59G，已用 34G，可用 26G。
2. **表体积**：`logs` 8709MB / 35366 行；`log_files` 5784MB / 21479 行；`log_metadata` 9MB / 64572 行。
3. **`logs` 表没有 `content` 列**——日志正文在 **`log_files.data`**。
4. **来源分布（全量）**：FCL 系列 ≈60%（1.3.3.9 7986、1.3.3.7 3832、1.3.2.2 2981…）、axolotl ≈19%（1.9.7 5598、1.9.8 1838）、ZL2 ≈5%（2.6.1 1017、2.7 901）。
5. **`/app/runtime/logs/ai_analyses.log` = 632MB**（分析记录全量归档，**含 CoT 与工具链**）→ G1/G2/G4 的主矿脉。
6. **`/app/runtime/domain_knowledge.json` = 2224 字节**（LogShare 的已知领域知识体系）→ G6 的直接素材。
7. **`/v1/raw/{id}`（无文件名）返回全部文件按 `===== 文件名 =====` 合并后的全文**，是分析所需的完整输入。
   `/v1/raw/{id}/main.log` 必然 404（日志里没有名为 `main.log` 的文件），`/v1/raw/{id}/{真实文件名}` 可用。
8. **线上有 WAF CC 限流**：短时间密集请求会被拦（实测 HTTP 000），批量取数**必须走 SSH**。
9. **`/v1/internal/log/{id}` 尚未实现**（404）；但公开 raw 已足够，内部端点非必需。

## 五、已完成（本次会话）

### G1 语料取回 ✅
线上数据已全量落到 `data/corpus/`（**只读分析用，`data/` 已 gitignore**）：
`analyses_compact.jsonl`(57.5MB / 9352 条分析记录)、`search_targets.jsonl`(17.3MB)、
`signatures.tsv`(16.3MB)、`sig_report.txt`、`target_freq.json`、`gaps.jsonl`、
`log_index.tsv`、`log_meta.tsv`、`domain_knowledge.json`、`stats_analyses.json`、`ai_metrics.json`。

### G4 签名挖掘 + 检索目标提取 ✅
- **签名挖掘**：6660 份 `latest.log` / 1227 万行 / **255997 种**规范签名 / 442s。
- **工具调用统计**（`target_freq.json`）：`grep_log_file` 18264 次（**空结果 41%**）、
  `read_log_file` 15698、`rag_search` 14623、`github_search` 6319（**空 63%**）、
  `web_search_exa` 4263（**报错 59%**）。
- **工具名幻觉** 93 次（`knowledge_search` 23、`list_topics` 31、`expert_knowledge` 3，
  以及 `Read_log_file` / `ggrep_log_file` / `greplog` 等近形变体）→ 解法是把**精确工具清单**
  动态写进提示词，而不是事后纠正。

### G2 评分体系复核 → 发现并修掉一个体系性缺陷 ✅
- **铁证**：全量「0 次工具调用 + 结论完整」的 253 条，`overall` **全部恰好 68**；
  「1–3 次工具调用 + 结论完整」的 1478 条均值 **93.3**。
  旧评分器的 `evidenceSufficiency` 是**工具调用次数的阶跃函数**（0→20、1→60、2→80、≥3→95），
  与答案质量无关——这是「高分 = 多调工具」的机械化倾向的根源。
- **另一处**：`fullAnswerSnippet` 在归档时被截断到 300 字（9197/9353 恰好 300），
  因此**不能用答案长度判断质量**。
- 低分（<80）851 条分类：`runaway_rounds` 255 / `correct_underrated` 254 / `other` 223 /
  `no_conclusion` 90 / `format_failure` 29。
- 产出 `data/corpus/score_review.{md,json}`、`score_deepdive.md`、`low_score_plan.{md,json}`。

### 新评分器与观测链路 ✅（本会话核心交付）
- `src/eval/anchors.ts`：证据锚点提取（引号串 / 标识符 / 文件名 / 版本号 / 异常名 /
  常量 / 路径）+ `verifyAnchors`（**按文本核对**，不再数工具调用）。
- `src/eval/scorer.ts`：四维 `grounding`(0.40) / `verification`(0.20) / `actionability`(0.25) /
  `economy`(0.15)；**零工具中性满分**；语料缺失时 `grounding` 返回 `null` 并从加权中剔除
  （「未采集」与「计数为零」必须可区分）；根因权重 2:1。
- `src/eval/records.ts`：分析记录落 **SQLite 结构化表**（不再是一个 600MB 的单文件归档），
  看板聚合从「读整个文件」变成一次索引扫描。
- `src/server/index.ts`：`/v1/admin/*` **统一前缀门禁**（一处鉴权覆盖全部子路由，
  新增端点不可能漏加）、`/v1/admin/records*` 观测接口、SSE `done` 帧下发自评分数与未命中锚点。

### G5 提示词资产按生产数据改造 ✅
- `prompts/retrieval-strategy.md`：新增**已验证有效的检索词表**（按故障族归并，全部取自
  生产实际命中过的检索词）、「检索无结果怎么判断」（三种成因三种对策）、
  `web_search` 不可靠（59%）的明确约束、**硬性停止判据**（针对 255 条轮次失控）。
- `prompts/output-spec.md`：结构化块列为**硬性交付物**（针对 90 条空结论 / 29 条格式失败）、
  `evidence` 必须**逐字可核对**（对应新评分器）、禁止把工具调用写成正文。

### G3/G6 知识库与领域知识 ✅
- 知识库 **27 → 38 文件 / 233 → 374 分块**。新增条目全部依据生产数据，
  含 `high-frequency-log-lines.md`（全站高频行哪些是噪音）、`mod-runtime-api-mismatch.md`、
  `opengl-framebuffer-failure.md`、`rendering-context-loss.md`、
  `native-symbol-resolution-failure.md`、`mod-jar-corruption.md`、
  `mod-config-timing-failure.md`、`mixin-namespace-mismatch.md`。
- 第二轮新增 **`cases/` 三个实战案例库**（`native-and-java.md`、`mixin-and-modconflict.md`、
  `world-config-server.md`，合计 1143 行）。与 `patterns/` 的分工：
  `patterns/` 是「单签名 → 单故障」的判据卡，`cases/` 是「多签名共现 → 现场判断」的实战串讲
  （典型日志片段 + 为什么这样判 + 与相邻故障怎么区分）。
  三份文件的 96 个引用 logId 被逐一抓回核对，**修掉 6 处事实错误**——这一步不是形式主义：
  其中「同形态共 4 份」的 2 份日志实际只有 VintageFix 正常加载、没有任何注入失败，
  若不核对就会把「装了 VintageFix」当成签名写进判据。
  另有两个**证伪结论**同样有价值：移动端存档/区块损坏（`session.lock`、`Chunk file at`、
  `Failed to load world`、`Address already in use`）在两轮各 685 份抽样中命中数为 0，
  条目改为显式证伪而非收录。
- **验证**：此前 11 个「检索必落空」的高频缺口词（`GL_FRAMEBUFFER_UNSUPPORTED`、
  `MultipleArgumentsForOptionException gameDir`、`IFakeIResourceManager`、
  `No context is current`、`Signature is missing from Property textures` …）**现已全部命中**。
- `src/knowledge/domain.ts`：领域知识 **注入 + 工具双通道**（原文拼入系统提示词受预算约束，
  同一批条目挂成 `expert_knowledge` 工具）；管理接口 fail-closed。
- `expert_knowledge` 工具进入 `LogAgent` 工具链（无启用条目不注册）。

### 子代理复核纠正的两处（值得记住）
1. **`libinstrument.so` 在 95.9% 的日志里出现，但不是故障**——那是 JVM 自身的
   `DLOPEN: loading …` 清单与 maps 转储。若按频次补知识条目，会造出一个覆盖率极高、
   指向完全错误方向的大条目。**高频率 ≠ 高价值**，这条已写进对应文件。
2. **约 527 次「空 `rag_search`」实为 `工具调用失败: MCP request failed: Connection timed out`**
   ——属基础设施问题，**不是知识缺口**。据此补知识条目是白费力气。
   这修正了我原先「rag_search 落空 4.5% 都是检索词问题」的推断。

### 工程质量
- 全量测试 **359 项全绿**（后端 342 / 30 个文件 + 前端 `web/tests/` 17 项）；
  `tsc --noEmit` 与 `vue-tsc --noEmit` 均 0 错误。
- **前端重做为 Nuxt 4 + Nuxt UI v4**（Pro 在 v4 已并入 MIT 免费）。配色沿用框架默认，
  只做排版：主题取「勘验卷宗」——层级靠发丝线与字阶，不用卡片与阴影。
  视觉对齐实测把字号从 **10 档收敛到 5 档**、圆角与卡片清零、修掉两处对比度不达标
  （行号 2.34:1、浅色主按钮 3.30:1），并把行长单位从 `ch` 改为 `em`
  （`68ch` 在中文下实际是 136 字宽，远超可读上限）。
  对比度已固化为 `web/tests/contrast.test.ts` 守门。详见 `docs/measurements.md` 第 14 节。
- **交互重构**：日志从「塞进消息的文本」变成「可被指认的文档」。新增
  `GET /v1/log/{id}`（只读、不计配额）与 `LogPane`（分节跳转 / 错误行跳转 /
  选行引用），结论改用 `EvidenceSpine` 脊柱而非卡片。补齐 16 项端点测试。
- **语义检索从脚手架变成真跑**：此前 `doc_embeddings` 表建了、配置读了，
  但**从不生成向量、也没有召回代码**，而 `semanticAvailable` 报的是配置值不是运行状态。
  现已接入 bge-m3（413 分块全量向量）与 bge-reranker-v2-m3，融合用 RRF，
  重排只作用于召回池前 20 条。实测「内存不够导致启动失败」→ `out-of-memory.md`、
  「两个模组版本不兼容」→ `mod-conflict.md`（纯词法均无法稳定命中）。
  同时保留一个诚实的反例：「手机上没有声音」在库里没有对应条目时，
  语义检索会把最近邻排上来且看起来同样自信——记录在 `docs/measurements.md` 13.2。
- **补上生产语料里两类未修的低分模式**（第 13 节）：
  ① 轮次失控（255 条）：连续 3 次同工具同参数判为打转，转收尾轮而非失败；
  ② 工具调用被写成正文（29 条）：输出侧确定性检测，命中即本轮流产重出。
  两者都由假模型端点回归守门，其中**回归测试当场抓出两个缺陷**
  （`mergeRuns` 丢失中止原因、假调用命中后没进收尾轮）。
- **修掉一条长期假绿的断言**：worker 隔离测试原先断言 `maxGap < 500`，测的是机器负载；
  改成「心跳次数」后仍可被同线程实现骗过（实测 10MB 扫描仅 148ms）。
  现用「让出宏任务后扫描是否仍未完成」，并**插入回归探针验证它确实会红**。
  详见 `docs/measurements.md` 第 12.4 节。
- 新增 `.env.example`（全部环境变量）与 `tests/env-example.test.ts`——
  守「文档写了但不生效」这类无报错缺陷（环境变量拼错不会报错，只会永远取默认值）。
- 修 `RAG_INDEX_PATH` 默认值为构建命令的输出路径（原先默认空串 →
  「构建成功」但「检索不可用」，两边各自正常、合起来静默失效）。
- **端到端真跑已打通一次**（`kalkLqQ`，259KB）：真跑 + 假模型端点回归共抓出
  **7 个链路缺陷**（4 个真跑暴露、3 个在修完之后由假端点回归抓出）。
  详见 `docs/measurements.md` 第 11 节——那一节是本会话最重要的产出，
  因为它记录的是「以为修好了其实没修好」的三个实例。
- 新增**假模型端点**回归（`tests/agent-loop.test.ts`）：起一个 OpenAI 兼容的
  SSE 假端点，把「模型说什么」变成可断言的数据，主循环从此可在 CI 里回归。
- **前端 `web/` 建成并跑通**：Vue 3 + Vite，对话页 + 管理页；产物由 Node
  托管在 `/logshare/` 下（`/logshare/{日志ID}` 深链可用，已实测 200）。
  新增 `tests/static-web.test.ts`（11 项）守静态托管与路径遍历；
  `web/tests/sse-client.test.ts`（12 项）用「按字节切块」的假服务端守 SSE 增量解析
  （含把 UTF-8 汉字切一半）。设计门控声明见 `web/README.md`。
- **首次以编译产物运行**（`npm run build && node dist/server.js`）即暴露
  **3 个只在编译路径上出现的缺陷**：`.env` 与 `web/dist` 的默认位置由
  `import.meta.url` 推算（编译后指向 `dist/` 下，静默回落 → 模型「未配置」、
  配额 1000/日 掉到 30/日、页面 404），以及 `npm start` 指向不存在的入口。
  三处路径基准已统一为工作目录，`tests/path-bases.test.ts` 分两层守门。
  详见 `docs/measurements.md` 第 12 节。

## 六、进行中 / 待办看板

### 进行中（**不要重派**）
- [x] cases 目录 5 个文件（`dependency-and-version`、`mixin-and-modconflict`、`native-and-java`、
      `renderer-and-shader`、`world-config-server`），patterns 24 个，没有再派发重复子代理。
- [x] **RAG 索引重建**：已按 **38 文件 / 374 分块**重建，并实测新签名 10/10 命中对应新文件
      （`Failed to dynamically load library: libc.so.6`、`Reference map ${refmap_target}refmap.json`、
      `Pack declares support for version newer than 64 … min_format and max_format` 等）。
      `getDb()` 有 mtime 变更检测，重建后**无需重启服务**。
      后续若再写知识文件，仍需重建：`npx tsx src/rag/build-cli.ts`。

### 待办
- [x] **G2 收尾**：12 条回归样本的 `expect` 全部填实（`category`/`keywords`/
      `evidence`/`must_not_contain`/`notes`），并加 `category_vocabulary` 词汇表约束；
      `tests/regression-cases.test.ts` 8 项守门（含**诊断依据必须能在窗口内找到**）。
- [x] `docs/measurements.md` 第 11 节（端到端真跑 + 7 个链路缺陷 + 假端点保真度要求）。
- [x] 移植线上 `domain_knowledge.json` 的 6 条：3 条事实入领域知识库（Mali/Vulkan、
      26.3 SDL3 渲染器兼容、Mojang 401 噪音），3 条方法论移入 `prompts/`
      （读全文阈值、移动端先查 Renderer、web_search 429 即放弃），
      尾句「提示用户降级或等正式版」作为输出口径进 `prompts/output-spec.md`。
- [x] `web/` 独立前端（对话页 + 管理页 + 自定义供应商配置）；产物由 Node 托管，
      `/logshare/{日志ID}` 入口已实测可用。
- [x] **Docker 编排（草稿，未经真机构建）**：`docker/Dockerfile`（四阶段：
      前端 / 编译 / 生产依赖 / 运行时）+ `docker/compose.yaml`（单服务、端口只绑回环、
      SQLite 命名卷 + 索引只读挂载）+ 根 `.dockerignore`（关键：排除 `.env`）。
      开发机无容器运行时，因此改用了**镜像内容集等价验证**（按 COPY 逐条复制目录后
      以容器内路径启动，见 `docs/measurements.md` 第 12.1 节）；
      Dockerfile 语法与层行为仍需在服务器上首次构建确认。
      反代（TLS / 域名 / WAF）刻意不写进本编排，交由既有 nginx 一层完成。
- [ ] **端到端复跑验证 7 个修复**：需先启动本地模型端点 `127.0.0.1:8765`
      （LogShare `127.0.0.1:9501` 未启动时走公网只读 `api.logshare.cn` 兜底）。
      跑法：`bash tmp/e2e-run.sh kalkLqQ`；界面侧可直接开
      `http://127.0.0.1:8788/logshare/kalkLqQ`（服务需已启动）。
- [ ] 前端补自定义供应商连通性探测（目前只在服务端那侧有）。
- [ ] 继续扩知识库（`data/corpus/search_targets.jsonl` 66 214 条检索目标尚未逐条读）。
- [ ] **提醒用户轮换 GitHub PAT 与线上 admin token**（已在会话中明文出现 3 次）。

## 七、恢复指引（压缩后照做）

1. 读本文件 → 读 `HANDOFF.md` → 读 `AGENTS.md` → 读 `docs/decisions.md`。
2. 看「六、进行中 / 待办看板」，从**第一项未完成**继续，不要重头再来。
3. **先检查子代理是否还在写**（`find knowledge -newermt '-30 minutes'`）。
   有人在写就不要动 `knowledge/` 与索引；等它停了再集中重建索引。
4. 改动后必跑：`node --test --experimental-strip-types tests/*.test.ts`
   （注意是 `tests/*.test.ts`，写成 `tests/` 会失败）与 `npx tsc --noEmit`。
5. 每完成一项就更新本文件看板——这是给压缩后的自己留的路标。

