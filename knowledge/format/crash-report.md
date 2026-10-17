# Minecraft 崩溃报告（crash-reports/crash-*-client.txt 与 -server.txt）

## 签名 (Signature)

```
---- Minecraft Crash Report ----
// Shall we play a game?

Time: 2026-10-15 18:00:27
Description: Initializing game

java.lang.RuntimeException: Could not execute entrypoint stage 'client' due to errors, provided by 'xxx' at 'com.example.XxxClient'!
	at net.fabricmc.loader.impl.FabricLoaderImpl.lambda$invokeEntrypoints$0(FabricLoaderImpl.java:413)
	at knot//net.minecraft.client.Minecraft.<init>(Minecraft.java:470)
Caused by: java.lang.NoSuchMethodError: 'void net.minecraft.client.renderer.blockentity.BlockEntityRenderers.register(...)'
	at knot//com.example.XxxClient.onInitializeClient(XxxClient.java:31)

A detailed walkthrough of the error, its code path and all known details is as follows:
---------------------------------------------------------------------------------------

-- Head --
Thread: Render thread
Stacktrace:
	at ...

-- System Details --
Details:
	Minecraft Version: 1.21.1
	...

#@!@# Game crashed! Crash report saved to: #@!@# /path/crash-2026-10-15_18.00.27-client.txt
```

派生的识别要点：文件头 `---- Minecraft Crash Report ----`（两侧短横线数量可变，四到多条），第二行为 `//` 开头的嘲讽语录，随后固定是 `Time:` 与 `Description:` 两行；文件不存在 `##` 之类 Markdown 结构。

配套的极简变体出现在控制台而非文件里：`Minecraft has crashed!`。它只表示"游戏崩溃流程已启动"，信息量远低于完整报告。

## 含义

这是**游戏层**（Minecraft 主类及其模组）捕获到未处理异常时，由游戏自身的崩溃报告器写出的文本文件。它与启动器层无关，也不代表原生崩溃。

文件由游戏在启动时定位的实例根目录下 `crash-reports/` 生成，命名严格是 `crash-<yyyy-MM-dd_HH.mm.ss>-<side>.txt`：`-client` 表示客户端进程，`-server` 表示服务端（含单人世界的集成服务器）。

报告的产生时机决定其可读性：

| 崩溃发生阶段 | 是否生成 crash report | 说明 |
|---|---|---|
| 游戏主类已启动、异常被 `fillReport` 捕获 | 是 | `Description:` 指向具体阶段 |
| 加载器依赖求解失败、游戏主类从未加载 | **否** | 只有加载器的 `FormattedException` / `ModLoadingException` |
| JVM 级致命错误（信号） | **否** | 改由 `hs_err_pid*.log` 承载 |
| 玩家按 F3+C | 是 | `Description: Manually triggered debug crash`，非真崩溃 |

## 常见触发

### 文件头与时间行

- `Time:` 的格式随时区与 JVM 版本而变，可出现 `2026-10-15 18:00:27`、`12/25/15 11:05 AM`、`28.4.2021 17:28`、带时区后缀的 `2026-09-26 21:07:06 CEST` 等多种写法，不构成判据。
- `// 嘲讽语录` 由游戏内固定文本池随机抽取，与崩溃原因**完全无关**，同一故障每次重跑都会换一句。

### Description 行（阶段字段）

`Description:` 的值是崩溃报告中信息密度最高的一行，它标注了异常被抛出的阶段：

| Description 原文 | 指向的阶段 |
|---|---|
| `Initializing game` | 游戏主类构造期：加载器 entrypoint、注册表、模组初始化 |
| `Preparing launch tick` | 启动 tick 前的注册表冻结与 holder lookup |
| `Loading dimension` | 维度数据包加载 |
| `Preparing spawn area` | 出生点区块生成 |
| `Rendering overlay` | HUD / 覆盖层绘制 |
| `Rendering screen` / `Updating screen events` | GUI 渲染与界面事件 |
| `Ticking entity` / `Ticking block entity` / `Ticking player` | 实体、方块实体、玩家的逐 tick 逻辑 |
| `Exception in server tick loop` | 服务端主循环（单人世界时也在此） |
| `Saving and pausing game` | 存档写入 |
| `Manually triggered debug crash` | 玩家手动触发，`java.lang.Throwable: Manually triggered debug crash` |
| `Unexpected error` | 未被更细阶段包住的外层兜底 |
| `Error executing task` | 异步任务（`Util.runTask` / `FutureTask`）内抛出的异常 |

### 异常堆栈段

主堆栈之后若出现 `A detailed walkthrough of the error, its code path and all known details is as follows:`，其后是若干 `-- 段名 --` 小节：

