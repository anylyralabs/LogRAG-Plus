# Minecraft 服务端常见问题（Paper / Purpur / Folia / Velocity / Geyser / Fabric / NeoForge）

## 签名 (Signature)

```
[12:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 3254ms or 65 ticks behind
[12:00:00] [Server thread/WARN]: Can't keep up! Did the system time change, or is the server overloaded? Running 5000ms behind

java.lang.OutOfMemoryError: Java heap space
java.lang.OutOfMemoryError: GC overhead limit exceeded
java.lang.OutOfMemoryError: Metaspace
[Full GC (Allocation Failure) 4096M->4095M(4096M), 12.3456789 secs]

java.lang.IllegalStateException: Failed to bind to port
Caused by: java.net.BindException: Address already in use
[Server thread/ERROR]: Perhaps a server is already running on that port?
**** FAILED TO BIND TO PORT!
The exception was: java.net.BindException: Address already in use: bind

[Server thread/WARN]: Watching Server Thread (21) for 40s (max 60s) -- server is probably hung
[Server thread/ERROR]: The server has not responded for 60 seconds! Creating thread dump

java.lang.ArrayIndexOutOfBoundsException: 48
	at net.minecraft.world.level.chunk.LevelChunk.initLighting
[Server thread/ERROR]: Couldn't load chunk [123, 45]
[Server thread/ERROR]: Chunk file at (12, 3) is missing

[Server thread/ERROR]: Missing or unsupported mandatory dependencies:
	Mod ID: 'fabric-api', Requested by: 'jei', Expected range: '[0.139.0+1.21.11,)', Actual version: '[MISSING]'
	Mod ID: 'sodium', Requested by: 'iris', Expected range: '[0.6,)', Actual version: '0.5.11'

[Server thread/ERROR]: Incompatibilities between mods:
	Mod 'irisshaders' is incompatible with 'sodium', versions: '[0.6,)'; Version found: '0.5.11'

[Server thread/ERROR]: Could not pass event PlayerJoinEvent to MyPlugin v1.0.0
java.lang.NoSuchMethodError: 'void org.bukkit.entity.Player.sendTitle(java.lang.String, java.lang.String)'
java.lang.NoClassDefFoundError: org/bukkit/event/player/PlayerJumpEvent

[18:50:54 INFO]: /127.0.0.1:49485 lost connection: If you wish to use IP forwarding,
    please enable it in your BungeeCord config as well!
[Server thread/ERROR]: This server is not configured for BungeeCord IP forwarding
velocity.error.modern-forwarding-failed: Your server did not send a forwarding request to the proxy.
    Make sure the server is configured for Velocity forwarding.
java.lang.IllegalStateException: Backend server is online-mode!

[Server thread/WARN]: Failed to load datapacks, can't proceed with server load
[Server thread/ERROR]: Failed to load datapack <名称>: <具体错误>
[Server thread/ERROR]: Errors in currently selected datapacks prevented the world from loading.

[Server thread/WARN]: This plugin is not Folia supported!
java.lang.IllegalStateException: Regionised multithreading requires plugins to be marked as Folia supported
```

## 含义

服务端故障分为四类，日志落点各不相同：

| 类别 | 日志位置 | 典型现象 |
|---|---|---|
| 性能（TPS / 卡顿） | 控制台 `Can't keep up`、`/spark` 报告 | 玩家体感延迟、方块回弹、实体瞬移 |
| 内存（GC / OOM） | 控制台 GC 日志、`hs_err_pid*.log` | 周期性卡顿后崩溃，或直接 `OutOfMemoryError` |
| 结构（区块 / 数据包） | `logs/latest.log`、`crash-reports/` | 加载特定区域崩溃、世界无法启动 |
| 网络（端口 / 代理） | 启动阶段或玩家连接阶段 | 服务器起不来、玩家进不去 |

**TPS 与 MSPT**：Paper 系用 MSPT（每 tick 毫秒数）衡量，1 tick 标准 50ms，MSPT 超过 50 即 TPS 低于 20。`Can't keep up` 的 `N ticks behind` 直接给出积压量。

