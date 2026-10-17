# 启动器日志（Android 与 PC）格式解读

## 签名 (Signature)

启动器自身的日志由启动器进程写出，与游戏日志分属两个文件、两套格式。

**ZalithLauncher2 / FCL / Pojav 系（Android）**

```
==================== Launch Minecraft ====================
▷ Launcher version: 2.2.1 (200011)
▷ Architecture: arm64
▷ Device model: INFINIX, Infinix X6817
▷ API version: 31
▷ Renderer: MobileGlues (OpenGL 4.0, 1.17+)
▷ Renderer Summary: Dari plugin MobileGlues
▷ Selected Minecraft version: 1.21.4 Fabric 0.18.44
▷ Minecraft Info: 1.21.4, Fabric - 0.18.4
▷ Game Path: /storage/emulated/0/Android/data/<包名>/files/.minecraft/versions/1.21.4 Fabric 0.18.44 (Isolation: true)
▷ Custom Java arguments: NONE
▷ Java Runtime: Internal-21
▷ Account: xX4foce4pXx (Local)
==================== Env Map ====================
Added env: TMPDIR = /data/user/0/<包名>/cache
Added env: POJAV_NATIVEDIR = /data/app/~~...==/lib/arm64
Added env: LIBGL_EGL = libmobileglues.so
==================== JVM Args ====================
▷ /data/user/0/<包名>/files/games/runtimes/.../bin/java
▷ --accessToken
▷ ********************
```

启动器自身崩溃时另有一个文件：

```
================ ZalithLauncher Crash Report ================
▷ Time: 31 thg 7, 2026 11:16:57
▷ Device: BG6-OP TECNO BG6
▷ Arch: arm64
▷ Android Version: 13
▷ Launcher Version: 2.4.10, build: arm64
===================== Crash Stack Trace =====================
java.lang.OutOfMemoryError: Failed to allocate a 36920416 byte allocation ...
	at java.util.Arrays.copyOf(Arrays.java:4245)
	at qm5.b(SourceFile:775)
```

**FCL 系（Android，Pojav 后端）**

```
==================== Basic Information ====================
FCL Version: 1.2.4.4
Architecture: arm64
Android SDK: 33
Java Version: 21
Renderer: VGPU
Summarize: Application error, unable to launch, exit code = 1
==================== Basic Information ====================

==================== Before Start ====================
invoke redirectStdio
invoke setLogPipeReady
Log pipe ready.
invoke setFCLNativeWindow
[FCL Internal] /home/runner/work/FoldCraftLauncher/.../fcl_bridge.c:64
setFCLNativeWindow : 0x7c14db0010, size : 967x432
invoke setEventPipe
==================== Start Minecraft ====================
Renderer: Krypton Wrapper
Device: Vivo PD2443 V2443A
Architecture: arm64
CPU: MT6835
Android SDK: 35
FCL Version Code: 1331
==================== Env Map ====================
Env: LIBGL_NAME=libng_gl4es.so
Env: LIBGL_STRING=Renderer(name=Holy-GL4ES, glName=libng_gl4es.so, maxMCver=1.20.1)
```

**Axolotl（美西螈启动器，基于 Modrinth App / theseus）**

```
===== launcher_log.txt =====
# Minecraft launcher log started at 2026-10-15 22:17:07
# Instance: 26.2-Fabric 0.19.5

[22:17:08] [main] [FabricLoader/GameProvider/INFO]: Loading Minecraft 26.2 with Fabric Loader 0.19.5
[22:17:08] [main] [FabricLoader/Mappings/INFO]: Mappings not present!
[22:17:08] [main] [FabricLoader/INFO]: Loading 77 mods:
	- baritone 1.19.0
	   \-- dev_babbaj_nether-pathfinder 1.6

===== latest.log =====
[22:17:08] [main/INFO]: Loading Minecraft 26.2 with Fabric Loader 0.19.5

===== crash-2026-10-15_23.05.50-client.txt =====
---- Minecraft Crash Report ----
```

**PC 启动器**

```
[12:44:32] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher 10.0.9+... starting: java version 17.0.8 by Microsoft; OS Windows 10 arch amd64 version 10.0
Minecraft folder is: C:/Users/.../MultiMC/instances/<实例名>/.minecraft
Java path is: C:/Program Files/Java/jre1.8.0_271/bin/javaw.exe
Java is version 1.8.0_271, using 64-bit architecture.
Main Class: net.minecraft.launchwrapper.Launch
Native path: C:/Users/.../instances/<实例名>/natives
```

