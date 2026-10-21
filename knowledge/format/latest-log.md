# 游戏日志（logs/latest.log 与 logs/debug.log）

## 签名 (Signature)

```
[10:24:20] [main/INFO]: Loading Minecraft 26.2 with Fabric Loader 0.19.5
[10:24:20] [main/INFO]: Loading 59 mods:
	- fabric-api 0.161.0+26.2
	   |-- fabric-api-base 2.0.4+ece063239e
	- jei 27.4.0.15
[10:24:21] [ForkJoinPool-1-worker-4/WARN]: Mod xxx uses the version release-3.4.14-7 which isn't compatible with Loader's extended semantic version format
[10:24:23] [Render thread/INFO]: Backend library: LWJGL version 3.3.3+5
[10:24:25] [Render thread/INFO]: Reloading ResourceManager: vanilla
[10:24:31] [Render thread/INFO]: Sound engine started
[10:24:31] [Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas
[10:25:02] [Render thread/INFO]: Stopping!
```

Forge / NeoForge 的同一位置另带日志器名：

```
[12:59:59] [Render thread/WARN] [minecraft/Options]: Removed resource pack xxx from options because it doesn't seem to exist anymore
[13:00:00] [Forge Version Check/INFO] [ne.mi.fm.VersionChecker/]: [flywheel] Starting version check at https://api.modrinth.com/updates/flywheel/forge_updates.json
```

行结构固定为 `[<时间>/ <线程名>/<级别>]:`，Forge 系再追加一段 `[<来源>/]`。

## 含义

`logs/latest.log` 是当前会话的**全量控制台输出**（stdout 重定向），每次启动时被清空重写；`logs/debug.log` 同样每次重写，但记录额外的 DEBUG 级输出。

两者由启动参数控制：`-Dlog4j.configurationFile=` 指向的 log4j2 配置决定输出到文件还是仅控制台，以及级别过滤阈值。默认等级为 INFO，因此 latest.log 中不会有 DEBUG 行。

日志文件在游戏启动最早阶段就被创建，因此它覆盖了从加载器初始化到进程退出的完整时间线——这点与只覆盖崩溃瞬间的 crash-report 相反。

## 常见触发

### 时间戳与线程名

- 时间戳为 `[HH:mm:ss]`，不含日期，因此跨天的日志无法从时间戳判断先后。
- 线程名与所属子系统严格对应：

| 线程名 | 含义 |
|---|---|
| `main` | 启动主线程：加载器初始化、模组发现与元数据解析、依赖求解、注册表构建 |
| `Render thread` | 客户端渲染线程：窗口创建、资源加载、逐帧绘制、按键处理 |
| `Server thread` | 逻辑线程：单人世界时承载集成服务器 |
| `Worker-Main-N` | 并行工作池：模型烘焙、区块生成、字体加载 |
| `ForkJoinPool-N-worker-M` | 并行流任务：模组元数据扫描与版本解析 |
| `Netty Client IO #N` / `Netty Epoll Server IO #N` | 网络收发 |
| `Sound engine` / `Sound Engine` | 音频线程 |
| `IO-Worker-N` | 文件读写 |
| `<模组名> Worker` 等形式 | 模组自建线程 |

- 级别标记有 `INFO`、`WARN`、`ERROR`、`FATAL`、`DEBUG`、`TRACE`。
- 崩掉时 latest.log 会**戛然而止**：没有 `Stopping!`、没有异常栈，最后一行只是日常输出。此时真正的信息在 crash-report 或 hs_err 中，而非日志尾部。

### 启动流程锚点

客户端启动按固定顺序推进，卡住的位置就是故障域：

