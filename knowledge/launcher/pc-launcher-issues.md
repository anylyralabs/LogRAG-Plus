# PC 端启动器常见问题（HMCL / PrismLauncher / MultiMC / ATLauncher / PCL2）

## 签名 (Signature)

本节的签名**只收启动器自身产生**的报错（JVM 参数装配、实例启动、启动器自己的下载与更新）。
游戏侧与模组侧的通用报错（`UnsupportedClassVersionError`、`OutOfMemoryError`、
`NoSuchMethodError` 等）判据在 `patterns/` 对应条目，这里只看「启动器把 JVM 装错了」这一类。

```
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
Unrecognized option: --add-opens
Error: Unable to access jarfile HMCL.jar
Error: could not open `C:\Program Files\Java\jre1.8.0_411\lib\amd64\jvm.cfg'

Failed to create JVM: error code -1
JVM Path: C:\Program Files\Java\jre1.8.0_411\bin\server\jvm.dll
Invalid maximum heap size: -Xmx128m
The specified size exceeds the maximum representable size.

Could not find or load main class net.fabricmc.loader.impl.launch.knot.KnotClient
Caused by: java.lang.ClassNotFoundException: net.fabricmc.loader.impl.launch.knot.KnotClient
Could not find or load main class cpw.mods.bootstraplauncher.BootstrapLauncher

A network operation has failed: cC0JkO8i::GetProject
Error transferring https://api.modrinth.com/v2/project/cC0JkO8i - server replied with status code 404
Project ID mismatch with some mods (Modrinth)
File "xxx.jar" is not a valid modpack

30.292 D | [launcher.task.net.metacache.http]: Saving metacache with 14 entries
Prism Launcher stuck on Initializing when launching an instance

