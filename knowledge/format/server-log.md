# 服务端日志（logs/latest.log 与代理日志）

## 签名 (Signature)

```
[11:57:02] [Server thread/INFO]: Starting minecraft server version 1.21.1
[11:57:02] [Server thread/INFO]: Loading properties
[11:57:02] [Server thread/INFO]: Default game type: SURVIVAL
[11:57:02] [Server thread/INFO]: Generating keypair
[11:57:02] [Server thread/INFO]: Starting Minecraft server on *:25565
[11:57:03] [Server thread/INFO]: Using epoll channel type
[11:57:03] [Server thread/INFO]: Preparing level "world"
[11:57:06] [Server thread/INFO]: Preparing start region for dimension minecraft:overworld
[11:57:06] [Worker-Main-1/INFO]: Preparing spawn area: 0%
[11:57:07] [Server thread/INFO]: Time elapsed: 1016 ms
[11:57:07] [Server thread/INFO]: Done (4.052s)! For help, type "help"
[11:57:07] [Server thread/INFO]: Loading Xaero's Minimap - Stage 2/2 (Server)
...
[14:35:28] [Server thread/INFO]: Stopping server
[14:35:28] [Server thread/INFO]: Saving players
[14:35:28] [Server thread/INFO]: Saving worlds
[14:35:28] [Server thread/INFO]: Saving chunks for level 'ServerLevel[world]'/minecraft:overworld
[14:35:28] [Server thread/INFO]: ThreadedAnvilChunkStorage (world): All chunks are saved
```

代理服务端（BungeeCord 系）：

```
Listening on /0.0.0.0:25577
[INFO] Enabled plugin xxx version yyy by zzz
```

代理服务端（Velocity 系）启动段含：

```
[INFO]: Booting up Velocity 3.3.0...
```

## 含义

服务端日志的**行结构与客户端完全一致**（`[时间] [线程名/级别]:`），差异在内容与进程：

| 维度 | 客户端 | 服务端 |
|---|---|---|
| 主线程名 | `Render thread` | `Server thread` |
| 是否存在渲染线程 | 有 | **无** |
| 是否有窗口与图形后端 | 有 `Backend library` / `Backend API` / `GFLW Platform` | 无 |
| 启动锚点 | `Reloading ResourceManager` / `Sound engine started` | `Starting minecraft server version` / `Done (Xs)!` |
| 就绪标志 | 界面出现 | `Done (Xs)! For help, type "help"` |

单人游戏内置的集成服务器会把两套线程写进**同一份** `latest.log`：既有 `Render thread` 也有 `Server thread`，此时该日志兼具两类特征。专用服务端则永远只有 `Server thread`。

## 常见触发

### 启动阶段锚点

```
[Server thread/INFO]: Starting minecraft server version <版本>
[Server thread/INFO]: Loading properties
[Server thread/INFO]: Default game type: <SURVIVAL|CREATIVE|ADVENTURE|SPECTATOR>
[Server thread/INFO]: Generating keypair
[Server thread/INFO]: Starting Minecraft server on <绑定地址>:<端口>
[Server thread/INFO]: Using <epoll|nio|kqueue|default> channel type
[Server thread/INFO]: Preparing level "<世界名>"
[Server thread/INFO]: Preparing start region for dimension minecraft:overworld
[Worker-Main-N/INFO]: Preparing spawn area: <N>%
[Server thread/INFO]: Time elapsed: <N> ms
[Server thread/INFO]: Done (<N>s)! For help, type "help"
```

| 锚点 | 含义 |
|---|---|
| `Starting minecraft server version <版本>` | 服务端主类已接管，版本已确定 |
| `Loading properties` | 读取 `server.properties` |
| `Default game type` | 默认游戏模式 |
| `Generating keypair` | 生成用于加密通信的密钥对 |
| `Starting Minecraft server on <地址>:<端口>` | 监听绑定，`*` 表示所有网卡 |
| `Using epoll channel type` | Linux 上的网络 IO 实现；`nio` 为平台无关实现 |
| `Preparing level "<世界名>"` | 开始加载主世界存档 |
| `Preparing start region for dimension <维度>` | 预生成出生点区块 |
| `Preparing spawn area: <N>%` | 由 `Worker-Main-N` 线程输出，进度百分比 |
| `Time elapsed: <N> ms` | 出生点准备耗时 |
| `Done (<N>s)! For help, type "help"` | **服务端完全就绪**，可接受连接 |

`Done` 行之前中断即启动失败；之后出现的异常则属运行期问题。

