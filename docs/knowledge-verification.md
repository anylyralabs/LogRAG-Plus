# 知识库事实核查记录

> 核查日期：2026-10-21。方法：把知识库里**可客观证伪的断言**抽出来，逐条对照
> 官方规范、Khronos 规范、OpenJDK JEP 与生产语料。本文档记录「查了什么、结论如何」，
> 供后续修订时复用同一套判据。

## 一、核查范围与方法

知识库 45 个文件、431 个分块。不可能逐句查，因此按**可证伪性**分四层，只查前三层：

| 层级 | 内容 | 核查方式 | 本次是否核查 |
|---|---|---|---|
| ① 硬事实 | 版本号对应、信号编号、OpenGL 状态码、JEP 编号 | 对照官方规范 | ✅ 全部 |
| ② 机制断言 | 「为什么这样」「谁在什么时机做什么」 | 对照规范 + 上游源码/issue | ✅ 抽样重点 |
| ③ 判据 | 「看到 X 应怀疑 Y」 | 生产语料复算 | ✅ 抽样 |
| ④ 处置建议 | 「该怎么做」 | 无客观标准，靠场景合理性 | 部分 |

## 二、核对通过的事实（附来源）

### Java 版本 ↔ class file version

知识库多处出现该对照表（`pc-launcher-issues.md`、`cases/native-and-java.md`）：

| 表里写的 | 核实结果 | 来源 |
|---|---|---|
| Java 8 → 52 | ✅ 正确 | Wikipedia Java version history |
| Java 17 → 61 | ✅ 正确 | 同上 |
| Java 21 → 65 | ✅ 正确 | 同上 |
| Java 25 → 69 | ✅ 正确 | 同上（Java 25 为 LTS，2025-09-16 发布） |

### Minecraft 版本 ↔ 所需 Java

| 表里写的 | 核实结果 | 来源 |
|---|---|---|
| ≤ 1.16.5 → Java 8 | ✅ 正确 | Minecraft Wiki / MultiMC Launcher Wiki |
| 1.17 – 1.20.4 → Java 17 | ✅ 正确 | 同上 |
| 1.20.5 – 1.21.x → Java 21 | ✅ 正确 | 同上（1.20.5 起强制 Java 21） |
| 26.x → Java 25 | ✅ 与生产日志一致（多份 `hs_err` 记录 `JRE version: ... (25.x)`） | 生产语料 |

### 信号编号（`format/hs-err.md`）

| 表里写的 | 核实结果 |
|---|---|
| SIGSEGV = 0xb (11) | ✅ |
| SIGBUS = 0x7 (7) | ✅ |
| SIGILL = 0x4 (4) | ✅ |
| SIGFPE = 0x8 (8) | ✅ |
| SIGABRT = 0x6 (6) | ✅ |
| EXCEPTION_ACCESS_VIOLATION = 0xc0000005 | ✅ |

`SIGABRT` 的成因描述「多由 C 运行库检测到堆破坏触发」也与 glibc 的实际行为一致
（glibc 在 `free()` 时检测到堆元数据损坏 → 调 `abort()` → 抛 SIGABRT）。

### OpenGL 帧缓冲状态码（`patterns/opengl-framebuffer-failure.md`）

| 表里写的 | 核实结果 | 来源 |
|---|---|---|
| `GL_FRAMEBUFFER_COMPLETE` = 0x8CD5 | ✅ | Khronos `glCheckFramebufferStatus` |
| `GL_FRAMEBUFFER_UNSUPPORTED` = 0x8CDD = 36061 | ✅ | 同上 |

「36061 是十进制形态的 0x8CDD」这一判读成立：Minecraft 1.16.5 的 Create 直接上报
`glCheckFramebufferStatus` 的返回值原值，未转枚举名。

### Mixin 命名空间（`patterns/mixin-namespace-mismatch.md`）

该条目断言「26.1 起运行期命名空间从 `intermediary` 变为 `official`，
旧模组的 classTweaker 声明会直接抛 `ClassTweakerFormatException`」。

**核实为真**：该异常在 Grim Anticheat、Retromod 等项目的 26.1/26.2 issue 中大量出现，
报错原文与知识库记录逐字一致：

```
ClassTweakerFormatException: line 1: Namespace (intermediary) does not match current runtime namespace (official)
```

### 帮助性 NPE（`patterns/null-pointer-crash.md`）

