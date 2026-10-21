# 实测数据总表（27 份真实移动端日志 + 性能/检索/生态验证）

> 数据来源：2026-10-15/16 两轮实测。原始 SSE 与解析结果在
> `/data/data/com.termux/files/usr/tmp/lstest/`（`sse/*.sse` + `*.json`）。
> 资产清单见 `docs/test-assets.md`。

## 1. 27 份日志清单（`LogShare/testlogs/`，共 5.5MB）

| 文件 | 字节 | 行数 | 类型 |
|---|---|---:|---|
| KBj3hBs.log | 1904819 | 17479 | FCL + NeoForge，内嵌 hs_err SIGSEGV |
| fcl-latest-2646648029949214115.log | 811901 | 7971 | FCL，hs_err |
| fcl-latest6910918790248022992.log | 574030 | 5443 | FCL，hs_err |
| latest_game (2).log | 521846 | 3999 | ZL2 壳 + crash-report |
| latest (1).log | 369910 | 2120 | 纯 MC 日志 + crash-report |
| latest_game(2).log | 208256 | 1380 | ZL2 壳 + crash-report |
| irzZ67E.log | 202787 | 1856 | FCL + crash-report |
| m7sI83t.log | 137941 | 1097 | ZL2 壳 + crash-report |
| latest_game(1) (1).log | 131884 | 1507 | ZL2 壳 + crash-report |
| fcl-latest6215063907665127896.log | 109077 | 1062 | FCL（Mixin/EMI 冲突） |
| latest_game (1).log | 101498 | 1262 | ZL2 壳 + crash-report |
| fcl-latest914166744511980005.log | 91567 | 863 | FCL + crash-report |
| fcl-latest4961249768255133275.log | 89643 | 923 | FCL + crash-report |
| latest.log | 51581 | 398 | 纯 MC 日志 |
| j0XjfZc.log.txt | 41159 | 398 | ZL2 壳 + mc 日志 |
| H9CClSE.log | 40305 | 436 | ZL2 壳（437 行） |
| latest_game (3).log | 33967 | 403 | FCL 壳 |
| latest_game.log | 29880 | 354 | ZL2 壳 + crash-report（SDL3 样本） |
| latest_game(1).log | 29091 | 285 | ZL2 壳 + hs_err |
| fcl-latest3479777069935313871.log | 28883 | 358 | FCL 壳 |
| GmcGNRk.log | 27864 | 270 | ZL2 壳（Fabric 缺前置） |
| latest_game(1)(1).log | 27814 | 281 | ZL2 壳 |
| fcl-latest-1068534404767446429.log | 23835 | 254 | FCL 壳 |
| fcl-latest7633585672783682562.log | 23775 | 307 | FCL 壳 |
| latest_jvm(1).log | 14521 | 161 | **ZL2 自身 JVM 崩溃** |
| latest_jvm.log | 11407 | 128 | **ZL2 自身 JVM 崩溃** |
| launcher_crash.log | 1129 | 26 | **Zalith 自身混淆栈** |

特殊形态：启动器壳内嵌 MC 日志、启动器自身 JVM 崩溃（与游戏无关）、混淆栈（R8，非 Yarn）、
中文/特殊字符路径（`[dspqle移植]起始点`、`魔女之旅新规整合包`）。

## 2. 窗口锚点：原实现 vs 修复

原实现（`LogWindowManager::findErrorAnchorLine`，首次匹配）：

| 文件 | 总行 | 锚点 | 命中模式 | 真崩溃 | 判定 |
|---|---:|---:|---|---|---:|
| KBj3hBs.log | 17480 | 556 | T1-8 异常类名 | 5290 | 错过 4734 |
| fcl-latest6910918790248022992.log | 5444 | 1746 | T1-8 | 287 | 错过 1459（锚点在崩溃之后） |
| latest (1).log | 2121 | 305 | T1-6 ERROR 标签 | 1742 | 错过 1437 |
| irzZ67E.log | 1857 | 334 | T1-6 | 1723 | 错过 1389 |
| latest_game (2).log | 4000 | 2415 | T1-6 | 3326 | 错过 911 |
| latest_game(1) (1).log | 1508 | 253 | T1-8 | 1150 | 错过 897 |
| latest_game(2).log | 1381 | 253 | T1-8 | 1079 | 错过 826 |
| latest_game (1).log | 1263 | 253 | T1-8 | 919 | 错过 666 |
| fcl-latest914166744511980005.log | 864 | 289 | T1-8 | 756 | 错过 467 |
| fcl-latest4961249768255133275.log | 924 | 404 | T1-6 | 727 | 错过 323 |
| m7sI83t.log | 1098 | 669 | T1-6 | 811 | 错过 142 |
| fcl-latest-2646648029949214115.log | 7972 | 271 | T1-6 | 370 | 错过 99 |
| latest_game(1).log | 286 | 221 | T1-8 | 266 | OK |
| latest_game.log | 355 | 206 | T1-8 | 239 | OK |
| launcher_crash.log | 27 | 无 | — | 1 | 未定位 |

含真崩溃标记的日志：覆盖 2 / 错过 12 / 未定位 1 → **错过率 86%**。
命中模式统计：T1-6（ERROR 标签）15 次、T1-8（异常类名）10 次。

**误命中的无害告警原文**（模型思维链证实被误导）：
- `[Lightload] Runtime transformer patch unavailable; ... Cannot run program`（KBj3hBs:556，正常降级）
- `Couldn't leave fullscreen: That operation is not supported`（fcl-264:271）
- `FML appears to be missing any signature data`（irzZ67E:334，Forge 每次启动都有）
- 模型原话：「There's an error at line 556 apparently... But the actual crash likely further down.」

**修复后**（结构性标记绝对优先）：覆盖 **19/19，错过 0**。

## 3. 准确率核验（逐份对照原始日志）

