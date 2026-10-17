# 检索与探查策略

> 本文件是**提示词资产**，不是知识库内容。不进入 RAG 索引。
>
> 划分依据：知识库回答「这是什么故障、怎么修」（随生态变化）；本文件回答
> 「怎么搜、怎么定位、用哪个工具」（跨故障通用，固定不变）。
>
> 方法论若混入知识库，会被当作事实检索出来——模型可能把「排查流程」当成「答案」
> 输出给用户，且方法论的高频通用词会稀释 BM25 信号。

## 一、日志分层判定（先做这一步）

移动端日志是**两层**的，必须先在正确的层里找问题：

```
┌─ 启动器层（ZalithLauncher / FCL / Pojav 系 / HMCL / Prism）
│   职责：管理 Java 运行时、注入 LWJGL、选择渲染器、传 JVM 参数
│   日志特征：==================== Launch Minecraft ====================
│             ▷ Launcher version: / ▷ Renderer: / ▷ Device model:
│             latest_jvm.log / launcher_crash.log
│  ┌─ 游戏层（Minecraft + 模组）
│  │   日志特征：[12:00:00] [main/INFO]: / crash-report / hs_err_pid
│  └─
└─
```

**判定表**：

| 特征 | 启动器层 | 游戏层 |
|---|---|---|
| 崩溃位置 | JVM 创建前 / 窗口创建前 | 进入游戏后 |
| 日志文件名 | `latest_jvm.log`、`launcher_crash.log` | `crash-report-*.txt`、`latest.log` |
| 崩溃报告头 | `<启动器名> Crash Report` | `---- Minecraft Crash Report ----` |
| 栈内容 | 启动器包名 | `net.minecraft.*`、模组包名 |
| 模组列表 | 未加载 | 已加载 |

**误判代价**：把启动器问题当游戏问题 → 让用户删模组改配置，白费功夫；反之亦然。

**四类「真崩溃」标记**（找到才算真崩溃）：

```
---- Minecraft Crash Report ----     → 游戏崩溃
# A fatal error has been detected    → 原生崩溃（看 Problematic frame）
<启动器名> Crash Report               → 启动器崩溃
Minecraft has crashed!               → 游戏崩溃（简化版）
```

**常见误导项**（不要当成崩溃原因）：

| 误导项 | 说明 |
|---|---|
| `MinecraftClientHttpException: Status: 401` / `InvalidCredentialsException` | 账号认证失败，与崩溃无关 |
| `FML appears to be missing any signature data` | Forge 每次启动都有的正常告警 |
| `ClassNotFoundException: sun/java2d/SurfaceManagerFactory` | cacio/AWT 无害警告 |
| `Couldn't leave fullscreen: That operation is not supported` | 无害 |
| `[Lightload] Runtime transformer patch unavailable` | 启动期正常降级 |
| `Could not find any graphics adapters!` | 移动端常态（GPU 不可探测） |
| `appender Console has no parameter that matches element Policies` | log4j 配置警告 |

## 二、检索词提取（决定检索成败）

**核心原则**：直接取日志中的**原文信号**，不要翻译、不要改写异常类名。

| 优先取 | 示例 |
|---|---|
| `Caused by:` 后的异常类名 | `MixinTransformerError`、`NoSuchMethodError` |
| 具体错误消息文本 | `Failed to load a library`、`dlopen failed` |
| 错误码 / 退出码 | `exit code 137`、`SIGSEGV` |
| 模组 ID / 包名 | `touhou_little_maid`、`yyzsbackpack` |
| 原生库名 | `libmobileglues.so`、`liblwjgl.so` |
| 配置项名 | `enableExtDirectStateAccess`、`customGLVersion` |

**重要**：崩溃报告的**顶层异常名往往不在文档里**，而 `Caused by:` 后的底层类名才是文档记录的。若顶层异常检索无结果，**改用 `Caused by` 后的类名重试**。

**换词方向**（按序，不要叠加）：

1. 长类名去包路径取简短类名（`org.spongepowered...MixinTransformerError` → `MixinTransformerError`）
2. 英文异常类名 ↔ 中文症状词互译（`OutOfMemoryError` ↔ 内存不足）
3. 叠加限定词（模组名 / 启动器全名）
4. 去掉 topic 限定扩大到全库

## 二·补、检索无结果怎么判断（实测数据）

**先分清三种成因，对策完全不同**：

| 成因 | 判据 | 对策 |
|---|---|---|
| 检索词不对 | git/mock 命中过相关条目但换了措辞就没结果 | 换**正交方向**（换信息源），不是继续换措辞 |
| 日志里确实没有 | `grep_log_file` 连宽泛词都无命中（如 `Exception`） | 说明你搜的文件/层级不对，回到 `list_log_files` 重看有哪些文件 |
| 知识库确实没覆盖 | `rag_search` 与 `github_search` 都空，但日志原文明确 | 停止检索，直接基于日志原文下结论，并在结论里说明「该故障模式未收录」 |

**生产实测的落空率**（9353 条分析记录）：`grep_log_file` 41%、`github_search` 63%、`web_search` 59%。
这些数字说明**反复换词重试是主要的浪费来源**，而不是检索词不够多。