与游戏日志的区分：启动器日志含 `Launch Minecraft` / `Basic Information` / `Env Map` / `MODLAUNCHER` 等启动器专有段，且**模组列表为空或未加载**；游戏日志含 `net.minecraft.*` 栈帧与模组清单。

Axolotl 是一个例外：它的 `launcher_log.txt` 同时含 `FabricLoader/GameProvider`、`ModLauncher running` 与**完整模组清单**，且三行头部的存在使「文件第一节必为 `launcher_log.txt`」成为判据（见下文对应小节）。

## 含义

启动器日志回答的是「**用什么环境启动的**」：设备、架构、渲染器、Java 运行时、JVM 参数、环境变量。这些信息游戏侧通常看不到，因此设备兼容性问题必须回到本层确认。两层日志的分工是固定的：

| 层 | 职责 | 崩溃位置 |
|---|---|---|
| 启动器层 | 管理 Java 运行时、注入 LWJGL 与渲染器原生库、组装 classpath 与 JVM 参数、创建窗口 | JVM 创建前或窗口创建前 |
| 游戏层 | 加载模组、注册表、资源、世界 | 进入游戏之后 |

## 常见触发

### ZalithLauncher2 的分节结构

分节标题统一由 `LoggerBridge.appendTitle` 生成，格式为 20 个等号 + 空格 + 标题 + 空格 + 20 个等号；字段行统一用 `▷ ` 前缀。分节依次为 `Launch Minecraft`（启动参数摘要）、`Env Map`（注入的环境变量，每行 `Added env: KEY = VALUE`）、`DLOPEN Java Runtime`（动态装载运行时组件）、`JVM Args`（最终命令行参数，每行 `▷ <参数>`，`--accessToken` 的值固定以 `********************` 掩码）、`Launch JVM`（附 `Java arguments: ` 后接完整参数块），失败时另有 `Init Env Failed`（逐行列出失败的 `key = value`）。

`Launch Minecraft` 段的字段顺序固定：

| 字段 | 取值形态 | 含义 |
|---|---|---|
| `Launcher version` | `2.2.1 (200011)` | 版本名 + 版本号 |
| `Architecture` / `API version` | `arm64` / `31` | 设备架构与 Android SDK 级别（31 = Android 12） |
| `Device model` | `INFINIX, Infinix X6817` | 厂商, 型号 |
| `Renderer` / `Renderer Summary` | `MobileGlues (OpenGL 4.0, 1.17+)` / `Dari plugin MobileGlues` | 当前渲染器名与能力描述；Summary 可能缺省 |
| `Selected Minecraft version` / `Minecraft Info` | `1.21.4 Fabric 0.18.44` / `1.21.4, Fabric - 0.18.4` | 实例目录名与解析出的游戏、加载器版本 |
| `Game Path` | 绝对路径 + `(Isolation: true)` | 实例位置与是否版本隔离 |
| `Custom Java arguments` / `Java Runtime` | `NONE` / `Internal-21` | 用户自定义参数与选用的内置运行时 |
| `Account` | `xX4foce4pXx (Local)` | 账号名与类型（`Local` = 离线号） |

`Renderer` 的取值形态因后端而异，可直接看出实现：`MobileGlues (...)`、`Krypton Wrapper`、`Holy-GL4ES`、`VGPU`、`LTW`、`VirGLRenderer`、`ANGLE`。

日志文件位于 `<外部存储>/Android/data/<包名>/files/logs/` 下，分四个角色：`latest_game.log` 为游戏进程的标准输出（`GAME` 通道）、`latest_jvm.log` 为 JVM 启动阶段的输出（`JVM` 通道，JVM 创建失败时的唯一现场）、`launcher_crash.log` 为启动器自身崩溃报告（即 `Crash Report` 格式）、`native/` 为原生层日志目录；另在 `files/terracotta.log` 记录 Terracotta 多开组件日志。`latest_jvm.log` 与 `latest_game.log` 的分工是**进程阶段**的：前者覆盖 JVM 起不来、运行时装载失败的场景（此时后者为空或不存在）。