| 文件 | 模型根因 | 核验 |
|---|---|---|
| GmcGNRk | `forgeconfigapiport` 缺失 | ✅ `HARD_DEP_NO_CANDIDATE touhou_little_maid {depends forgeconfigapiport}` |
| H9CClSE | LWJGL 原生库缺失→GLFW 初始化失败 | ✅ `Could not initialize class org.lwjgl.glfw.GLFW` |
| KBj3hBs | MG `glBindTextureUnit` Mali-G720 段错误 | ✅ SIGSEGV @`libmobileglues.so+0x593060 glBindTextureUnit+0x54` |
| fcl-264… | `-Xmx15231m` 耗尽→`libbinder.so` SIGSEGV | ✅ 三要素全对应 |
| fcl-347… | `sophisticatedcore` 等前置缺失 | ✅ `HARD_DEP_NO_CANDIDATE sophisticatedbackpacks` |
| fcl-496… | Iris 纹理单元越界 128 | ✅ `ArrayIndexOutOfBoundsException: Index 128 out of bounds for length 128` @`CompositeRenderer.renderAll` |
| fcl-621… | — | ❌ **正文 0 字**（流截断，思维链 71573 字有结论） |
| fcl-691… | JRE 17 麒麟 SIGILL | ⚠️ 未独立核实（0.72） |
| fcl-763… | `pehkui`/`satin`/`geckolib` 缺失 | ✅ `Fix: add [add:pehkui 3.7.8...]` |
| fcl-914… | SRPExtra/SRParasites 分支不匹配 | ✅ `NoClassDefFoundError: EntityCrux` |
| irzZ67E | PixelmonBroadcasts 二进制不兼容 | ✅ `NoSuchFieldError: legendaries` |
| j0XjfZc | LWJGL 原生库缺失 | ✅ `Failed to load a library` + `Could not initialize org.lwjgl.system.Library` |
| latest.log | LLibrary 前置缺失 | ✅ `RuntimePatcher` 找不到 |
| latest (1) | Ponderer/JEI mixin 注入点不匹配 | ✅ Ponderer 1.10.6.1 存在 |
| latest_game (1) | Voxy 加载 glibc `libc.so.6` | ✅ `UnsatisfiedLinkError: libc.so.6` @`voxy.ThreadUtils.<clinit>` |
| fcl-106… | JPMS `ResolutionException` | ✅ `Modules lwjgl and org.lwjgl.sdl export package org.lwjgl.sdl` |

**准确率 94%（15/16），失败 1 份为空结果。** 最终 27 份口径：正确 25 / 空 1 / 未核实 1（93%）。

## 4. 工具消耗（27 份合计 337 次）

| 工具 | 次数 | 占比 | 说明 |
|---|---:|---:|---|
| `grep_log_file` | 86 | 26% | 弥补窗口缺陷的盲目搜索 |
| `read_log_file` | 66 | 20% | 同上 |
| `github_search` | 47 | 14% | 多次因仓库名错/404 失败 |
| `web_search_exa` | 47 | 14% | GitHub 失败后的兜底 |
| `rag_search` | 42 | 12% | 命中率良好 |
| `list_log_files` | 22 | 7% | 每份必调 |
| `github_list_repos` | 9 | 3% | 很少主动查 |
| `github_get_content` | 8 | 2% | 前置检索失败，无条目可读 |

平均 12.5 次/份、思维链 15584 字/份；最高 `latest_game (2).log` 29 次（22 次 grep/read）。
置信度均值 0.86（最低 0.62 为正确判断+谨慎标注，非缺陷）；无样本触及 50 轮上限。

## 5. RAG 验证数据

索引：114 chunk / 36 文件（patterns 55 / mobile_launcher 11 / android-native-lib 12 /
format 12 / 日志分析 17×1）。`日志分析/` 17 文件各仅 1 chunk（无 `##` 结构）。

同源重叠（k=5，同一问题换关键词）：Mixin 58%、Java 版本 50%、渲染器 27%、内存 25%、
缺前置 20%，**合计 38%**。`rag_search("Mixin")` 5 条全来自 `mixin-apply-failed.md`。

提示词示例错误：`rag_search("MixinApplyError")` → **0 条**（正文无此词，只有
`MixinTransformerError`/`InjectionError`）；`MixinTransformerError` → 2 条。

embedding 降级：词法+向量 paraphrase 93.3% → **纯词法 7%**，signature 保持 100%。
金标集（30 条）hit@5 96.7% 是误导性指标（`expect` 为可接受集合，命中任一即算中，
且平均仅 1.20 个不同来源）。

## 6. 性能基准

| 测试 | PHP | Node 24 |
|---|---|---|
| 读 10MB 文件 | 8ms | 58ms |
| 单次 grep（90395 行） | 624ms | **57ms** |
| grep ×30 | 20544ms | **1302ms** |
| 峰值内存 | 58MB | — |
| **事件循环最大停顿** | — | **1423ms**（必须 worker 隔离） |

DeepAgents 全栈：`node_modules` 137MB / 66 包；导入 3.8s，RSS 169MB。
`node:sqlite` = SQLite 3.53.0，与 PHP `pdo_sqlite` 一致（FTS5/`bm25()`/BLOB 全兼容）。

## 7. 生态仓库核验（GitHub API 逐个）

| 白名单仓库 | 结果 | 修正为 |
|---|---|---|
| `FCL-Team/FoldCraftLauncher` | ✓ 活跃（4934★，2026-10-15） | — |
| `HMCL-dev/HMCL` | ✓ 活跃（10239★，2026-10-14） | — |
| `PojavLauncherTeam/PojavLauncher` | ⚠ 已归档（9431★，2025-09-23） | `MojoLauncher/MojoLauncher`（1031★） |
| `Amethyst-Launcher/Amethyst` | ✗ 404 | `AngelAuraMC/Amethyst-Android`（2290★） |
| `Glow-Worm-Project/PojavLauncher-Glow-Worm` | ✗ 404 | `Vera-Firefly/Pojav-Glow-Worm`（358★） |
| `sparrow-app/MobileGlues` | ✗ 404（服务端实录 422） | `MobileGL-Dev/MobileGlues-release`（1366★，227 issues） |
| （缺失） | — | `ZalithLauncher/ZalithLauncher2`（2029★，105 issues，活跃） |