java.nio.file.AccessDeniedException: /home/user/.local/share/PrismLauncher/instances/1.20.1/minecraft/mods
java.io.IOException: Cannot run program "/usr/bin/java": error=13, Permission denied
error while loading shared libraries: libfuse.so.2: cannot open shared object file
“HMCL.app”已损坏，无法打开。你应该将它移到废纸篓。
Bad CPU type in executable
```

## 含义

PC 端的 Java 运行时由**用户自行安装并显式指定**，这是与移动端最本质的差别——移动端启动器内置 `Internal-8/17/21/25`，PC 端启动器只能读取系统上已有的 JDK/JRE。

| 层面 | PC | 移动端 |
|---|---|---|
| Java 来源 | 用户安装的 JDK/JRE，路径由启动器配置项指定 | 启动器内置运行时，按需下载解压 |
| 实例隔离 | 每个实例一个独立 `.minecraft` 目录，可自由复制迁移 | 通常共用一个 `.minecraft` |
| 原生库 | 随游戏/模组按平台下载 x86_64 或 aarch64 | 需启动器注入 Android 兼容的 `.so` |
| 崩溃产物 | `hs_err_pid*.log` + `crash-reports/` 落在实例目录 | 多只有 `latest.log` |

PC 端启动器崩溃与游戏崩溃的日志特征完全不同，两者产生的文件与栈顶类名都不同：

| 现象 | 栈中出现的类 | 落盘产物 |
|---|---|---|
| 启动器自身崩溃 | `org.jackhuang.hmcl.*`、`org.prismlauncher.*`、`org.multimc.*`、`com.atlauncher.*` | 启动器日志（HMCL `hmcl.log`、Prism `prismlauncher-*.log`） |
| 游戏/加载器崩溃 | `net.minecraft.client.main.Main`、`net.fabricmc.loader.*`、`cpw.mods.modlauncher.*` | 实例目录下 `crash-reports/` 与 `hs_err_pid*.log` |
| JVM 未起来 | 无 Java 栈，只有 `Error:` 前缀的原生输出 | 无 |

启动器卡在 `Initializing` 属于第三类：进程仍在运行，`metacache` 任务在写元数据缓存，游戏主类尚未被加载。

## 常见触发

### 触发 A：Java 运行时选择错误

PC 端启动器一般有两个层级的 Java 设置：**全局默认 Java** 与**实例级覆盖**。实例级覆盖优先级更高，改了全局设置对已覆盖的实例无效，这是「改了没用」的常见来源。

已知配置位置：

| 启动器 | Java 设置位置 |
|---|---|
| HMCL | 全局：设置 → 游戏 → Java 路径；实例级：实例设置 → 游戏设置 → Java 路径 |
| PrismLauncher | 全局：Settings → Java；实例级：Edit → Settings → Java → `Override global Java settings` |
| MultiMC | 同 PrismLauncher（Prism 是其分支） |
| ATLauncher | Settings → Java/Minecraft → Java Path；实例级 `Override Java` |
| PCL2 | 设置 → 启动选项 → Java 版本选择 |

选错的后果分两种：`UnsupportedClassVersionError`（明确，class file version 数字对不上），或加载器类找不到（隐晦，如 `Could not find or load main class cpw.mods.bootstraplauncher.BootstrapLauncher`——Forge 1.17+ 要求 Java 16+，用 Java 8 启动时 `jvm.cfg` 与 `--add-opens` 都不存在）。

### 触发 B：内存参数配置不当

启动器生成的 Java 参数模板通常形如：

```
-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20
-XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M
```

| 参数 | 问题 |
|---|---|
| `-Xmx` 超过物理内存的 60% | 系统换页、整机卡死；Windows 上还会因提交内存超限直接 `Failed to create JVM` |
| `-Xmx` 低于 2048M | 加载大型整合包时 `OutOfMemoryError: Java heap space` |
| `-Xmx` 带小数或单位错误（`-Xmx4.5G`） | `Invalid maximum heap size`，JVM 拒绝启动 |
| `-Xms` 等于 `-Xmx` 且值很大 | 启动即占满，其他程序被挤爆 |
| `-XX:MaxGCPauseMillis` 设得过低（如 10） | G1 频繁混合回收，TPS/FPS 反而下降 |

### 触发 C：实例隔离与 `.minecraft` 路径

多实例启动器把每个实例的 `.minecraft` 放在自己的目录下，游戏目录不在启动器安装目录：

| 启动器 | 实例根目录 |
|---|---|
| PrismLauncher | Windows `%APPDATA%\PrismLauncher\instances\<实例名>\minecraft`；Linux `~/.local/share/PrismLauncher/instances/<实例名>/minecraft`；macOS `~/Library/Application Support/PrismLauncher/instances/<实例名>/minecraft` |
| MultiMC | `%APPDATA%\MultiMC\instances\<实例名>\.minecraft` |
| HMCL | 版本隔离开启时 `~/.minecraft/versions/<版本名>/`，关闭时共用 `~/.minecraft` |
| ATLauncher | `%APPDATA%\.ATLauncher\instances\<实例名>\.minecraft` |
| PCL2 | 与启动器同级的 `.minecraft`，多版本用 `versions/<版本名>/` |

典型故障：把模组放进 `%APPDATA%\.minecraft\mods` 而实例实际读取的是 `instances\1.20.1\minecraft\mods`，游戏表现为「模组没装」。

Windows 路径分隔符为 `\`，Linux/macOS 为 `/`；跨平台迁移实例时 `instance.cfg`、`mmc-pack.json` 内的绝对路径会失效。

### 触发 D：启动器自身故障

- **网络元数据缓存损坏**：PrismLauncher 卡在 `Initializing`，日志停在 `[launcher.task.net.metacache.http]: Saving metacache with 14 entries`。
- **配置目录迁移后路径失效**：如 AUR 的 `prismlauncher-qt5-bin` 把数据从 `~/.local/share/PrismLauncher` 迁到 `/opt/prismlauncher`，实例索引指向旧位置。
- **启动器进程与游戏争抢资源**：PCL2 在游戏运行时关闭启动器会卡住（启动器持有游戏的管道句柄）。
- **启动器 JVM 参数与自己启动的 Java 不兼容**：HMCL 6.x 与 PCL2 新版要求启动器自身运行在 Java 17+，用 Java 8 启动启动器时报 `Unrecognized option: --add-opens`。

### 触发 E：模组仓库 API 故障

Modrinth 与 CurseForge 的下载链路依赖启动器内置的 API 端点与项目 ID：

- **项目 ID 失效**：模组作者在 Modrinth 上重建项目后，旧 ID（如 `cC0JkO8i`、`SQoni9E3`）返回 404。日志为 `Error transferring https://api.modrinth.com/v2/project/<旧ID> - server replied with status code 404`，且 PrismLauncher 会连带清空整个多选下载篮（issue #6295 / #5656）。
- **API 不可达**：PCL2 报「无法正常连接 Modrinth」；CurseForge 需要 API Key，缺失时只返回 403。
- **整合包版本不匹配**：`.mrpack` / `.zip` 内 `modrinth.index.json` 指定的加载器版本在本地不存在，导入时报 `File "xxx.jar" is not a valid modpack`。

### 触发 F：平台差异