### FCL 的分节结构
分节标题格式为 20 个等号 + 空格 + 标题 + 空格 + 20 个等号，字段无前缀，环境变量行以 `Env: ` 前缀。分节依次为 `Basic Information`（出现两次：原生层初始化前与失败汇总时）、`Before Start`（原生层接管，其下为 `invoke redirectStdio` / `invoke setLogPipeReady` / `invoke setFCLNativeWindow` / `invoke setEventPipe` 四个调用与 `Log pipe ready.` 之类的回执）、`Start Minecraft`（设备与运行环境）、`Mods`（内置模组列表，通常为空行）、`Env Map`（环境变量）。

| 字段 | 取值示例 |
|---|---|
| `FCL Version` / `FCL Version Code` | `1.2.4.4` 与 `1244` |
| `Architecture` / `Android SDK` / `Java Version` | `arm64`、`33` 与 `21`（纯数字，与 Zalith 的 `Internal-21` 命名不同） |
| `Renderer` / `Summarize` | `Renderer: VGPU` 与 `Summarize: Application error, unable to launch, exit code = 1` |
| `Device` / `CPU` / `Language` | `Infinix X6525-OP Infinix X6525`（`<设备代号>-OP <型号>`）、SoC 型号（`T606`、`kirin`、`mt6781`、`SM8550`）与语言标识（`en_US` / `zh_CN_#Hans`） |

原生层输出以 `[FCL Internal] <构建机绝对路径>:<行号>` 标注，其后是原生函数的返回或错误信息，例如 `fcl_loader.c:130`、`fcl_bridge.c:64`、`fcl_event.c:190`；形如 `setFCLNativeWindow : 0x..., size : 2240x1472` 的行表示窗口句柄与尺寸。`DLOPEN: loading <路径>` 行指出接下来要装载的原生库。FCL 的日志目录为外部存储的 `FCL/log`，游戏日志文件名为 `latest_game.log`；内置运行时位于应用私有目录的 `runtime/java/jre8`、`jre17`、`jre21`、`jre25`。

### axolotl 的分节结构

Axolotl（美西螈启动器，基于 Modrinth App 的 `theseus` 启动核心）是**桌面（Windows/Linux/macOS）启动器**，但它的日志与 ZL2 / FCL 走的是同一套「多文件合并导出」形态：把实例目录下若干日志文件按 `===== <文件名> =====` 逐节拼接成一份上传。

分节标记为 **5 个等号 + 空格 + 文件名 + 空格 + 5 个等号**（ZL2 / FCL 是 20 个等号，这是最快的第一眼判据）。实测出现的分节名固定为这几类：

| 分节名 | 内容 |
|---|---|
| `launcher_log.txt` | 启动器日志，含三行头部与全部启动输出，**模组清单也在这里** |
| `latest.log` | 游戏日志（`logs/latest.log`） |
| `debug.log` | 游戏调试日志（`logs/debug.log`） |
| `crash-<年>-<月>-<日>_<时>.<分>.<秒>-client.txt` | 客户端崩溃报告 |
| `crash-<年>-<月>-<日>_<时>.<分>.<秒>-fml.txt` | FML / 加载器阶段崩溃报告 |
| `crash-<年>-<月>-<日>_<时>.<分>.<秒>-server.txt` | 内置服务器（单人世界的集成服务端）崩溃报告 |
| `hs_err_pid<PID>.log` | JVM 致命错误转储 |
| `authlib-injector.log` | 第三方认证注入（外置登录）日志 |

**分节顺序不固定**：`launcher_log.txt` 多数情况下是第一节，但实测存在 `latest.log` 或崩溃报告排在首节、甚至只有单个 `crash-*-server.txt` 分节的情况。判断来源**不要依赖节序**，要看节内内容。

`launcher_log.txt` 的第一节固定以两行头部开头：

```
# Minecraft launcher log started at 2026-10-15 22:17:07
# Instance: 26.2-Fabric 0.19.5

```

- 第二行末尾带**一个尾随空格**，其后是空行，再进入日志正文。
- `# Instance:` 的值即**实例目录名**，形态有三类：自动生成的 `<版本>-<加载器> <加载器版本>`（`26.2-Fabric 0.19.5`、`1.21.1-NeoForge 21.1.262`）、`<加载器> <版本>`（`Forge 1.20.1`），以及用户自取的整合包名（`StellarTech`、`Create-Delight-Remake`、`登神者：天阶咏叹v1.6.1fix (1)`）。
- 头部**没有**设备型号、架构、渲染器、Java 运行时、JVM 参数信息——这些要到游戏层 `-- System Details --` 段才能拿到，这是与 Zalith / FCL 最大的信息差。