`ZalithLauncher/ZalithLauncher`（1750★）已归档。`MobileGL-Dev/MobileGlues`（215★）为源码仓。
**Amethyst = AAMC（AngelAuraMC），不是 Mojo。**

关键条目：ZalithLauncher2 **PR #1721**（SDL3 支持，2026-08-28 合并，Close #1693/#1668/#1655/#1619/#1618/#1616/#378）；
`#2071` 正文含 `logshare.cn/4im4IdX`（本站真实用户）。
MobileGlues #439（`glBindTexture`，open）、#469（`glGetString` SIGSEGV Mali-G57，open）、#474（Adreno/MediaTek，open）。
Mojo #51、#674 均为 closed。

## 8. 生产数据（logshare.cn，2026-10-15/16）

**来源（7 天 34624 份）**：FCL ≈60%、**axolotl ≈18.5%**、ZL2 ≈7.6%。
**版本**：1.20.1 29.2%、26.3 22.8%、1.21.11 18.7%、1.21.1 15.2%。
**加载器**：Fabric 35% / Vanilla 26% / Forge 26% / NeoForge 12%。
**分析记录**：1571 份；看板 overall 91.7 / 工具 76.7 / 证据 91.3 / 明确 99.7；
低分 6（0.4%）；平均 12.03s、4.4 轮；deep 1570 / launcher 0 / quick 1。

失败签名（抽样 100 份）：class-not-found 51%、crash-report 43%、**mixin target-not-found 32%**、
null-pointer 22%、**datapack 19%**、auth401 18%、sigsegv-mobileglues 16%、hs-err 12%、
shader-compile 10%、sigill 9%、failed-to-load-library 8%、sigbus 8%、hard-dep 8%、
no-such-method 7%、adreno 7%、ULerror 7%、apply-error 6%、cant-keep-up 5%、sdl 各 4%。

补充挖掘：JSON/配置损坏 **27%**（EOF 8 / JsonSyntax 12 / MalformedJson 9 / JsonReader 13）、
ForkJoinPool 外层壳 **35%**、axolotl 日志 `===== launcher_log.txt =====` 三段式前缀。

## 9. 模型与协议实测

- 本地模型 `hy4-preview-f`：流式工具调用（含增量 arguments）+ `reasoning_content` 均可用
- 本地端点**忽略 `stream:false`，始终返回 SSE** → LangChain 必须 `streaming:true`（见 `src/agent/model.ts`）
- DeepAgents 流：`tool_calls`（args 常为占位 `{}`）+ `tool_call_chunks`（真实 args 分片，**后续分片无 id 只有 index**，
  且 index 跨轮次重用）→ 以 index 累积 + id 反查 + 轮次结束清空
- 内置文件系统工具会泄漏（模型曾调 `glob` 找知识库文件）→ 仅保留 `read_file`+`ls`（框架强制要求 `read_file`）
- SSE 协议：`event: status`（thinking/tool/tool_result/limit）+ 无 event 的 `data.choices[0].delta.content` + `event: done/error`
- `SseParser::isDone()` 存在但 LogShare 的 `AIClient` 从未调用 → 截断被当成功（本项目 runner 已校验）
- `AnalysisScorer::evidenceSufficiency` = 纯工具调用次数映射（0→20/1→55/2→75），简单问题被系统性低估
- 200 条记录：rootCause 空 23 条（12%）；`KUetpQq` 答案泄漏 `[system: empty tool message processed, continue]`
- 硅基流动：`BAAI/bge-m3` 与 `bge-reranker-v2-m3` 是免费档，但该 key 所有模型调用均 `30001`（账号层限制，非模型定价）

## 10. 全量生产语料挖掘（2026-10-17 凌晨，本次会话）

### 语料规模
从线上取回并离线挖掘的语料存放在 `data/corpus/`（`data/` 已 gitignore）：

| 文件 | 规模 | 说明 |
|---|---|---|
| `analyses_compact.jsonl` | **9353 条**分析记录 | 含 CoT 与工具链 |
| `search_targets.jsonl` | **66214 行** | 每次工具调用前的「预定搜索目标」 |
| `signatures.tsv` | **96283** 种签名（count ≥ 3） | 见于 `sig_report.txt` |
| `sig_report.txt` | Top 300 签名 | 含来源分布与样例 logid |

**签名挖掘**：6660 份 `latest.log` / **1227 万行** / **255997 种**规范签名 / 耗时 442s。
（`signatures.tsv` 收录 count ≥ 3 的 96283 种；全量 255997 种含大量只出现 1–2 次的。）

### 工具调用的实际效果（这是提示词改造的直接依据）

| 工具 | 调用次数 | 空结果 / 报错 | 落空率 |
|---|---|---|---|
| `grep_log_file` | 18264 | 7521 | **41%** |
| `read_log_file` | 15698 | 1 | 0.006% |
| `rag_search` | 14623 | ~660 | **4.5%** |
| `list_log_files` | 8672 | 2 | 0.02% |
| `github_search` | 6319 | 3955 | **63%** |
| `web_search_exa` | 4263 | 2530 | **59%** |

**结论**：`read_log_file` 与 `rag_search` 几乎不落空，`grep` / `github_search` /
`web_search` 大量落空。落空的主要成因不是「检索词不够多」，而是**反复换措辞重试**——
因此提示词的方向是「限制重试次数、强制换方向」，不是「鼓励多检索」。

**工具名幻觉 93 次**：`knowledge_search` 23、`list_topics` 31、`expert_knowledge` 3，
以及 `Read_log_file` / `ggrep_log_file` / `grep_log_log` / `greplog` / `gread_log_file` 等近形变体。
→ 解法是把**精确工具清单动态写进系统提示词**（`PromptContext.toolNames`）。