**服务端与客户端日志的区分**：服务端日志线程名为 `Server thread`、`ServerMain`、`Region-Tick-Thread-*`（Folia），且不含 LWJGL、渲染器、OpenGL 相关内容；客户端日志线程名为 `Render thread`、`main`，并含 `Sound engine started` 等客户端标志。

## 常见触发

### 触发 A：TPS 掉帧与卡顿

服务端单 tick 的工作量超时。常见来源：

- **实体过多**：单区块实体上限 `entity-activation-range` 之外仍被 tick；养殖场、刷怪塔、掉落物堆积。Paper 的 `entities.spawning-per-tick` 与 `entity-per-chunk-save-limit` 控制上限。
- **区块加载**：`view-distance` 与 `simulation-distance` 设得过大（Paper 默认 10 / 10，每增 1 大约增加 20% 区块工作量）；刷石机、区块加载器强制常加载。
- **红石与方块更新**：高频红石时钟、大量漏斗（Hopper）互相传输、侦测器链。漏斗是单 tick 独立调度的方块实体，数量上千即显著拉低 MSPT。
- **插件同步阻塞**：插件在主线程执行数据库查询、HTTP 请求或遍历全服玩家。
- **Folia 线程分配不当**：`threaded-regions.threads` 与 chunk system 线程、GC 线程争抢 CPU，官方建议总线程数不超过可用 CPU 的 80%。

### 触发 B：内存不足与 GC 压力

- **堆内存不足**：`-Xmx` 低于世界规模所需（大型整合服常见 4096M 起步，模组服 6144M–8192M）。
- **内存泄漏**：插件或模组持有玩家/区块对象引用，表现为老年代使用量只升不降，`Full GC` 后回收量极小（如 `4096M->4095M`）。
- **Metaspace 溢出**：动态生成类过多（大量插件热重载、脚本插件反复创建类加载器）。
- **GC 参数不当**：使用 `-XX:+UseParallelGC` 且堆很大时停顿达秒级；现代服务端推荐 G1 或 ZGC。
- **原生内存耗尽**：堆外的 NIO 直接缓冲、Netty 池或原生库泄漏，堆内存正常但进程被杀。

### 触发 C：区块损坏与 region 文件问题

- **非正常关机**：断电、`kill -9`、容器被 OOM Killer 杀掉，导致 `.mca` 头部与数据区不一致。
- **第三方工具写入**：WorldEdit 的 `//regen`、地图编辑器、备份还原到一半。
- **跨版本回退**：用新版本打开过世界后再用旧版本启动，区块格式不被识别。
- **磁盘写满**：写入 region 文件时空间不足，产生零长度或截断的区块。

region 文件命名规则：`r.<x>.<z>.mca`，每个文件覆盖 32×32 个区块；`entities/r.<x>.<z>.mca` 与 `poi/r.<x>.<z>.mca` 是独立的实体与兴趣点文件，损坏时表现与主区块文件不同（实体丢失或村民失去工作点）。

### 触发 D：端口占用与绑定失败

- 已有另一个服务端实例在运行（同一目录重复启动最常见）。
- 端口被其他程序占用：Windows 上 `Hyper-V` 保留端口段、`svchost`；Linux 上残留的 `java` 进程。
- 权限不足：Linux 上绑定 1024 以下端口需 root 或 `CAP_NET_BIND_SERVICE`。
- 地址配置错误：`server-ip` 填了本机不存在的网卡地址。
- Docker 端口映射冲突：宿主机端口已被占用。

### 触发 E：代理配置（Velocity / BungeeCord）

代理转发需要**两端同时配置**，任何一端缺失都连不上：

| 代理 | 代理侧配置 | 后端服务端侧配置 |
|---|---|---|
| Velocity | `velocity.toml` 的 `player-info-forwarding-mode = "modern"` 或 `"legacy"` | `server.properties` 的 `online-mode=false`；Paper 系在 `config/paper-global.yml` 设 `proxies.velocity.enabled=true`、`secret` 与代理一致 |
| BungeeCord | `config.yml` 的 `ip_forward: true` 与 `online_mode` | `server.properties` 的 `online-mode=false`；`spigot.yml` 的 `bungeecord: true` |