日志行是**三段式前缀** `[时间] [线程] [模块/类型]:`，而 ZL2 / FCL 是两段 `[时间] [线程/级别]`：

```
[22:17:08] [main] [FabricLoader/GameProvider/INFO]: Loading Minecraft 26.2 with Fabric Loader 0.19.5
[22:17:08] [main] [FabricLoader/Mappings/INFO]: Mappings not present!
[22:17:08] [ForkJoinPool-1-worker-3] [FabricLoader/Metadata/WARN]: Mod punchy uses the version 2.8f ...
```

第三段是 `<模块>/<级别>`，模块名可能是加载器（`FabricLoader/*`、`cpw.mods.modlauncher.Launcher/*`、`LaunchWrapper/*`、`FML/*`）、模组（`Sodium/*`、`Lithium/*`、`tweakeroo/WARN`）或纯转发通道（`STDOUT/INFO`）。`debug.log` 分节的时间戳是**中文月份格式**，段数也多一层：

```
[1610月2026 10:02:02.075] [main/DEBUG] [mixin/]: Mixing StringRepresentableMixin from kubejs.mixins.json into ...
[10:31:33] [modloading-worker-0] [STDOUT/INFO]: [dev.tr7zw.trender.gui.impl.client.LibGuiClient:onInitializeClient:37]: [TRender] Initializing Client...
```

`[1610月2026 …]` 即「16 日 10 月 2026」，与 `latest.log` 的 `[HH:MM:SS]` 是同一台机器的两种格式。第四段 `[来源:方法:行]` 只出现在模组自行转发的 `STDOUT` 通道上。

`launcher_log.txt` 内同样会打印 `Loading <N> mods:` 的**缩进树形清单**（Fabric 与 Forge/NeoForge 均有），缩进为一个制表符，子依赖再补三个空格加分支符：

```
[22:17:08] [main] [FabricLoader/INFO]: Loading 77 mods:
	- baritone 1.19.0
	   \-- dev_babbaj_nether-pathfinder 1.6
	- carpet 26.2+v260616
	- fabric-api 0.161.0+26.2
	   |-- fabric-advancement-api-v1 1.0.0+58719a3b9e
	   \-- fabric-api-base 2.0.4+ece063239e
```

最后一个子依赖用 `\--`，中间用 `|--`；`- modid 版本` 是顶层模组。另有 Modrinth 生态的 `modid 版本 via 宿主模组` 写法（`autoconfig1u 3.2.2 via capes`）表示该模组由宿主模组内嵌提供。**发行版本号位被替换为 `**.**.**.**` 的行**（如 `- chattools **.**.**.**`）是上传链路的数字脱敏结果，不是日志原文如此，不能据此判断版本缺失。

启动结束时追加一行退出码，形如（`#` 开头，位于 `launcher_log.txt` 末行）：

```
# Process exited with status: exit code: 1
# Process exited with status: exit code: 0xffffffff
# Process exited with status: exit status: 1
```

`exit code:` 给出的是进程退出码，`exit status:` 表示拿不到退出码（进程被信号终止或启动器未取到状态）。Windows NTSTATUS 形态的码有固定含义：`0xffffffff` = `-1`、`0xfffffff8` = `-8`、`0xc0000005` = 访问违例（`EXCEPTION_ACCESS_VIOLATION`）、`0xc0000409` = 栈缓冲越界。主机耗尽内存、驱动崩溃、JVM 段错误都会走到这里，同时通常还会多出 `hs_err_pid*.log` 分节。

游戏层崩溃时，`launcher_log.txt` 末尾会出现游戏写出的标记行，其后紧跟被单列为一个分节的崩溃报告：

```
#@!@# Game crashed! Crash report saved to: #@!@# C:\Users\********\AppData\Roaming\red.ghs.axolotl\profiles\26.2-Fabric 0.19.5\crash-reports\crash-2026-10-15_23.05.50-client.txt
```