### 评分体系的体系性缺陷（铁证）

旧评分器的 `evidenceSufficiency` 是**工具调用次数的阶跃函数**（0→20、1→60、2→80、≥3→95）。

| 样本 | 条数 | overall |
|---|---|---|
| 0 次工具调用 + 结论完整 | **253** | **全部恰好 68**（无例外） |
| 1–3 次工具调用 + 结论完整 | 1478 | 均值 **93.3** |

即：`overall` 的差异几乎完全由「调了几次工具」决定，与答案质量无关。

另有两处口径缺陷：

- `fullAnswerSnippet` 在归档时被**截断到 300 字**（9197/9353 恰好 300），
  故**不能用答案长度判断质量**。
- 319 条零工具记录 `rounds` 恒为 1，其中包含正确答案（32 位 JVM 堆申请失败、
  Loader 0.19.3 < 0.19.5 硬依赖）——说明「零工具」不等于「没分析」。

**低分（<80）851 条（9.1%）分类**：`runaway_rounds` 255 / `correct_underrated` 254 /
`other` 223 / `no_conclusion` 90 / `format_failure` 29。

### 新评分器（`src/eval/scorer.ts`）实测口径
四维加权：`grounding` 0.40 / `verification` 0.20 / `actionability` 0.25 / `economy` 0.15。
- **零工具 + 完整结论**：中性满分（≥85），不再被系统性低估。
- **证据核对**：从 `rootCause` 与 `evidence` 提取锚点（引号串 / 标识符 / 文件名 / 版本号 /
  异常名 / 常量 / 路径），回日志正文与工具结果中查找，按找到比例给分；根因权重 2:1。
- **语料缺失**（独立问答、无日志）：`grounding` 返回 `null` 并从加权中剔除，
  而不是记 0——「未采集」与「计数为零」必须可区分。
- 一个调用**同时**命中「失败」与「空结果」时只计失败（否则两类问题的比例失真）。

### 知识缺口闭合验证
改造前，以下高频检索词在知识库中**一个都搜不到**；改造后**全部命中**：

```
GL_FRAMEBUFFER_UNSUPPORTED            → ecosystem/renderer-compat.md
zip END header not found              → patterns/mod-jar-corruption.md
MultipleArgumentsForOptionException   → patterns/mod-runtime-api-mismatch.md
Cannot get config value before ...     → patterns/mod-config-timing-failure.md
IFakeIResourceManager NoClassDefFound → patterns/mod-runtime-api-mismatch.md
Signature is missing from Property... → patterns/high-frequency-log-lines.md
CachedBlockTags Invalid tag list      → patterns/high-frequency-log-lines.md
No context is current                 → patterns/mod-runtime-api-mismatch.md
AppClassLoader cannot be cast ...      → patterns/mod-runtime-api-mismatch.md
Not a JSON Object                      → patterns/mod-runtime-api-mismatch.md
clearFrameRate NoSuchMethodError       → patterns/mod-runtime-api-mismatch.md
```

### 最高频签名（全站 Top 7，均为「看起来像错误」的常见行）
8957 `NullPointerException: Cannot invoke "com.majruszlibrary.modhelper.Resource.load"` /
8684 `Signature is missing from Property textures` /
6826 `[MixinHelper] Failed to get field MixinConfig.server: server` /
6034 `createlazytick BlockEntity is not a SmartBlockEntityControl!` /
5220×2 `CachedBlockTags#match(State): Invalid tag list 'tweakeroo:pickaxe_override'` /
4272×2 `Could not decode blockstate, attempting fixes` /
3953 `Initializing MixinExtras via ...`。
→ 这些「最显眼的报错」绝大多数与崩溃无关，是模型误判根因的主要来源，
已收录进 `knowledge/patterns/high-frequency-log-lines.md`。

### 一处与「构建/检索」相关的静默缺陷
`RAG_INDEX_PATH` 原默认值为空串，而构建命令输出到 `./data/rag/index.db`。
结果是：构建报告「索引构建完成」，检索返回「索引不可用」——**两边各自都正常**。
已把默认值改成与构建输出一致，并加 `tests/env-example.test.ts` 守环境变量文档一致性。

### 旧评分的敏感度错配（`npx tsx scripts/rescore_corpus.ts`，n=9353）

按「工具调用次数」分桶对照（证据分与 overall 均为**线上真实评分**）：

| 工具数 | 条数 | 旧 overall | 旧证据分 | 硬标识锚点 | 证据条数 | 平均轮次 |
|---|---|---|---|---|---|---|
| 0 | 319 | 66.5 | 20.0 | 5.7 | 3.0 | 1.0 |
| 1–3 | 1592 | 92.5 | **84.0** | 7.7 | 4.0 | 2.6 |
| 4–6 | 2439 | **94.7** | 95.0 | 9.8 | 4.7 | 4.1 |
| 7+ | 5003 | 88.2 | 95.0 | 10.3 | 4.9 | 7.6 |

**判定（敏感度错配）**：从「0 次工具」到「1–3 次工具」，旧证据分放大 **4.2 倍**，
而结论里可核对的硬标识只增加到 **1.35 倍**。0 次工具组平均仍有 5.7 个硬标识
（异常类名、文件名、版本号）与 3.0 条证据，旧口径却把证据分压到 20/100——
它们被系统性地当成了「没有证据」。

**一个反直觉的附带发现**：7+ 组（5003 条）的 overall **88.2 低于** 4–6 组的 94.7，
而两组的旧证据分都是 95——扣分来自轮次本身，对应 255 条 `runaway_rounds`。
这从数据侧印证了「多搜不等于更好」，是提示词「硬性停止判据」的依据。

**口径声明**：`fullAnswer` 归档时被截断到 300 字（实测 p50 = p90 = max = 300），
且本地没有 8.7GB 日志正文，因此**未做完整重评**——那会得到漂亮数字但量的是残片。
上表只用未被截断的 `structuredOutput`（`rootCause` + `evidence`）与 `toolCallChain`，
属能站住脚的那一半。完整重评需要日志正文，待端到端环境就绪后补做。