`online-mode` 不匹配的具体后果：后端为 `true` 时 Velocity 抛 `Backend server is online-mode!` 并拒绝连接；后端未开 `bungeecord: true` 时 BungeeCord 报 `If you wish to use IP forwarding, please enable it in your BungeeCord config as well!`。

### 触发 F：插件与模组冲突

- **API 版本不匹配**：插件按旧版 Paper API 编译，调用已移除的方法，抛 `NoSuchMethodError` / `NoClassDefFoundError`，日志为 `Could not pass event <事件名> to <插件> v<版本>`。
- **插件重复注册同一命令**：后加载的插件覆盖前者，报 `Ambiguous plugin command`。
- **模组混装加载器**：Forge 模组放进 Fabric 的 `mods/`，或 NeoForge 模组放进 Forge——加载器直接拒绝启动并列出不兼容文件。
- **Mixin 冲突**：两个模组修改同一目标方法，抛 `Mixin apply failed` / `Injection failure`。
- **Folia 插件门控**：Folia 要求插件显式声明 `isFoliaSupported()`，未声明的插件被拒绝加载并提示 `This plugin is not Folia supported!`。

### 触发 G：Geyser 基岩版互通

- **Java 端不可达**：`config.yml` 的 `remote.address` 与 `remote.port` 未指向正确的 Java 服务端。
- **身份验证不匹配**：Java 服开启 `online-mode=true` 且未安装 Floodgate，基岩版玩家无法通过正版验证。
- **UDP 端口未放行**：Geyser 默认监听 `19132/udp`，防火墙只放行 TCP 会导致基岩版客户端连不上。
- **跨代理转发**：Geyser 位于 Velocity 后端时需配合 Floodgate，并在 `config.yml` 中设置 `auth-type: floodgate`。
- **版本落后**：Java 服更新后 Geyser 未同步更新，报协议版本不兼容或注册表解析失败。

### 触发 H：数据包加载失败

- 数据包 `pack.mcmeta` 的 `pack_format` 与当前版本不匹配。
- JSON 语法错误或引用了不存在的物品/标签 ID。
- 数据包放在 `world/datapacks/` 但未执行 `/datapack enable`。
- 服务端启动即报 `Failed to load datapacks, can't proceed with server load`，此时世界不会加载，需先移除出错的数据包。

## MC 版本 ↔ Java 版本对应

| Minecraft 版本 | 最低 Java |
|---|---|
| ≤ 1.16.5 | Java 8 |
| 1.17 – 1.20.4 | Java 17 |
| 1.20.5 – 1.21.x | Java 21 |
| 26.x | Java 25 |

各服务端软件的要求更为严格：Paper 26.3 与 Velocity 4.x 的构建工具链均已指向 Java 25，用低版本 Java 启动会直接报 `Unsupported class file major version`。Fabric 服务端对 Java 版本最宽松，但需与所装模组的要求取交集。

## 修复步骤

**触发 A（TPS 卡顿）**

1. 用 `/spark profiler start` 采样 30 秒后 `/spark profiler stop`，看报告里占比最高的顶层调用
2. 降低 `server.properties` 的 `view-distance` 与 `simulation-distance`（10 → 6）
3. 清理高频红石与漏斗：Paper 的 `config/paper-world-defaults.yml` 中 `hopper.disable-move-event` 与 `hopper-amount` 可降低开销
4. 限制实体：`entity-activation-range` 调低，清理掉落物与多余生物
5. 插件异步化：把数据库与网络调用移出主线程
6. Folia 上按官方建议重新分配 `threaded-regions.threads`，保证总线程数低于 CPU 核数的 80%

**触发 B（内存与 GC）**

1. 按世界规模上调 `-Xmx`（模组服 6144M–8192M，原版服 2048M–4096M），`-Xms` 取一半
2. 换用低延迟 GC：`-XX:+UseG1GC -XX:MaxGCPauseMillis=50`，或大堆用 `-XX:+UseZGC`
3. 怀疑泄漏时用 `/spark heapsummary` 或 `jmap -histo:live <pid>` 对比两次快照的对象增长
4. Metaspace 溢出时移除反复热重载的脚本插件，或加 `-XX:MaxMetaspaceSize=512m` 并排查类加载器泄漏
5. 原生内存问题用 `-XX:MaxDirectMemorySize` 限制直接缓冲，并检查 Netty 池配置