Axolotl 自己会做一层**占位符脱敏**：账号名与 UUID 在启动参数、`Setting user:`、玩家登录行等处被替换为 `{MINECRAFT_USERNAME}` 与 `{MINECRAFT_UUID}`。这是启动器写日志时就替换好的，与上传链路（`C:\Users\****` 、`accessToken` 掩码）的脱敏是两回事——同一个占位符也可能出现在栈帧里被误伤（如 `FormattedException.java:5{MINECRAFT_USERNAME}`），它本身不携带任何诊断信息，判读时应忽略。

**目录结构**：`--gameDir` 指向 `<数据目录>/profiles/<实例名>`，资源与库分别在 `<数据目录>/meta/assets` 与 `<数据目录>/meta/libraries`；默认数据目录为 `%APPDATA%\red.ghs.axolotl`（Windows），用户可在安装时改到任意路径（实测有 `D:\Games\Axolotl_Lau\gameA`、`D:\文档\red.ghs.axolotl`）。`profiles/` 与 `meta/` 的并列关系是识别 Axolotl 路径的关键。

**启动核心归属**：Axolotl 复用 Modrinth App 的 `theseus` 启动器核心，因此依赖解析失败的栈尾固定出现：

```
	at com.modrinth.theseus.MinecraftLaunch.relaunch(MinecraftLaunch.java:78)
	at com.modrinth.theseus.MinecraftLaunch.main(MinecraftLaunch.java:34)
```

`theseus` 帧 + 5 等号分节 + 两行 `#` 头部，三者同时出现即可判定为 Axolotl。此外，进入游戏后 `latest.log` 的 `-- System Details --` 段会带一行 `Launcher name: Axolotl Launcher`（`GFLW Platform: win32` 给出窗口平台），这是**游戏侧**的自我声明，可作为交叉验证。

### 环境变量字段的判读

Pojav 系启动器共用一套渲染器与运行时注入协议，`Env Map` 段中的键名含义固定：

| 环境变量 | 含义 |
|---|---|
| `POJAV_NATIVEDIR` / `FCL_NATIVEDIR` | 启动器 APK 的 `nativeLibraryDir`，注入的原生库都从这里加载 |
| `JAVA_HOME` / `PATH` / `LD_LIBRARY_PATH` | 实际使用的运行时根目录（末段即 `jre8` / `jre17` / `jre21` / `jre25`）、以运行时 `bin` 打头的搜索路径、原生库搜索路径（含 `vendor/lib64` 与 APK 的 `lib/arm64`） |
| `LIBGL_NAME` / `LIBGL_STRING` | 渲染器实现库文件名（如 `libvgpu.so`、`libng_gl4es.so`、`libmobileglues.so`）与完整描述串（含名字、库名、支持的 MC 版本范围） |
| `LIBGL_ES` / `LIBGL_MIPMAP` | GLES 版本标记（`2` 表示 GLES2 路径）与 Mipmap 生成策略 |
| `LIBGL_NOERROR` / `LIBGL_NOINTOVLHACK` / `LIBGL_NORMALIZE` | 渲染器兼容性开关 |
| `LIBEGL_NAME` / `SDL_OPENGL_LIBRARY` / `DRIVER_PATH` | EGL 实现库名（通常 `libEGL.so`）、SDL3 后端的 OpenGL 实现、图形驱动库目录 |
| `JSP` | Java 结构体代理库路径（Java 11+ 特有，`libjsph17` / `libjsph21`） |
| `TMPDIR` / `HOME` / `FORCE_VSYNC` / `MOD_ANDROID_RUNTIME` | 临时目录（指向应用 cache）、JVM 工作目录、垂直同步强制开关、模组侧 Android 运行时标记 |

### PC 启动器的日志位置与命名

| 启动器 | 日志位置与命名 | 格式特征 |
|---|---|---|
| HMCL | 启动器日志导出为 `hmcl.log`；导出包另含 `logs/*.log`、`runDirectory/*.log`、`liteconfig/*.log`、`crash-reports/*.txt`、`minecraft.log`、`launch.bat` 或 `launch.sh` | 导出包内的 `launch.sh`/`launch.bat` 即**最终启动命令行**，可直接读出 JVM 参数与 classpath |
| PrismLauncher | `<数据目录>/logs/<启动器名>-<序号>.log`，序号 `0` 为当前会话，旧文件依次递增 | 行首为 Qt 日志规则格式，含 `[launcher.task.net.metacache.http]` 之类的分类前缀 |
| MultiMC | 同 Prism（Prism 是 MultiMC 的分支，日志机制同源） | 控制台打印 `Minecraft folder is:`、`Java path is:`、`Main Class:`、`Native path:`、`Libraries:` 等块 |
| ATLauncher | `logs/atlauncher.log`，旧文件滚动到 `logs/old/<年-月-日-时-分-秒>.log`，保留 14 天 | 行格式 `时:分:秒.毫秒 [线程] 级别 - 消息` |
| Axolotl（美西螈） | `<数据目录>/logs/` 与实例目录的 `logs/`；导出时按多文件合并形态拼接 | 分节 `===== launcher_log.txt =====` + 两行 `#` 头部（`# Minecraft launcher log started at` / `# Instance:`）+ 行前缀三段式 `[时间] [线程] [模块/级别]` |
| PCL2 | 用户导出时常见为启动器日志与「游戏崩溃前的输出」两个文本文件 | 无公开仓库，命名随导出功能变化 |