### 子代理抽样复核纠正的两处（口径与判据）

子代理各自独立抽样（536 份 / 800 份真实日志）复核，纠正了两处我原先的判断。
两处都属于「按频次补知识」会走错方向的坑，记录在此。

**一、`libinstrument.so` 出现在 95.9% 的日志里，但它不是故障。**
那是 JVM 自身的 `DLOPEN: loading …` 清单与 maps 转储。按频次补条目会造出一个
覆盖率极高、指向完全错误方向的大条目。→ **高频率 ≠ 高价值**，必须看它是不是异常输出。

**二、约 527 次「空 `rag_search`」实为 `工具调用失败: MCP request failed: Connection timed out`。**
属**基础设施问题，不是知识缺口**。这修正了我原先「`rag_search` 落空 4.5% 都是检索词问题」
的推断——其中相当一部分是工具根本没调通。

**博彩性频次差异说明**：两路子代理的计数单位不同（「日志份数」vs「分析记录命中数」），
因此同一签名的数字可差一个量级（如 `zip END header not found`：7 篇 vs 141 条记录）。
两者都在各自文件里标注了分母，**不混用两套口径**。

### 知识库规模变化
启动时 27 文件 / 233 分块 → 本会话末 **38 文件 / 374 分块**
（patterns 21→24、cases 2→5、ecosystem 2、format 5、launcher 1、server 1）。
新增条目的数据依据来自签名挖掘与本文件第 10 节，非泛泛而谈的百科式内容。

**第二轮（cases 三份实战库）的抽样方法学教训**：`GET /v1/admin/logs` 是
`ORDER BY created DESC` 且 `created` 为秒级精度，同秒记录多 ⇒ `LIMIT/OFFSET`
分页会漂移——同一查询两次返回的 700 个 logId 只有约 **1/4 重合**。
因此任何绝对份数都只是「某一批抽样」的观测值，知识条目里的频次必须写成量级
或给出可逐日志复算的例证（如「`H7Oey7r` 内 57 次」），否则无法复核。
这条与「出现频率高 ≠ 有价值」是同一类问题的两个面：**分母不牢，分子就没有意义**。

**一条反例值得记住**：子代理在 800 份样本中实测 `GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`
命中 **0 篇**，因此**没有**把它写进 Signature 行（尽管分析记录里有 31 条命中）。
这是正确的克制——Signature 是给检索匹配用的，写进去只会造成误命中。

---

## 11. 端到端真跑与链路缺陷（2026-10-17 白天，本地模型端点 8765）

### 11.1 第一次真跑：`kalkLqQ`（axolotl 服务端日志，259KB）

| 指标 | 实测值 |
|---|---|
| 耗时 | 3 分 11 秒 |
| SSE 体积 | 56 579 字节 |
| 事件数 | 288 个 `status`（257 thinking / 16 tool / 14 tool_result / 1 limit）+ 1 `done` |
| **交付结果** | **0 字答案、自评 23 分、却报 `completed`** |

最后一行是本次会话最有价值的一条数据：**它证明了「空答案伪装成功」比直接报错更糟**。
报错会让人重试，`completed` 会让人以为「这份日志没问题」。

### 11.2 真跑暴露的四个缺陷

| # | 缺陷 | 根因 | 后果 | 修复 |
|---|---|---|---|---|
| 1 | `fetchLog` 被 `cfg.enabled` 一刀切挡死 | `enabled` 只表示「内网联动」，却兼作了「能不能读日志」 | 公网兜底代码**永不生效**，独立运行模式废掉 | `logshare.canRead` / `canUpload` 与 `enabled` 解耦 |
| 2 | 轮次按**两倍**计数 | 计数同时写在宣告函数内部与三个调用点 | `maxRounds: 30` 实际只允许 15 次调用 | 计数单点收敛进 `ToolCallTracker.count` |
| 3 | 撞顶即空输出 | `break` 后带着空正文按 `ok: true` 返回 | 30 轮成果整体丢弃 | 空正文**无条件**失败 + `runSynthesis` 收尾轮 |
| 4 | `tool` 帧参数恒为 `{}` | 分片路径在 `tool_calls` 占位 `args: {}` 时提前宣告 | 16 次调用全部无参数，前端看不到任何检索词 | 见 11.3（a）——**第一次修复并未修好** |

### 11.3 用假模型端点做回归：又抓出三个缺陷

真模型不可用于 CI（要钱、要网络、输出不确定），但这条链路的**触发条件是确定的**：
只要按 OpenAI 兼容协议下发分片的 `tool_calls`，四种情形都能复现。于是起一个假
端点（`tests/agent-loop.test.ts`），把「模型说什么」变成数据。

**修完 11.2 的四个缺陷后、在假端点上重跑，仍有三个缺陷**——这说明
「以为修好了」这件事本身不可信，必须让链路可复现。

**（a）占位值污染分片累积缓冲区（缺陷 4 的真根因）**

```
chunk 1: tool_calls:[{name:'grep_log_file', args:{}, id:'call_1'}]   ← {} 是占位
          同时 tool_call_chunks:[{name, args:'', index:0}]
整个链路实测的累积结果：
  argsRaw = "{}{"query":"ERROR","context_lines":1}"   ← 永不可解析
```

第 1 个分片同时带来 `tool_calls[0].args = {}` 时，旧代码把它写进了 `argsRaw`，
后续分片只能往后追加。**症状与修复前完全一样**（每次调用都显示空参数），
所以只看真跑输出会误判为「已经修好」。修复：分片路径接管时不得写入占位空对象。

**（b）撞顶 `break` 之后底层图并没有停**

实测请求序列（`maxRounds: 3`）：

| 请求 | 内容 | 说明 |
|---|---|---|
| 1–3 | 工具调用 → 工具执行 | 正常 |
| 4 | 工具调用宣告 → 撞顶 `break` | 我们以为结束了 |
| **5** | **完整工具清单 + 全部历史，无人消费** | 图还在跑，**白烧一次最贵的调用** |
| 6 | 收尾轮 | 真正交付答案的那一次 |