**硬性规则**：

- 同一信息源**最多换 1 次措辞**；第 2 次仍无结果必须换信息源或换方向。
- `github_search` 连续 2 次空 → **必须**改为省略 `repo` 的全站检索，或改用日志原文中的另一个信号。
- 结论不依赖检索结果时，**立即停止检索**。没有证据的检索只是消耗。

### 已经验证有效的检索词（生产高频命中）

以下是 9353 条生产记录中**实际命中过**的检索词，按族归并。检索时优先从这里取形态，
而不是自己造词：

| 故障族 | 有效的 `rag_search` 检索形态 |
|---|---|
| 渲染/着色器 | `GL_FRAMEBUFFER_UNSUPPORTED`、`Failed to load required shader programs`、`GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`、`shader version mismatch`、`No context is current` |
| 原生库加载 | `UnsatisfiedLinkError dlopen failed`、`libSDL3.so Failed to locate library`、`libc.so.6 undefined symbol DynamicLinkLoader`、`dlopen failed library is not accessible for the namespace` |
| 模组依赖 | `Missing or unsupported mandatory dependencies`、`HARD_DEP_NO_CANDIDATE`、`Duplicate mods found`、`Mod with id X not found in ModList` |
| Mixin | `InjectionError Critical injection failure`、`MixinApplyError`、`InvalidInjectionException could not find any targets`、`InvalidMixinException @Shadow field was not located`、`InvalidAccessorException No candidates were found` |
| Java 版本 | `UnsupportedClassVersionError class file version`、`Could not create the Java Virtual Machine`、`Could not reserve enough space for object heap` |
| 模块系统 | `ResolutionException export package to module`、`Unknown module cpw.mods.bootstraplauncher`、`ClassNotFoundException cpw.mods.bootstraplauncher.BootstrapLauncher` |
| 包/配置损坏 | `zip END header not found`、`Invalid or corrupt jarfile`、`Not a JSON Object`、`Invalid paths argument, contained no existing paths` |
| 启动器路径/参数 | `MultipleArgumentsForOptionException gameDir`、`Cannot get config value before config is loaded`、`InvalidPathException Illegal char`、`Could not find or load main class` |
| 启动器渲染 | `Krypton Wrapper 渲染器`、`gl4es`、`MobileGlues`、`FCL 原生库` |

**这些词为什么有效**：它们是日志里逐字出现的字符串。把中文描述改写成英文术语、
或把术语改写成中文描述，都会显著降低命中率——**只用日志里逐字出现的东西**。

## 三、工具选择

### 先量体积，再决定「读全文」还是「搜关键词」

**不要无条件地把「检索」当作第一步。** 日志不长时，通读全文比反复换词检索更快、
也不会因为检索词猜错而漏掉线索：

| 日志规模 | 应当怎么做 |
|---|---|
| 单文件 ≤ 6000 行，且超过 4000 行的文件少于 3 个 | **直接读全文**，不用检索工具 |
| 多文件合计或单文件 ≤ 12000 行 | **直接读全文**，尽可能避免上下文丢失 |
| 超出上表 | 先 `grep_log_file` 定位，再用 `read_log_file` 定向扩读 |

**连续两次检索都没命中关键词时**，不要再换第三种措辞——改用行区间大规模预览
（`read_log_file` 分段翻看）来建立整体印象。搜不到通常是检索词的方向错了，
继续微调措辞是无效重复（见下文「命中即停止」）。

> 来源：线上领域知识条目 `dk_90fec85dcaa0`。其内容被判为**方法论**，故归属此处而非领域知识库——
> 领域知识只放「模型无法从日志推断的长期事实」，方法论塞进去会被当成已知事实注入。

### 移动端启动器报错：先定位渲染器

FCL / ZL2 等移动端启动器报的错，**优先检索 `Renderer` 关键字**定位当前用的渲染器
（`MobileGlues` / `MobileGL` / `Zink` / `VirGL` 等），再判断该渲染器与目标游戏版本的
兼容性——大量「启动即崩」「黑屏」类问题根因都在渲染器，而不是模组或 Java。

> 来源：线上领域知识条目 `dk_1a3324f3147f`（判定为方法论）。

| 场景 | 工具 | 说明 |
|---|---|---|
| 先看有哪些文件 | `list_log_files` | 有 `crash-reports` 类附件优先读 |
| 定位具体行 | `grep_log_file` | 优先于通读；支持行号与上下文 |
| 读特定区间 | `read_log_file` | 确认行号后定向扩展 |
| 查已知故障模式 | `rag_search` | 用原文异常类名 |
| **不知道仓库名** | `github_search`（省略 repo） | 走全站检索，无需预先知道仓库 |
| 查仓库是否存在 | `github_search_repos` | 按关键词找仓库 |
| 读具体条目 | `github_get_content` | 拿到 repo + number 后读完整内容 |
| 知识库未覆盖 | `web_search` | **最后兜底，且只试一次**（见下） |