### 从中提取环境信息
| 要提取的信息 | Android（Zalith / FCL） | PC |
|---|---|---|
| 设备型号 / SoC | `▷ Device model:` 或 `Device:`；FCL 另有 `CPU:` 行给出 SoC | 启动器日志无，改看游戏日志 `Processor Name` |
| 系统版本 / 架构 | `▷ API version:`（SDK 级别）、`▷ Android Version:`、`Architecture:` | 游戏日志 `Operating System Version` 与 `Operating System` 括号内 |
| 渲染器 | `▷ Renderer:` 与 `Env Map` 的 `LIBGL_NAME` / `LIBGL_STRING` | 游戏日志 `Graphics Backend` / `Graphics Drivers` |
| Java 运行时 | `▷ Java Runtime: Internal-21` 或 `Java Version: 21`，配合 `JAVA_HOME` | `Java path is:`、`ModLauncher ... starting: java version X by Y` |
| JVM 参数 / classpath | `JVM Args` 段的逐行参数（含 `-cp`） | `launch.sh`/`launch.bat`、`ModLauncher running: args [...]`；MultiMC 另打印 `Libraries:` |
| 实例目录 / 账号类型 | `▷ Game Path:` 与 `(Isolation: ...)`；`▷ Account: <名> (Local)` | `Minecraft folder is:`；`--userType`（`msa` / `legacy`） |

`▷ Account` 的括号内容与 `--userType` 取值对应：`Local` 为离线账号，`msa` 为微软账号，`legacy` 为旧版 Mojang 账号。`JVM Args` 段中 `--accessToken` 之后的值被掩码为 `********************`，无法也不应从中取回凭据。

### 启动器层与游戏层的界限

| 判据 | 启动器层 | 游戏层 |
|---|---|---|
| 崩溃发生时刻 | JVM 创建前、窗口创建前 | 进入游戏后 |
| 崩溃报告头 | `================ <启动器名> Crash Report ================` | `---- Minecraft Crash Report ----` |
| 栈内容 | 启动器包名（如 `com.movtery.zalithlauncher.*`）、Android 框架类、`qm5.b(SourceFile:N)` 这类被 R8 混淆的短名 | `net.minecraft.*`、`net.fabricmc.*`、`cpw.mods.*`、模组包名 |
| 模组列表 / 进程产物 | 未加载或为空；`latest_jvm.log`、`launcher_crash.log` | 已加载；`logs/latest.log`、`crash-reports/`、`hs_err_pid*.log` |
| 退出码 | FCL 的 `exit code = N` 出现在 `Summarize:` 行；Axolotl 的 `# Process exited with status: ...` 出现在 `launcher_log.txt` 末行 | 由 `#@!@# Game crashed!` 标记行体现 |

游戏层崩溃时，游戏把崩溃报告与标记行写入标准输出，因此被启动器日志一并捕获：

| 输出行 | 含义 |
|---|---|
| `#@!@# Game crashed! Crash report saved to: #@!@# <绝对路径>` | 游戏以 `System.exit(-1)` 结束，报告已写入该路径 |
| `#@?@# Game crashed! Crash report could not be saved. #@?@#` | 报告目录不可写，退出码 `-2` |
| `Process exited with code 255.` | `255` 是 `-1` 的补码，与「报告已写出」是同一事件 |
| `Java Exit code: <N>` | 启动器换算打印的退出码；`0` 表示 JVM 正常退出 |

该标记出现即证明游戏进程已经启动过，问题在游戏层而非 JVM 创建阶段。

## 修复步骤