| 平台 | 典型故障 |
|---|---|
| Windows | 路径含空格未加引号；杀毒软件拦截启动器写入 `%APPDATA%`；`Failed to create JVM: error code -1` 多为内存或 DLL 缺失 |
| Linux | 可执行位丢失（`error=13, Permission denied`）；AppImage 缺 `libfuse.so.2`；Flatpak/Snap 沙箱下 `~/.minecraft` 被重定向 |
| macOS | Apple Silicon 上使用 x86_64 JRE 触发 `Bad CPU type in executable`；未签名/未公证的 `.app` 报「已损坏」；Metal 后端光影支持有限 |

## MC 版本 ↔ Java 版本对应

| Minecraft 版本 | 最低 Java | class file major version |
|---|---|---|
| ≤ 1.16.5 | Java 8 | 52 |
| 1.17 – 1.20.4 | Java 17 | 61 |
| 1.20.5 – 1.21.x | Java 21 | 65 |
| 26.x | Java 25 | 69 |

`UnsupportedClassVersionError` 中出现的两个数字即上表的 major version：前者是游戏要求的，后者是当前 Java 支持的。Forge 1.17+ 与 NeoForge 1.20.2+ 强制要求 Java 17 及以上，Fabric 对 Java 版本较宽容（1.16.5 可用 Java 8）。

## 修复步骤

**触发 A（Java 版本错误）**

1. 按上表为实例选择匹配的 Java，Windows 推荐 Adoptium Temurin 或 Microsoft Build of OpenJDK
2. 检查**实例级** Java 覆盖是否压过了全局设置（Prism 的 `Override global Java settings`、ATLauncher 的 `Override Java`）
3. Apple Silicon 上必须选 `aarch64`/`arm64` 构建的 JRE，不要用 x86_64 + Rosetta
4. Java 25 尚未被旧版启动器识别时，升级启动器到支持 Java 25 的版本

**触发 B（内存参数）**

1. `-Xmx` 设为物理内存的 40%–50%，4GB 内存机器取 2048M，8GB 取 4096M，16GB 取 6144M
2. `-Xms` 设为 `-Xmx` 的一半，不要相等
3. 大型整合包（300+ 模组）下限 4096M，配合渲染距离 8–12 使用
4. 修正单位写法：只写整数加 `M` 或 `G`（`-Xmx4G` 合法，`-Xmx4.5G` 非法）

**触发 C（路径与实例隔离）**

1. 用启动器的「打开实例文件夹 / 打开游戏目录」按钮定位真实目录，不要按记忆操作
2. HMCL 开启「版本隔离」后，模组放 `versions/<版本名>/mods`；关闭则放 `.minecraft/mods`
3. 跨平台迁移实例后，在启动器里重新指定 Java 路径并删除 `instance.cfg` 中的绝对路径项
4. 迁移到新机器时整个实例目录一起复制，不要只复制 `mods`

**触发 D（启动器故障）**

1. 关闭启动器，删除其元数据缓存目录后重启（Prism：`<数据目录>/metacache/`）
2. 卡在 `Initializing` 时先确认网络能访问 `api.modrinth.com` 与 `meta.fabricmc.net`
3. 配置目录被迁移过（Linux 包管理器）时，在设置里重新指定实例目录
4. 启动器自身启动失败先看 `--add-opens` 类报错，升级启动器或换用 Java 17+ 运行启动器

**触发 E（仓库 API）**

1. 404 类错误源于模组元数据里的旧项目 ID，在浏览器打开该模组的 Modrinth 页面手动下载 jar 放进 `mods/`
2. CurseForge 整合包需在启动器设置里填入 API Key
3. 批量下载中断后重新逐个添加，避免一次性勾选数十个模组
4. 整合包导入失败时确认文件扩展名为 `.mrpack`（Modrinth）或含 `manifest.json`（CurseForge）

**触发 F（平台差异）**

1. Linux：`chmod +x` 启动器文件；AppImage 安装 `libfuse2`；避免在 Flatpak 沙箱内使用外部 `.minecraft`
2. macOS：`xattr -dr com.apple.quarantine <应用路径>` 解除隔离标记；确认应用为 arm64 版本
3. Windows：把 `.minecraft` 与启动器放到无空格、无中文的路径；将启动器目录加入杀毒软件白名单

## 置信度线索

- **确定**：日志含 `UnsupportedClassVersionError` + 两个 class file version 数字，或 `Invalid maximum heap size`，或 Modrinth 404 URL
- **较确定**：只有 `Could not find or load main class <加载器类>`，且 Java 版本低于该 MC 版本要求
- **需追问**：日志未标明启动器名称与版本、Java 路径、实例目录时，应向用户确认这三项；`Failed to create JVM: error code -1` 需进一步确认物理内存与杀毒软件