修复：主循环挂 `AbortController`，`break`/断开/抛错三条路径都在 `finally` 里中止。

**（c）收尾轮并非「无工具」**

`middleware: []` 只撤掉了我们自己那层 filesystem 中间件，`createDeepAgent`
会把**内置中间件装回来**。收尾轮请求体实测携带：

```
ls, read_file, write_file, edit_file, delete, glob, grep, task
```

也就是说提示词里那句「工具通道已关闭」对模型是**假话**：它能继续写文件，
更能调 `task` 拉起一个子 agent 把整个分析重跑一遍。修复：收尾轮**完全不进 agent 图**，
直接一次 `model.stream()`（它本来就只是「固定输入 → 一段文字」）。

### 11.4 假端点的保真度要求（踩过一次，值得单记）

`completion` 的 **`id` 必须每个响应都不同**。LangChain 把它当作 `AIMessage.id`，
而 LangGraph 的消息归约是**按 id 就地覆盖**而非追加。假端点固定复用同一个 id 时，
第 2 轮的 AI 消息覆盖掉第 1 轮那条、状态末尾仍是上一条 `ToolMessage`，
条件边据此判定「没有工具调用」而直接结束。

表现为「agent 跑了 2 轮就无声停止」，**极易被误读成 agent 自身的 bug**——
排查花了三次探针（`messages` / `invoke` 对照 / `updates`）才定位。
真实 OpenAI 兼容端点每次都返回唯一 id，所以这是**假端点的保真度要求**。

### 11.5 锚点定位缺陷（回归样本 `gtNpaS6`）

Forge 的强制依赖不满足是这样打的，**没有堆栈、没有 `Caused by`、没有 crash-report**：

```
[18:53:49] [main/ERROR]: Missing or unsupported mandatory dependencies:
    Mod ID: 'cloth_config', Requested by: 'spatial_gui',
    Expected range: '[11.0.0,)', Actual version: '[MISSING]'
```

三个 Tier 全不命中 → 23KB 日志被降级为「概况 + 检索指引」，模型一行正文都看不到。
新增 8 个**装载器中止类**结构性标记（forge / fabric 的依赖、解析、入口点、启动崩溃）。

**同时纠正我自己的一个误判**：同一条日志里 4 行 `is missing mods.toml` 是
**Forge 自身库文件**（fmlcore / javafmllanguage / lowcodelanguage）的正常告警，
属无害噪音，不是根因。这是本项目**第二次**踩「高频率 ≠ 高价值」——
第一次是 `libinstrument.so`（95.9% 日志都有，但那是 JVM 自身转储）。

### 11.6 覆盖率变化

| 阶段 | 测试数 | 说明 |
|---|---:|---|
| 本会话初 | 262 | |
| 补 `anchor.ts` / `window.ts` 专项 | 275 | 这两个模块此前**零测试**，只有注释里的「27 份日志人工验证」 |
| 补 agent 主循环假端点集成 | 280 | 撞顶出结论 / 参数 / 收尾失败 / 截断重试 / 未撞顶不extra |
| 补 tracker 占位污染 | 283 | |
| 其余（上传校验等）| 292 | 全绿；`tsc --noEmit` 0 错误 |

## 12. 编译产物首跑暴露的两个缺陷（2026-10-17 下午）

前 11 节的所有验证都在 `tsx src/server.ts` 这条路径上做的——**那是一条与生产不同的路径**。
直到要写 Dockerfile 才第一次执行 `npm run build && node dist/server.js`，
随即一次暴露两个缺陷，性质完全相同：

| 缺陷 | 源码/`tsx` 下的表现 | 编译到 `dist/src/` 后 | 后果 |
|---|---|---|---|
| `.env` 位置由 `import.meta.url` 推算 | `../.env` = `<root>/.env` ✅ | `../.env` = `dist/.env`（不存在） | **配置全部回落默认值**：默认模型「未配置」、配额 1000/日 → 30/日 |
| `web/dist` 位置同上 | `<root>/web/dist` ✅ | `dist/web/dist`（不存在） | 页面 404，接口全正常 |
| `npm start` 指向 `dist/server.js` | — | 实际产物在 `dist/src/server.js` | `npm start` 直接失败 |

**为什么这类缺陷危险**：三者**都不报错**。服务照常启动、`/health` 照常 200、
接口照常可用；只有「默认模型」变成一行不显眼的「(未配置)」、
「配额」悄悄掉到 30/日、「页面」变成 404。若直接上容器，
线上会以「模型没配」的形式表现出来，而人第一反应是去查 API key——
**排查方向从第一步就错了**。

**修法与守门**：三处路径基准统一为**工作目录**（与 `DATA_DIR=./data`、
`PROMPTS_DIR=./prompts` 一致），即「从项目根启动」；构建改用
`tsconfig.build.json`（rootDir=src），产物入口回到 `dist/server.js`。
`tests/path-bases.test.ts` 分两层守：断言值落在工作目录下，
并断言 `config.ts` / `static.ts` 里**不得出现由 `import.meta.url` 推算的路径**——
第二层是必须的，因为第一层在源码直跑下对错误实现同样成立（两者都等于 `<root>/…`）。

### 12.1 镜像内容集的等价验证（无 Docker 时的替代手段）

开发机没有容器运行时，无法构建镜像，也无法执行 compose。但「镜像里必须有哪些文件」
这件事可以在本地等价验证：按 Dockerfile 的 COPY 指令**逐条复制出一个目录**，
再以容器内相同的环境变量（`DATA_DIR` / `WEB_DIR` / `RAG_INDEX_PATH` 全为容器绝对路径）
从该目录启动。实测结果：