**按 `Summarize:` / `exit code` 与字段判定**

| 现象或字段 | 该阶段的输入 |
|---|---|
| `exit code = 1` 且日志停在原生层初始化 | 渲染器库、`LIBGL_NAME` 指向的 `.so` |
| `exit code = 6` 且伴随 `setFCLNativeWindow` 已成功 | 窗口已创建，问题在其后 |
| `Summarize: Application error, unable to launch` | 结合紧跟其后的原生输出行判断 |
| `JVM Args` 段已打印但无游戏输出 | JVM 已启动但主类未执行，改看 `latest_jvm.log` |
| `Env Map` 段后即中断 | 环境变量注入阶段的问题，注意 `Init Env Failed` 段 |
| `Java Runtime` / `Java Version` + `JAVA_HOME` | 与实际选用的运行时是否一致；版本是否满足游戏要求 |
| `Renderer` + `LIBGL_NAME` + `LIBGL_STRING` | `LIBGL_STRING` 里的 `maxMCver` / `minMCver` 直接给出该渲染器支持的版本区间 |
| `Architecture` + `POJAV_NATIVEDIR` 末段 | 两者都应为 `arm64`；`POJAV_NATIVEDIR` 末段是 APK 的 ABI 目录 |
| `CPU` / `Device model` | 特殊 SoC 与图形驱动兼容性的输入 |
| `Game Path` + `Isolation` / `Custom Java arguments` | 确认模组应放的实际目录（隔离开启时在版本目录内）；用户手工参数是否与自动生成的参数冲突 |
| Axolotl 的 `# Instance:` + `# Process exited with status:` | 实例名给出加载器与版本；退出码给出终止原因（`0xffffffff` = `-1` 游戏层错误、`0xc0000005` = 访问违例、`exit status:` 表示未取到码） |
| Axolotl 分节名 | `crash-*-client.txt` 为客户端崩溃、`crash-*-fml.txt` 为加载器阶段崩溃、`crash-*-server.txt` 为集成服务端崩溃、`hs_err_pid*.log` 为 JVM 致命错误；据此决定看哪个文件 |

**PC 侧提取启动命令行**

HMCL 的导出压缩包内 `launch.sh` / `launch.bat` 就是完整命令行，可直接读出 `-Xmx`、`-XX` 系列、`-cp` 与主类；Prism 系在实例设置的 Java 参数预览中给出；`ModLauncher running: args [...]` 行给出的是启动器传给 ModLauncher 的参数（含 `--launchTarget`、`--fml.mcVersion`、`--gameDir`、`--assetsDir`），不含 JVM 层参数。游戏能到主菜单后崩溃却只有启动器日志时，说明游戏进程的输出未被启动器捕获，需要用户提供实例目录下的 `logs/latest.log`；反之若游戏日志完全为空而启动器日志有内容，则问题停留在 JVM 创建阶段。

## 置信度线索

- **确定**：日志含 `================ <启动器名> Crash Report ================` 或 FCL 的 `Summarize: Application error, unable to launch, exit code = N` 时，可判定为启动器层故障；`Env Map` / `JVM Args` 段已完整打印则说明参数组装阶段已经通过。
- **较确定**：`Renderer` 与 `LIBGL_NAME` 指向的渲染器实现库，加之 `LIBGL_STRING` 中的版本区间，足以判断渲染器是否与当前 MC 版本匹配。
- **需追问**：只有 `launcher_crash.log` 而无 `latest_jvm.log` 与 `latest_game.log` 时，无法确认游戏进程是否被创建，需向用户索取这两个文件；`Device model` / `CPU` / `Renderer` 任一缺失时，设备兼容性判断无从下手。
- **确定（Axolotl）**：日志含 `===== launcher_log.txt =====` 与 `# Minecraft launcher log started at` / `# Instance:` 两行头部，或栈尾出现 `com.modrinth.theseus.MinecraftLaunch`，即可判定来源为 Axolotl。
- **较确定（Axolotl）**：路径中出现并列的 `profiles/` 与 `meta/`，或正文含 `Launcher name: Axolotl Launcher`。
- **需注意（Axolotl）**：`{MINECRAFT_USERNAME}` / `{MINECRAFT_UUID}` 为启动器占位符脱敏，`**.**.**.**` 为上传链路版本号脱敏，两者都不是日志原文，不能当作版本或账号缺失的证据。