### 插件与模组加载输出

服务端（尤其 Paper / Purpur / Spigot）在 `Done` 前后输出插件清单：

```
[Server thread/INFO]: Loading server plugin <插件名> v<版本>
[Server thread/INFO]: [<插件名>] Enabling <插件名> v<版本>
[Server thread/INFO]: [<插件名>] <插件自己的日志>
```

- `Loading server plugin` 属加载阶段，`Enabling` 属启用阶段；启用阶段抛异常会导致该插件功能全失但服务端仍可启动。
- 插件日志行带方括号插件名前缀，这是区分服务端本体输出与插件输出的唯一标志。
- `[Server thread/WARN]: <插件名> has registered a command that is already in use` 一类告警表示命令冲突，不影响启动。
- Forge/NeoForge 模组服务端的输出格式与客户端相同（`Loaded Mods`、`Mod resolution failed` 等），额外出现 `Setting user`、`Preparing level` 等服务端专属行。

### Paper / Purpur 的额外输出

Paper 系在 Vanilla 锚点之外另加：

```
[Server thread/INFO]: Paper: Using <N> thread(s) for world generation
[Server thread/INFO]: Paper: Using <N> thread(s) for lighting
[Server thread/INFO]: Server Ping Player Sample Count: <N>
[Server thread/INFO]: Using <N> threads for Netty based IO
[Server thread/INFO]: [Anti-Xray] <配置状态>
[Server thread/INFO]: Successfully loaded <N> recipes, adding to the tag
[Server thread/INFO]: Loaded <N> advancements
[Server thread/INFO]: Registering commands...
[Server thread/INFO]: Preparing start region for dimension minecraft:overworld
```

`Timings` 报告以命令 `/timings paste` 触发，输出结果为一条可访问的 URL；`spark` 报告由 `/spark profiler` 或 `/spark tps` 触发，其原始输出与聚合结果写在 `plugins/spark/` 或服务端根目录下，不在 `latest.log` 内。两者都是**外部生成的报告文件**，日志中只留有触发记录。

### 运行期高频输出

```
[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 5000ms or 100 ticks behind
```

服务端主循环落后于预定 tick 时间时输出，附带落后毫秒数与等效 tick 数。默认实现为 `LOGGER.warn`，触发条件是落后时间超过阈值且距上次告警已过告警间隔。数值持续增大表示服务端算力不足或被阻塞。

```
[Server thread/INFO]: <玩家名> joined the game
[Server thread/INFO]: <玩家名> left the game
[Server thread/INFO]: <玩家名> lost connection: <原因文本>
```
玩家进出与断连。`lost connection` 后的原因文本来自网络层异常描述。

```
[Server thread/WARN]: Mismatch in destroy block pos
[Server thread/WARN]: Failed to handle packet ...
[Server thread/WARN]: Ignoring packet ...
[Netty Epoll Server IO #2/ERROR]: Error sending packet client <连接标识>
[Worker-Main-N/WARN]: Saving chunks for level 'ServerLevel[world]'/minecraft:overworld took <N> ms
```
前三行为协议层告警，常在客户端模组与服务端版本不一致时出现；`Netty ... IO #N` 前缀表示网络线程的错误，独立于 `Server thread` 输出；最后一行是区块保存耗时告警。

### 关闭阶段锚点

```
[Server thread/INFO]: Stopping the server
[Server thread/INFO]: Stopping server
[Server thread/INFO]: Saving players
[Server thread/INFO]: Saving worlds
[Server thread/INFO]: Saving chunks for level 'ServerLevel[<世界名>]'/minecraft:<维度>
[Server thread/INFO]: ThreadedAnvilChunkStorage (<维度目录>): All chunks are saved
[Server thread/INFO]: Flushing Chunk IO
[Server thread/INFO]: Closing Thread Pool
```

`Stopping the server` 是玩家下达关闭指令，`Stopping server` 是主类的关闭钩子开始执行。完整走完 `All chunks are saved` 才是正常关闭；中途中断意味着强制终止，存档可能不完整。

### 代理服务端日志特征

代理（Velocity / BungeeCord）的日志与游戏服明显不同：

| 特征 | Velocity | BungeeCord |
|---|---|---|
| 启动输出 | `Booting up <名称> <版本>...` | `Listening on <地址>:<端口>` 与 `Enabled plugin` 列表 |
| 日志器 | log4j2，行含 `[INFO]` 级别且线程名常缺省 | `java.util.logging`，格式为 `[INFO] <消息>` |
| 监听行 | 独立的监听地址输出 | `Listening on /0.0.0.0:25577` |
| 玩家路由 | 后端服连接与切换记录 | `[<玩家>] <玩家> has connected` / `connected to <后端服名>` |
| 是否加载世界 | 否 | 否 |
| 是否存在 `Server thread` | 否 | 否 |