**触发 C（区块损坏）**

1. 先**停止服务端并完整备份** `world/` 目录
2. 定位损坏区域：日志中的 `Couldn't load chunk [x, z]` 换算出 region 文件 `r.<x>>5>.<z>>5>.mca`
3. 删除该 region 文件（区块会重新生成，建筑丢失）或从备份还原对应文件
4. 用 `MCEdit` / `Amulet` 打开世界删除问题区块，或使用 `/chunky` 等工具强制重新生成
5. Paper 会自动尝试重算损坏的 region 头部；反复报错说明损坏超出自动修复范围
6. 后续避免 `kill -9`，用 `stop` 命令正常关服

**触发 D（端口绑定）**

1. Linux：`ss -tlnp | grep 25565` 或 `lsof -i :25565` 查占用进程
2. Windows：`netstat -ano | findstr :25565` 后按 PID 结束进程
3. 确认没有在同一目录重复启动服务端
4. 修改 `server.properties` 的 `server-port`，或清空 `server-ip` 让其监听全部网卡
5. Docker 部署检查 `docker compose ps` 与端口映射是否与宿主机其他服务冲突

**触发 E（代理转发）**

1. 按上表把代理侧与后端侧**两处**都配好，缺一不可
2. 后端 `server.properties` 必须 `online-mode=false`
3. Paper 系后端在 `config/paper-global.yml` 的 `proxies.velocity` 中填入与 `velocity.toml` 完全一致的 `secret`
4. BungeeCord 场景在 `spigot.yml` 设 `bungeecord: true`
5. 改完重启代理与全部后端

**触发 F（插件模组冲突）**

1. 按日志中的插件名与事件名定位冲突插件，先单独禁用它验证
2. `NoSuchMethodError` / `NoClassDefFoundError` 指向插件与当前服务端 API 版本不兼容，升级该插件
3. 模组混装时按加载器分类整理 `mods/`：Fabric 只放 Fabric 模组，NeoForge 只放 NeoForge 模组
4. Mixin 冲突时二分法排查：移除一半模组启动，逐步缩小范围
5. Folia 上只能用明确声明支持 Folia 的插件

**触发 G（Geyser 互通）**

1. 确认 `config.yml` 的 `remote.address`/`remote.port` 指向正确的 Java 服务端
2. Java 服保持 `online-mode=true` 时安装 Floodgate 并把 Geyser 的 `auth-type` 设为 `floodgate`
3. 防火墙放行 `19132/udp`（Geyser 默认端口）与 Java 服的 TCP 端口
4. Geyser 与 Floodgate 版本需与 Java 服务端版本同步更新
5. 经代理接入时把 Geyser 配置为代理的后端服务之一

**触发 H（数据包）**

1. 修正 `pack.mcmeta` 的 `pack_format` 为当前版本对应值
2. 用 JSON 校验工具检查数据包内所有 `.json` 语法
3. 数据包放入 `world/datapacks/` 后执行 `/datapack list` 与 `/datapack enable "<名称>"`
4. 启动即失败时先移出全部数据包，确认能启动后再逐个放回

## 置信度线索

- **确定**：日志含 `Can't keep up` + `ticks behind` 数值（性能）、`Failed to bind to port` + `Address already in use`（端口）、`Missing or unsupported mandatory dependencies`（依赖）、`Couldn't load chunk` / `Chunk file at ... is missing`（区块）
- **较确定**：只有 `OutOfMemoryError` 无 GC 明细时，仍需 `hs_err_pid*.log` 或 GC 日志确认是堆内还是原生内存
- **需追问**：日志未标明服务端类型与版本（Paper / Purpur / Folia / Fabric / NeoForge）、Java 版本、`-Xmx` 取值时，应向用户确认；代理类问题需确认代理类型与 `online-mode` 两端取值