| 检查项 | 结果 |
|---|---|
| 启动横幅 | 前端页面路径正确识别 |
| `GET /health` | `rag 374 分块 / 38 文件` |
| `GET /logshare/` 与 `/logshare/kalkLqQ` | 200 / 200 |
| `GET /logshare/assets/*.css` | 200 |
| SQLite 可写（`$DATA_DIR`） | 生成 `app.db` + WAL |
| `POST /v1/chat`（无 AI key） | **503 + 可解释文案**，不是 500 |

这一步能覆盖「镜像缺文件」这类缺陷，覆盖不到的只有 Dockerfile 语法与层缓存行为
——那必须真机构建。因此 `docker/Dockerfile` 与 `docker/compose.yaml` 在文件头
都标注了「尚未在真实 Docker 中验证」。

### 12.2 写 `.dockerignore` 时差点踩的坑

为了精简镜像写了 `*.md` 排除——而 `prompts/` 与 `knowledge/` 里**全是 Markdown**，
它们是运行时资产。一条 `*.md` 会让镜像里的知识库变成空目录，
表现是「检索永远无结果」且不报任何错。已改为只排除 `docs/` 与 `tests/`，
并在 `.dockerignore` 里写明原因。（记在这里是因为它是同一类问题：
**排除规则和运行时依赖之间没有类型检查，只能靠人记住**。）

### 12.3 撤销并行会话之后的复检（同日）

一次并行会话被撤销后，工作区留下了「代码已改、暂存区还是旧快照」的混合状态。复检发现三件事，
都属**不报错但会误导**的类型：

| # | 现象 | 为什么危险 |
|---|---|---|
| 1 | 暂存区把 `ConclusionCard.vue`、`LogBar.vue` 记成「新增」，而工作区已删除（`AD`） | 直接 `git commit` 会把两个幽灵文件带进仓库，历史里从此有一对不存在的组件 |
| 2 | 新端点 `GET /v1/log/{id}` **零测试** | 它承载「日志可被指认」这条核心交互，五条约束（ID 校验/截断/预算/失败语义/缓存）任一条写错都只会让界面悄悄变差 |
| 3 | 文档组件清单仍写着已删的两个组件 | 后来人按文档找文件会找不到，进而怀疑是不是自己漏拉了代码 |

补测 16 项（`tests/log-docs.test.ts` 8 + `tests/log-docs-internal.test.ts` 8）。
**两条 fetch 路径必须分文件测**，因为 `config.ts` 在模块加载时读环境变量，一个进程只能固定一种配置；
而两条路径返回的信息量本就不同：内部 API 给 `data.content` + `data.files[]`，
公网 raw 只给合并全文（多文件已按 `===== 文件名 =====` 拼进正文，所以**公网路径根本没有附件数组**）。
这既是测试组织问题，也是产品事实：独立运行时面板的分节信息来自正文里的标记，而非 `docs[]`。

### 12.4 一条「假断言」的两次失败（worker 隔离测试）

`tests/log-tools.test.ts` 里「CPU 密集检索不阻塞主线程」这条断言改了三版，前两版都是假的：

| 版本 | 判据 | 为什么是假的 |
|---|---|---|
| v1 | `maxGap < 500` | 测的是**机器负载**。全量跑时 20 多个 node 进程抢 CPU，主线程被延后调度就超 500ms——实测全量红、单独绿，代码一字未改 |
| v2 | 扫描期间心跳 ≥5 次 | **用探针证伪过**：把 grep 强制改回同线程执行，10MB 扫描只要 148ms，10ms 心跳照样跳十几次，断言依旧全绿 |
| v3 | 让出一个宏任务后扫描是否仍未完成 | 二值结论：同步实现会在调用返回前扫完，`.then` 必然先于 `setTimeout(0)`；worker 实现则相反。**插入回归探针实测变红**，还原后变绿 |

教训不在于「阈值定得不够宽」，而在于：**一条断言若无法用「故意引入回归」的方式证伪，
就不能算守住了任何东西**。v1、v2 都能长期显示绿色，而它们本该守护的性质从未被检查过。

## 13. 语义检索从「脚手架」到真跑（2026-10-17 晚）

### 13.1 此前一直是脚手架，且没人发现

代码里 `doc_embeddings` 表建了、`RAG_EMBEDDING_*` 读进配置了，但：

| 环节 | 此前状态 | 后果 |
|---|---|---|
| 索引构建 | **从不生成向量** | 表是空的 |
| 查询 | **没有向量召回代码** | 永远走词法 |
| `semanticAvailable` | 直接返回 `cfg.embedding.enabled` | **它在报告「配置了」，不是「在跑」** |

第三行是这一类问题的典型：字段名像是运行状态，取值却是配置值。界面/日志上看到
「语义可用」，实际一次向量都没算过。这与第 11 节记录的「实现了但从未接线」是同一类缺陷，
只是更隐蔽——接线的检查（字段非空）通过了。

### 13.2 接入后的真实检索质量

`bge-m3`（1024 维，413 分块全部生成向量）+ `bge-reranker-v2-m3` 精排，融合用 RRF。

| 查询 | 通道 | 前 1 结果 |
|---|---|---|
| `MixinTransformerError` | hybrid + rerank | `cases/mixin-and-modconflict.md`（最优） |
| 「内存不够导致启动失败」 | hybrid + rerank | `patterns/out-of-memory.md`（最优） |
| 「装了两个模组版本对不上」 | hybrid + rerank | `cases/mixin-and-modconflict.md`、`patterns/version-mismatch.md`（对题） |
| 「游戏一开就闪退怎么办」 | hybrid + rerank | 渲染器 / Java 运行时 / OOM 混合（合理但不聚焦） |
| 「手机上没有声音」 | hybrid + rerank | **全部不相关** |

最后一行很有价值：**语义检索不是万能药**。知识库里没有「声音/音频」条目——
向量能把「没声音」映射到「音频相关」，但库里没有对应文档时，它只会
把语义上最近的无关条目排上来，而且**看起来和真命中一样自信**。
这反过来印证了一条纪律：检索结果为空/不相关时，模型必须能判断「知识库不覆盖」，
而不是把最近邻当答案。现有提示词里「若首次无结果，改用 Caused by 后的类名重试」
覆盖了「空结果」，但**没有覆盖「有结果但不相关」**——这是下一步要补的。