- `-- Head --`：崩溃点原始堆栈，部分加载器会附 `Thread: <线程名>`，以及 `No Mixin Metadata is found in the Stacktrace.` 说明。
- `-- Uptime --`：`Details:` 下列 `JVM uptime` / `Wall uptime` / `High-res time` / `Client ticks`。`Client ticks: 1251 ticks / 62.550s` 表示崩溃发生在游戏运行约一分钟之后。
- `-- Affected level --`：世界状态，含维度名、坐标、游戏模式。
- `-- MOD <模组名> --`：模组自定义段。
- 堆栈行尾的 `~[client-1.21.1-...-srg.jar%23198!/:?] {re:mixin,pl:access-transformer:B}` 是加载器注入的附加标记，`TRANSFORMER/<模组id>@<版本>/` 前缀指出该帧来自哪个模组。

#### 并发加载的外层壳：ForkJoinPool

生产日志抽样显示，**约 35% 的崩溃堆栈顶部是 `ForkJoinPool` 帧**（模组在并行加载阶段抛异常）。这类堆栈的形状是：

```
at java.base/java.util.concurrent.ForkJoinTask.getThrowableException(ForkJoinTask.java:603)
at java.base/java.util.concurrent.ForkJoinTask.reportException(ForkJoinTask.java:681)
at java.base/java.util.concurrent.ForkJoinTask.invoke(ForkJoinTask.java:734)
at java.base/java.util.stream.FindOps$FindOp.evaluateParallel(FindOps.java:164)
at java.base/java.util.concurrent.ForkJoinPool$WorkQueue.topLevelExec(ForkJoinPool.java:1312)
at java.base/java.util.concurrent.ForkJoinWorkerThread.run(ForkJoinWorkerThread.java:188)
```

**判读要点**：`ForkJoinPool` / `ForkJoinTask` / `ForkJoinWorkerThread` 这些帧**只是异常传播的外壳**，不含任何根因信息。根因在紧随其后的 `Caused by:` 链下游，必须继续往下读到第一个非 JDK 包的异常。

常见组合：外层 `ForkJoinPool` → `Caused by: java.util.concurrent.ExecutionException`（Java 8/Forge 系）→ 真正的模组异常。Java 9+ 会直接跳过 `ExecutionException` 包装。

另外 `Mappings not present!`（Fabric loader 输出）与 `No Mixin Metadata is found in the Stacktrace.` 都是**正常信息**，不是崩溃原因。

### -- System Details -- 段字段

`Details:` 之后是缩进（制表符）的键值对，字段名与取值含义如下：

| 字段 | 取值与含义 |
|---|---|
| `Minecraft Version` / `Minecraft Version ID` | 游戏版本，如 `1.21.1`、`26.3` |
| `Operating System` | 形如 `Windows 11 (amd64) version 10.0`、`Mac OS X (aarch64) version 26.5`、`Linux (amd64)`；括号内是 **JVM 架构** |
| `Java Version` | 运行时版本与厂商，如 `21.0.7, Microsoft`、`1.8.0_502, Oracle Corporation` |
| `Java VM Version` | VM 实现与模式，如 `OpenJDK 64-Bit Server VM (mixed mode)` |
| `Memory` | `已用 / 已提交 up to 上限`（单位 bytes 与 MiB 并列） |
| `Memory (heap)` / `Memory (non-heap)` | 堆与非堆的 `init / used / committed / max` |
| `CPUs` | 逻辑 CPU 数 |
| `Processor Name` / `Microarchitecture` | 如 `Apple M4`、`12th Gen Intel(R) Core(TM) i7-12700K`；`ARM64 SoC: Firestorm + Icestorm` 可见移动端 SoC 架构 |
| `Graphics card #0/#1` | `name` / `vendor` / `VRAM` / `versionInfo`（驱动版本）；移动端常为 `NO CONTEXT` 或缺失 |
| `JVM Flags` | 启动参数原文，`-Xmx`、`-Xss`、GC 选择器等均在此 |
| `Launched Version` | 版本与加载器组合，如 `neoforge-21.1.248`、`fabric-loader-0.18.4-1.21.11` |
| `Launcher name` | 启动器标识，如 `minecraft-launcher` |
| `Backend library` | LWJGL 版本，如 `LWJGL version 3.3.3+5` |
| `Backend API` | 当前图形上下文，如 `NVIDIA GeForce RTX 3070 Ti/PCIe/SSE2 GL version 4.6.0`，或 `NO CONTEXT` |
| `Window size` | 窗口宽高 |
| `GFLW Platform` | GLFW 后端平台标识，如 `win32`、`x11`、`wayland`、`android` |
| `GL Caps` | `Using framebuffer using OpenGL 3.2` 等能力标记；移动端常为空 |
| `Is Modded` | `Definitely; Client brand changed to 'fabric'` 或 `Definitely; Client brand changed to 'neoforge'` |
| `Type` | `Client (map_client.txt)` 或 `Integrated Server (map_client.txt)` |
| `Resource Packs` / `Active Data Packs` | 已启用资源包与数据包，末尾 `(incompatible)` 表示该包与当前版本不匹配 |
| `Current Language` / `Locale` | 界面语言与区域 |
| `CPU` | 处理器摘要，如 `20x 12th Gen Intel(R) Core(TM) i7-12700K`，移动端可为 `<unknown>` |