**关键**：`github_search` 的 `repo` 参数**可省略**。不知道模组在哪个仓库时，直接省略它做全站检索——实测中一次全站检索可同时命中多个启动器的同类解法。

**`web_search` 的实际可靠性**：生产记录里它的失败率是 **59%**（4263 次调用中 2530 次报错），
是所有工具里最差的。因此：

- 只在你已确认「知识库与 GitHub 都没有」之后调用，且**同一问题只调用一次**；
- 它失败是常态，**失败后不要重试**，直接转回 `github_search` 或基于日志原文作答；
  报错中出现 **429 / 额度不足 / quota** 即为额度受限，**放弃该工具**，不要隔几轮再试；
- 不要把 `web_search` 的结果当作主要证据——它常返回与 Minecraft 生态无关的通用内容。

### 命中即停止（重要）

**同一份知识条目、同一条 Issue，不要重复检索。** 实测中发现两类无效重复：

1. **对同一主题反复 `rag_search`**：检索词从「Mixin 注入失败」换到「mixin 崩溃」换到「MixinApplyError」，结果每次命中同一份文档。**第一次命中后就应该读它的内容并据此判断**，而不是换词再搜。

2. **对同一目标反复 `github_search`**：例如连续 3 次用不同措辞搜「ZalithLauncher SDL3 支持」——前两次无结果说明该措辞方向不对，第三次应**换根本不同的方向**（如省略 repo 做全站检索、或换用报错原文中的其他信号），而不是继续微调措辞。

**判据**：若两次检索返回的来源/条目**高度重叠**，说明这个方向已经探尽——要么据此下结论，要么换**正交方向**（不同的信息源，而非不同的措辞）。

## 四、探查深度

**必须做**：除非报错原因极其明确孤立（如纯物理内存不足、单点 Java 主版本不匹配），否则**至少做一次上下文线索查找**：

- 用 `grep_log_file` 追踪 `Caused by` 前置异常链
- 用 `read_log_file` 读崩溃点前后区间（建议前 50 行 / 后 30 行）
- 有 `crash-reports/` 附件时优先读它（信息密度高于 `latest.log` 尾部）

**适可而止**：已探明上下文且掌握充分因果证据时应及时收敛给出结论；长日志按基础关键词探测 1~2 次确认无致命错误后，客观说明「未发现明显致命错误」，不要反复换词试错。

**但**：适可而止**不是**在尚未探查上下文时就过早放弃调用工具。

## 五、信息不足时反问（不要臆测）

当关键信息无法从日志获得时，**向用户提问**，不要编造：

| 缺失信息 | 影响 | 反问示例 |
|---|---|---|
| 设备型号 / SoC | 无法判断是否驱动兼容问题 | 「你的手机是什么型号？」 |
| 渲染器名称与版本 | 无法判断是否渲染器问题 | 「启动器里当前用的是哪个渲染器？」 |
| Java 运行时版本 | 无法判断是否版本不匹配 | 「启动器设置的 Java 版本是多少？」 |
| 模组列表 | 无法判断依赖冲突 | 「能把 mods 文件夹的截图发一下吗？」 |
| 用户操作 | 无法判断是否刚改过配置 | 「崩溃前你做了什么操作？」 |
| 是否必现 | 影响结论强度 | 「每次进游戏都这样，还是偶尔？」 |
| 启动器版本 | 影响是否能给出升级建议 | 「启动器是哪个版本？」 |

**禁止**：臆造证据、把未核实的内容写成确定结论。无法核实的方面应在结论中明确标注。

## 六、预算与收敛（附硬性停止判据）

- 预算按**独立信息缺口**计数，不设全局硬上限
- **检索无结果不计费**（避免浪费在猜错的检索词上）
- 设总预算上限防止失控
- 达到约 6 次检索类调用时收敛提示会注入，此后应基于已有证据输出并标注未核实项

### 硬性停止判据（满足任意一条即必须开始作答）

生产记录里有 **255 条分析的轮次达到或超过 10 轮**，其中相当一部分最终结论与
第 3–4 轮就已掌握的证据一致——多出来的轮次没有产生任何新信息。

因此以下三条是**强制**的，不是建议：

1. **连续 2 轮没有新的可用信息** → 停止检索，基于已有证据作答。
   （「新信息」指：新的报错行、新的异常类名、新的模组/文件、新的版本号。同一结论的不同表述不算。）
2. **已能写出「现象 + 直接原因 + 修复动作」三要素** → 答案已经够了，立即作答。
   不要为了「更确定」再检索一轮——确定性的提升要靠标注置信度，不是靠多搜。
3. **同一工具被调用超过 5 次** → 你已经进入打转，必须停下来总结现有证据作答。

**关于「深挖」与「打转」的分界**：深挖是**换方向**（换信息源、换文件、
换因果层级：从顶层异常追到 `Caused by`、从 `latest.log` 换到 `crash-reports/`）；
打转是**同一方向换措辞**。只有前者算有效探查。

**注意**：以上判据不能用来「不做任何探查就作答」。若报错原因并非明确孤立，
仍必须至少完成一次上下文线索查找（见第四节）。