```
[main/INFO]: Loading Minecraft <版本> with Fabric Loader <版本>      ← 加载器已接管
[main/INFO]: Loading <N> mods:                                      ← 模组发现完成，列出全部
[main/INFO]: Loading <版本> mods:                                   ← Forge/NeoForge 的同等锚点
[ForkJoinPool-...]：模组元数据解析告警                              ← 版本号格式、重复 ID
[main/INFO]: SpongePowered MIXIN ... / Mixing ... into ...          ← 混入应用（细节仅在 debug.log）
[main/INFO]: Initializing game / 进入注册表构建
[Render thread/INFO]: Backend library: LWJGL version ...            ← 图形后端选定
[Render thread/INFO]: Reloading ResourceManager: ...                ← 资源重载开始
[Render thread/INFO]: Created: <宽>x<高>x<通道> minecraft:textures/atlas/blocks.png-atlas   ← 图集烘焙结束
[Render thread/INFO]: Sound engine started                          ← 音频就绪
[Render thread/INFO]: Stopping!                                     ← 正常退出
```

卡点含义：

| 最后出现的锚点 | 说明 |
|---|---|
| `Loading Minecraft ... with Fabric Loader` 之后立刻中断 | 依赖求解或模组元数据阶段失败 |
| `Loading N mods:` 列表中断或未出现 | 模组扫描期失败 |
| `Reloading ResourceManager` 之后很久无输出 | 资源包或模型烘焙卡死，多在 `Worker-Main-N` 线程 |
| `Backend library: LWJGL` 缺失 | 从未创建图形上下文，属启动器/原生库层 |
| 已有 `Sound engine started` 后崩溃 | 已进入可玩状态，属运行期问题 |

### 启动失败时该去哪一节看

这一节**只做指路，不写判据**。原因很实际：这里若逐条抄下完整报错原文，
检索时它会被当成「故障判据」排到真正的故障条目前面（实测过：某类报错的首条结果
曾是本文，而正确答案在 `patterns/` 里对应条目）。格式文档的职责是
「日志长什么样」，不是「这个错怎么修」。

| 你在日志里看到 | 去这里看判据 |
|---|---|
| `UnsupportedClassVersionError` / `class file version NN.0` | `patterns/version-mismatch.md` |
| `Failed to create mod instance` / `Could not execute entrypoint stage` | `patterns/fabric-loader-failure.md`、`patterns/forge-early-loading-failure.md` |
| `Missing or unsupported mandatory dependencies` / `Incompatible mods found` | `patterns/mod-dependency-failure.md` |
| `Duplicate mods found` / `Mods share ID with builtin mod` | `patterns/mod-conflict.md` |
| `is missing mods.toml` / `invalid LOC header` / `zip END header not found` | `patterns/mod-jar-corruption.md` |
| `Reference map ... could not be read` | `patterns/mixin-refmap-failure.md` |
| `Cowardly refusing to send event ... broken mod state` | `patterns/mod-config-timing-failure.md` |
| `module.FindException` / `Modules export package` | `patterns/version-mismatch.md` |
| `ZipException: zip END header not found` | `patterns/mod-jar-corruption.md` |
| `InvalidPathException` / 路径含中文冒号 | `patterns/path-encoding-failure.md` |
| `SIGILL` / `Problematic frame` | `patterns/native-lib-abi-mismatch.md`、`format/hs-err.md` |

**判断原则**：日志里出现某个异常名时，判据在 `patterns/`，
本文只负责告诉你「这个名字属于哪一类、该去看哪一节」。

### latest.log 与 debug.log 的差异

| 维度 | latest.log | debug.log |
|---|---|---|
| 级别 | INFO 及以上 | DEBUG 及以上 |
| 模组发现与依赖求解 | 摘要（`Loading N mods:` 与最终结果） | 每个候选版本的比较过程 |
| Mixin 应用细节 | 通常不出现 | 逐条 `Mixing <混入类> from <配置>.mixins.json into <目标类>` |
| 混入失败定位 | 只有最终的 `Mixin apply failed` | 可看到被拒绝的具体注入点与已应用者 |
| 类加载与资源查找 | 无 | 逐个类与资源的查找路径 |
| 体积 | 通常数百 KB | 可达数十 MB |

`Mixing xxx from yyy.mixins.json into zzz` 这一行是**混入目标映射的唯一完整来源**：`from` 给出提供混入的配置文件（即模组），`into` 给出被改写的基础类。当多个模组改写同一个 `into` 目标时，冲突范围只能由该行序列确定。该行默认只写入 debug.log。