### 加载器专属附加段

- Fabric：`Fabric Mods:` 下列出每个模组 `模组id: 显示名 版本`，嵌套前置以缩进与 `|--` / `\--` 表示。另有 `Debug Flags: 0 total;`。
- Forge / NeoForge：`Mod List:` 或以 `Loaded Mods:` 形式列出；老版 Forge 在报告头部另有 `WARNING: coremods are present:` 段，逐行 `插件类名 (jar 文件名)`，并附 `Contact their authors BEFORE contacting forge`。
- `-- Fabric Mods --` 段名亦存在于部分版本，内容与上同。

### 结尾标记

```
#@!@# Game crashed! Crash report saved to: #@!@# <绝对路径>
```

该行由游戏通过 `printToSYSOUT` 写入标准输出，因此会同时出现在启动器日志里。对应的失败变体是 `#@?@# Game crashed! Crash report could not be saved. #@?@#`（目录不可写），退出码 `-2`；写出成功时退出码 `-1`。启动器日志中的 `Process exited with code 255.` 是 `-1` 的补码表示，二者是同一事件。

## 修复步骤

**按 `Description:` 定位故障域**

1. `Initializing game` 且栈中含 `invokeEntrypoints` → 模组初始化期失败，继续看 `Caused by:` 链确定是注册冲突、反射失败还是 `NoSuchMethodError`。
2. `Ticking entity` / `Ticking block entity` → 逐个读到非 `java.*` / `net.minecraft.*` 的栈帧，那是肇事模组的包名。
3. `Rendering overlay` / `Rendering screen` → 先读 `Backend API` 与 `Graphics card #N versionInfo`（驱动版本），再读栈。
4. `Manually triggered debug crash` → 玩家按了 F3+C，报告中不含故障信息。

**按堆栈定位肇事模组**

1. 自顶向下找**第一个**包名既非 `java.*`、`net.minecraft.*`，也非加载器命名空间（`net.fabricmc.*`、`cpw.mods.*`、`net.neoforged.*`、`net.minecraftforge.*`）的帧。
2. 帧尾出现 `TRANSFORMER/<模组id>@<版本>/` 时，模组 id 与版本可直接读取。
3. `Mixin apply failed for <混入类> -> <目标类>` 形式表明是混入冲突，肇事方须从目标类被哪些模组同时修改来判断。
4. 栈中 `{re:mixin}` / `{pl:access-transformer:B}` 说明该帧已被改写，方法签名可能与上游源码不符，禁止按源码行号核对。

**按 -- System Details -- 交叉校验**

1. `Java Version` 的 major 与 `Minecraft Version` 要求不符时，`UnsupportedClassVersionError` 类报告可直接归因。
2. `JVM Flags` 中的 `-Xmx` 与 `Memory` 行的 `max` 应为同一值；两者不一致说明实际生效的不是日志里看到的参数。
3. `Backend library` 的 LWJGL 版本与 `Launched Version` 中的加载器组合应互相匹配。
4. `Is Modded` 为 `Definitely` 而 `Fabric Mods` / `Mod List` 为空或明显偏少，说明模组未被识别。
5. `Resource Packs` 里条目全带 `(incompatible)`，指向资源包或数据包版本不匹配。
6. `Memory` 的已用值贴近上限且报告为 `OutOfMemoryError` 时，属于堆不足而非模组缺陷。

**判读崩溃报告缺失的情形**

1. 日志只有 `Mod resolution failed` / `Missing or unsupported mandatory dependencies` 而无崩溃报告 → 加载器阶段终止，问题在依赖求解。
2. 日志有 `# A fatal error has been detected` 而无崩溃报告 → 原生崩溃，改看 `Problematic frame:`。
3. 崩溃报告写到一半被截断 → 崩溃发生在报告序列化过程中，或磁盘空间不足。

## 置信度线索

- **确定**：文件头为 `---- Minecraft Crash Report ----`，`Description:` 与 `-- System Details --` 两段齐全。此时版本、加载器、Java、内存、图形后端均为可直接引用的事实。
- **较确定**：只有控制台输出的 `Minecraft has crashed!` 而无报告文件，可判定为游戏层崩溃，但阶段与栈未知。
- **较确定**：报告头部出现 `WARNING: coremods are present:` 且其下列出条目，说明故障可能由 coremod 引入，即使栈顶指向别的包。
- **需追问**：`Description:` 为 `Initializing game` 且栈顶落在 `java.*` 时，需要模组列表才能收敛；报告未含 `Fabric Mods` / `Mod List` 段时应向用户索取完整模组目录。
- **需追问**：`Backend API` 为 `NO CONTEXT` 或 `CPU: <unknown>` 时，图形与硬件信息缺失，须向用户确认设备型号、SoC 与渲染器。