### 13.3 两个刻意的保守设计

- **维度不符拒绝硬算**：索引向量是 bge-m3（1024 维），若有人换成别的模型而没重建索引，
  余弦函数遇到长度不同会返回 0——排序全乱但界面无异常。现在先读 `embedding_meta`
  校验模型名与维度，不符直接报「请重建索引」。
- **重排失败保留原序**：重排是优化不是前置条件。上游 500 时若把结果清空，
  一次抖动就会让检索彻底失效；现在只把失败原因写进结果文本。

## 14. API 文档与文档守门（2026-10-19）

### 14.1 写的过程中核对出三处记忆偏差

不凭记忆写，逐条对着源码与真实响应核：

| 我原本会写成 | 实际是 |
|---|---|
| chat 请求体接受 `content` 作为 `logContent` 别名 | **没有这个别名**。`content` 是 `/v1/upload` 的字段 |
| `records` 分页用 `?page=` | 用 `limit` / `offset`，另支持 `minScore`/`maxScore`/`deliverable`/`orderBy`/`ascending` |
| 管理令牌只认 `X-Admin-Token` | 同时接受 `Authorization: Bearer <token>` |

第 1 条若写错，前端会发出一个「服务端静默忽略」的字段——请求成功但日志没生效，
是最难查的一类问题。

### 14.2 用测试守住文档不漂移

`tests/api-doc.test.ts` 做双向检查：

- 文档里出现的 `/v1/...` 路由，源码里必须有；
- 源码里暴露的 `/v1/...` 路由，文档里必须写。

第二条比第一条值钱：**新增接口忘了写文档是最常见的漂移方向**，而漏写不会报错——
只会让照着文档写客户端的人困惑。

测试自身也踩过一个坑：最初只抽取反引号包裹的路径，而文档里 `/v1/chat` 出现在
表格与代码块中（方法是独立反引号），于是漏抽取、误报「文档没写」。改为扫描全文
所有 `/v1/...` 形状的字符串。

## 15. 知识库缺口核查与「有答案但排不到前面」（2026-10-21）

### 15.1 先确认缺陷类覆盖是否真的够

从生产语料 `search_targets.jsonl`（14612 次 `rag_search` 调用、12493 个不同查询）
取频次最高的 18 个，逐个查首条结果是否对题——**18/18 命中**。

结论：**缺陷类覆盖扎实**。所以问题不在「要不要多写故障条目」。

### 15.2 真正的缺口在「启动器 × 操作系统」交界

按 `analyses_compact.jsonl` 里 9000 条有根因的记录做主题分布，发现三类**完全没覆盖**：

| 主题 | 条数 | 覆盖前状态 |
|---|---:|---|
| 静态初始化失败（`Could not initialize class`） | 351 | 部分（散落在别的条目里，无专门条目） |
| `__THESEUS_UTF8__` 路径编码前缀 | 128 | **完全没有** |
| 中文 / 非法字符路径 → `InvalidPathException` | 126 | **完全没有** |
| 系统级 Bug（Android 16 VPN、ROM 限制、模拟器） | 85 | **完全没有** |

新增三个条目后覆盖：`path-encoding-failure.md`（前两类合写，因为机制同源）、
`static-init-failure.md`、`system-environment-failure.md`。

**关于「通用常见问题」的判断是「不补」**。理由不是懒：用户拿着日志来问「这份为什么崩」，
泛泛的「怎么装模组」不解决问题，还会用高频通用词稀释 BM25。实测那个
「52.7% 提到模组安装」的统计是假信号——绝大多数是**修复建议里提到安装**，不是用户在问怎么安装。

### 15.3 比缺条目更浪费的问题：格式文档抢了判据的位置

| 查询 | 修复前首条 | 正确答案 |
|---|---|---|
| `UnsupportedClassVersionError class file version 65.0` | `format/latest-log.md` | `patterns/version-mismatch.md` |
| `libGL error` | `format/launcher-log.md` | `patterns/system-environment-failure.md` |

成因是**职责越界**：`format/` 本应只说明「日志长什么样」，却在「签名」小节里
逐字抄了完整报错原文。BM25 按字面匹配，**抄得越完整分越高**，
于是把真正的判据挤到第三位。

反过来说：写知识库时「示例写得太具体」是有代价的——它会让格式文档变成
「报错示例库」，从而在检索里和判据卡竞争。

### 15.4 修法：格式文档改「只指路，不写判据」

把 `format/latest-log.md` 的「高频启动失败签名」（逐条抄报错）改成
「启动失败时该去哪一节看」（一张映射表），`format/launcher-log.md` 的字段判定
从「修复步骤」移到独立小节（职责是「怎么读」而不是「怎么修」）。

修完 10 条高频查询里 9 条首条对题。剩下 `模拟器 libGL error 渲染失败` 一条，
首条仍是启动器日志——复核后认为**合理**：该查询跨「环境」与「渲染器」两类，
而启动器日志正是同时记录这两者的地方，不算错排。

### 15.5 固化为测试

`tests/retrieval-ranking.test.ts`（13 项）把上面 12 条高频查询与 1 条职责边界
钉死。查询词全部来自生产真实调用，不是编的。

**测试自身踩的坑**：测试进程不加载 `.env`，因此走**纯词法**而非生产上的语义融合，
两者结果不同。这反而暴露了一个更有价值的判断标准——
**纯词法下也该对**。若只有语义能救，说明知识库本身的职责边界就是模糊的。

另一处期望值写错：`Cowardly refusing to send event` 我原以为属 `mod-config-timing-failure`，
实际该文件只提了一句，真正收录 14 处的是 `forge-early-loading-failure.md`。
测试失败时先核对「是我写错还是代码错」，比直接改代码更省事。