### 网络与账号相关的干扰行

以下行在日志中常见但与崩溃无关，不应作为根因：

```
MinecraftClientHttpException: Status: 401
InvalidCredentialsException
FML appears to be missing any signature data
ClassNotFoundException: sun/java2d/SurfaceManagerFactory
Couldn't leave fullscreen: That operation is not supported
[Lightload] Runtime transformer patch unavailable
Could not find any graphics adapters!
appender Console has no parameter that matches element Policies
Missing sound for event: minecraft:item.goat_horn.play
```

其中 `Could not find any graphics adapters!` 在移动端属常态（GPU 不可探测），`FML appears to be missing any signature data` 是 Forge 每次启动都有的告警。

## 修复步骤

**按最后一行定位故障域**

1. 最后一行是 `Loading N mods:` 之后的模组列表片段 → 模组发现阶段，逐个核对列表中有无重复 id。
2. 最后一行是 `Reloading ResourceManager` 且长时间无后续 → 资源烘焙卡死，涉及资源包或模型数量。
3. 最后一行是普通 INFO 而进程消失 → 转看 `crash-reports/` 或 `hs_err_pid*`。
4. 最后一行含 `Stopping!` / `Stopping server` → 正常关闭，不是崩溃。

**从日志里提取「定位用的坐标」**

判据本身在 `patterns/`，这里只讲**怎么从日志里挖出足以定位的信息**：

1. `<类>(<文件名>:<行号>)` 形式的堆栈帧 → 文件名与行号是报告给模组作者的硬证据，
   也是判断「哪个 jar」的起点。
2. `provided by '<模组id>'` / `Requested by: '<模组id>'` → 该 id 就是肇事模组，
   不需要再去猜 jar 名。
3. `Reloading ResourceManager` 之前的最后一行 INFO → 卡死点就在这一行之后，
   而不是「日志的最后一句话」。
4. 同名异常出现多次时，**取时间戳最早的那一次**——后续多为连锁反应。

**利用 debug.log 缩小混入冲突范围**

1. 检索 `Mixing ` 得到全部混入目标类清单。
2. 比对同一目标类被哪些 `from` 配置文件改写。
3. 冲突方多于两个时，按配置文件名反查所属模组。
4. 需要判断某模组是否真的加载时，检索其 `into` 目标与入口类的出现与否，而非只看 `Loading N mods:` 列表。

**交叉校验**

1. `Loading Minecraft <A> with Fabric Loader <B>` 或 `Loading <A> mods:` 给出游戏版本与加载器版本，可与 crash-report 的 `Launched Version` 对照。
2. 日志中的 `SpongePowered MIXIN` / `Mixing` 计数可用于判断混入是否全部应用成功。
3. `Resource Packs` 与日志中的资源包加载行应一致；日志中缺失的包不会出现在游戏内。

## 置信度线索

- **确定**：日志首部含 `Loading Minecraft <版本> with Fabric Loader <版本>`（Fabric）或 `Loading <版本> mods:`（Forge/NeoForge），可确定游戏与加载器版本。
- **确定**：日志含 `Loading <N> mods:` 及随后的缩进列表，可确定实际加载的模组集合与版本。
- **确定**：日志含 `Reloading ResourceManager` 与 `Sound engine started`，可确定游戏已完成资源初始化并进入可玩状态。
- **较确定**：日志最后一行是普通 INFO 且无 `Stopping!`，可判定为非正常终止；真正的死因需从 crash-report 或 hs_err 获取。
- **较确定**：只有 latest.log 而无 debug.log 时，混入目标映射不可得，`Mixin apply failed` 的冲突双方无法确定。
- **需追问**：日志中模组清单与用户描述不符（用户称装了某模组但列表中没有）时，须向用户确认模组是否放入正确的实例目录，以及是否开启了版本隔离。
- **需追问**：日志未含 `Backend library` 行时，无法判断图形后端是否成功创建，须向用户确认渲染器类型与启动器。