代理日志中**不会出现** `Preparing level`、`Starting minecraft server version`、`Done (Xs)!` 等世界加载锚点——代理不加载任何世界。若日志中有这些行，则它是游戏服而非代理。

## 修复步骤

**按 `Done (Xs)!` 是否存在分流**

1. 无 `Done (Xs)!` → 启动期失败，按最后出现的锚点定位：卡在 `Loading properties` 是配置问题；卡在 `Preparing level` 是存档问题；卡在 `Preparing start region` 是出生点生成问题；卡在模组加载输出是加载器问题。
2. 有 `Done (Xs)!` → 服务端已就绪，后续异常属运行期问题，按崩溃点上下文排查。
3. `Done (Xs)!` 后的秒数异常大（数十秒以上）与默认不符时，属世界加载或出生点生成耗时过长。

**按锚点判读存档状态**

1. 有 `Stopping the server` 与完整的 `All chunks are saved` → 正常关闭。
2. 有 `Stopping the server` 而缺少 `All chunks are saved` → 关闭过程中被强制终止，需检查存档一致性。
3. 完全无 `Stopping` 行而进程消失 → 崩溃或被杀，转查是否有 `crash-reports/` 或 `hs_err_pid*`。
4. `Preparing level` 之后无 `Preparing start region` → 主世界存档加载阶段失败。

**判读性能与阻塞**

1. `Can't keep up!` 行的毫秒数与 tick 数是落后幅度的直接读数；两者同时增大表示持续落后。
2. `Time elapsed: <N> ms` 是出生点准备耗时基线，与后续同类记录对比可判断世界是否异常膨胀。
3. `Worker-Main-N` 线程只在区块生成与光照计算期间输出，其进度行长时间停留在低百分比说明生成缓慢。
4. 落后发生在特定操作之后（区块生成、玩家传送、插件命令）时，按该操作定位。

**按线程名与插件前缀分流**

1. `Server thread` → 游戏逻辑与插件逻辑；`Netty ... IO #N` → 网络收发；`Worker-Main-N` → 区块与光照；`Craft Scheduler Thread` / `pool-N-thread-M` → 插件或模组的异步任务。
2. 缺失 `Server thread` 但存在 `[INFO]` 无线程名行 → 属代理服务端而非游戏服。
3. 日志行带 `[<插件名>]` 前缀 → 属该插件输出，按插件归因。
4. 插件在 `Enabling` 阶段抛异常但 `Done (Xs)!` 仍出现 → 该插件功能缺失，服务端本体正常；在 `Loading server plugin` 阶段抛异常导致启动中断 → 移除该插件验证。
5. 无任何插件前缀而报错发生在插件类包名上 → 插件通过服务端本体接口调用，按栈定位。

## 置信度线索

- **确定**：日志含 `Starting minecraft server version <版本>`、`Preparing level "<世界名>"`、`Done (<N>s)! For help, type "help"` 三行，可确定这是游戏服务端日志、版本、世界名与启动总耗时。
- **确定**：日志含 `Stopping the server` 且随后有 `All chunks are saved`，可确定服务端正常关闭、存档已落盘。
- **确定**：日志**不含** `Render thread` 与 `Backend library`，可确定这是专用服务端而非客户端。
- **确定**：日志含 `Booting up <名称> <版本>...` 或 `Listening on <地址>` 而无世界加载锚点，可确定这是代理服务端。
- **较确定**：日志含 `Can't keep up! Is the server overloaded? Running <N>ms or <N> ticks behind`，可判定服务端 tick 落后，落后幅度由两个数值给出。
- **较确定**：日志同时含 `Render thread` 与 `Server thread`，可判定为单人游戏的内置集成服务器，而非专用服务端。
- **需追问**：无 `Done (Xs)!` 且日志在模组或插件输出处中断时，须向用户确认服务端类型（Paper / Purpur / Forge / Fabric / 代理）、加载的插件或模组清单。
- **需追问**：`Can't keep up!` 频繁出现时，须向用户确认服务器 CPU 核数、内存分配（`-Xmx`）与在线玩家数，才能判断是容量不足还是单点阻塞。
- **需追问**：日志中世界名与用户描述不符时，须向用户确认启动参数中的 `--world` / `level-name` 及工作目录。