断言「带 `because ... is null` 的 NPE 是 Java 14+ 的帮助性消息，MC 1.17 起普遍可见」。

**核实为真**：JEP 358 (Helpful NullPointerExceptions) 在 JDK 14 引入；
MC 1.17 起要求 Java 16，因此该版本之后的日志都会带这类消息。

### 静态初始化（`patterns/static-init-failure.md`，本次新增）

断言「`NoClassDefFoundError: Could not initialize class` 是**回声**，
真正的根因在更早的 `ExceptionInInitializerError`，且该类此后不再重试初始化」。

**核实为真**：JLS 12.4.2 规定类初始化失败后进入 erroneous 状态，后续访问直接抛
`NoClassDefFoundError`，不再执行 `<clinit>`。社区文档亦一致表述为
「this error is an echo — find the original initialiser failure」。

## 三、核查中发现并修正的问题

### 1. `-Xms` 等于 `-Xmx` 被写成通用禁忌（已修）

**原文**（`patterns/java-runtime-mobile.md` 触发 D）：

> | `-Xms` 等于 `-Xmx` 且值过大 | 启动即占用全部内存，易被系统 OOM Killer 杀掉 |

**问题**：这在 Android 上成立，但**PC 服务端恰好相反**——`-Xms` 设为与 `-Xmx` 相等是
Aikar's flags 等服务端方案的推荐做法（`-Xms4096M -Xmx4096M`），目的是避免堆扩张带来
的 GC 停顿与 CPU 开销，并配合 `-XX:+AlwaysPreTouch` 在启动时一次预触。

原文虽在「移动端」条目内，但表格没有限定词，容易被当成通用结论。

**修正**：补上「仅适用于 Android 移动端」的限定，并说明 PC 服务端为何相反
（约束条件不同：PC 服务端独占物理内存；Android 上 JVM 与系统、启动器、GPU 驱动共享内存）。

### 2. 格式文档抢了判据的位置（已修，见 `docs/measurements.md` 第 15 节）

`format/latest-log.md` 与 `format/launcher-log.md` 在「签名」与「修复步骤」里
逐字抄了完整报错原文，导致 BM25 字面匹配分数过高，把 `patterns/` 的判据卡挤到后面。
已改为「只指路，不写判据」。

## 四、依据强度分级（现有机制，无需新增标注）

核查时确认：知识库**已有**一套依据强度表达，写在每个条目的「置信度线索」小节里：

- **确定**：日志含某几个具体特征即可判定
- **较确定**：特征不完整时的推断路径
- **需区分**：与相邻故障的分界判据
- **需追问**：日志信息不足时应向用户确认什么

另有部分条目带**实测分母**（如 `mixin-namespace-mismatch.md` 的「536 份日志中 183 份命中」、
`static-init-failure.md` 的「351 条根因」），这是比「置信度」更硬的依据。

因此不需要给每个文件另加「来源」标注——分级已经在条目内部，且更细。

## 五、一个无法外部验证但生产证据充分的结论

`__THESEUS_UTF8__` 前缀（`patterns/path-encoding-failure.md`）：

- **公开渠道查不到**：GitHub 代码搜索需登录，搜索引擎无结果，
  Modrinth Theseus 仓库的公开文档未提及该前缀
- **生产语料有 113 条独立记录**，且高度一致地指向同一组合：
  `globalpacks` / `gdarp` 模组 + Theseus 系启动器 + 含非 ASCII 的路径

**结论**：该前缀真实存在（113 条独立日志不可能同时臆造同一字符串），但它是
「启动器实现细节」而非公开规范，因此条目里**没有**引用任何外部文档，
判据全部来自日志原文与堆栈。

这类内容的风险是「上游改了实现，知识库无从得知」。缓解办法是条目的判据写成
**形态特征**（「以 `XXX:` 开头且后接 Base64」）而不是硬编码某个字符串，
这样即使前缀变了也能识别。

## 六、本次核查未覆盖的部分

诚实说明边界：

- **处置建议的「最优性」**：例如「先改路径还是先换启动器」，没有客观标准，
  只验证了「建议不会造成新问题」
- **移动端各启动器的实现细节**：FCL / ZL2 / axolotl 的内部行为无法从公开资料核实，
  依据是生产日志观察
- **26.x 之后的新版本行为**：知识库写于 2026-10，之后版本变化需重新核查
