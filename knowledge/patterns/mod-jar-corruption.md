# 模组 / 库 JAR 文件完整性损坏（`zip END header not found`、`zip file is empty`、`Invalid or corrupt jarfile`）

## 签名 (Signature)

频次有两个来源，分子分母各自标注，不可混用：(1) **线上日志抽样**——2026-10-10～10-16 分层抽取的 536 份真实日志全文（FCL 220 / axolotl 134 / ZL2 104 / AMCL 24 / Web 上传 25 / 其他 29），本类的签名在抽样过程中按前 296 份（FCL 220 / axolotl 76）统计，故分母写作 296；(2) **AI 分析语料**——2026-09-22～10-16 的 9353 条分析记录，其中的命中包含分析文本对日志原文的引用，**不等于日志份数**，仅用于确认签名在更长时间窗内存在。

**Fabric 加载器扫描 mods 目录时发现空文件（0 字节 jar，实测最高频）**

（抽样：`java.util.zip.ZipException` 家族合计 11/296，本形态是其中占比最高的一种；AI 语料 `zip file is empty` 33 条。）

```
Caused by: java.lang.RuntimeException: java.lang.RuntimeException: Error analyzing [/storage/emulated/0/FCL/bbao4/versions/1.21.11-Fabric/mods/alternate-current-mc1.21.11-1.9.0.jar]: java.util.zip.ZipException: zip file is empty
Caused by: java.lang.RuntimeException: Error analyzing [<mods 目录>/<文件名>.jar]: java.util.zip.ZipException: zip file is empty
	at net.fabricmc.loader.impl.discovery.ModDiscoverer$ModScanTask.compute(ModDiscoverer.java:300)
Caused by: java.util.zip.ZipException: zip file is empty
	at java.base/java.util.zip.ZipFile$Source.zerror(Unknown Source)
	at java.base/java.util.zip.ZipFile$Source.findEND(Unknown Source)
	at java.base/java.util.zip.ZipFile$Source.initCEN(Unknown Source)
```

**Fabric 库分类器读到空库文件（`libraries/` 下的 jar）**

```
Caused by: java.io.IOException: error reading /storage/emulated/0/FCL/bba/libraries/org/jspecify/jspecify/1.0.0/jspecify-1.0.0.jar
	at net.fabricmc.loader.impl.game.LibClassifier.process(LibClassifier.java:215)
	at net.fabricmc.loader.impl.game.LibClassifier.process(LibClassifier.java:162)
	at net.fabricmc.loader.impl.game.minecraft.MinecraftGameProvider.locateGame(MinecraftGameProvider.java:209)
Caused by: java.util.zip.ZipException: zip file is empty
```

`zip file is empty` 是 `ZipFile$Source` 对**0 字节文件**的固定判定（`zerror` 调用点）；同一段栈里的 `findEND` 是寻找 zip 尾部中央目录记录的动作，因此「空文件」与「半截文件」都停在这一处。

（抽样：未单独统计，当时并入 `java.util.zip.ZipException` 家族；AI 语料 `error reading .../libraries/....jar` 1 条。）

**Forge / NeoForge 的 UnionFileSystem 打开截断 jar（`zip END header not found`）**

```
java.lang.reflect.InvocationTargetException
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at java.base/java.lang.reflect.Method.invoke(Unknown Source)
	at mio.Wrapper.main(Wrapper.java:21)
Caused by: cpw.mods.niofs.union.UnionFileSystem$UncheckedIOException: java.util.zip.ZipException: zip END header not found
Caused by: java.util.zip.ZipException: zip END header not found
	at jdk.zipfs/jdk.nio.zipfs.ZipFileSystem.findEND(Unknown Source)
	at jdk.zipfs/jdk.nio.zipfs.ZipFileSystem.initCEN(Unknown Source)
	at jdk.zipfs/jdk.nio.zipfs.ZipFileSystem.<init>(Unknown Source)
	at jdk.zipfs/jdk.nio.zipfs.ZipFileSystemProvider.getZipFileSystem(Unknown Source)
	at jdk.zipfs/jdk.nio.zipfs.ZipFileSystemProvider.newFileSystem(Unknown Source)
	at java.base/java.nio.file.FileSystems.newFileSystem(Unknown Source)
```

出错时机在 ModLauncher 扫描模组目录的瞬间，崩溃前最后一行通常是有定位价值的：

```
[main/DEBUG]: Scanning mods dir /storage/emulated/0/FCL/.minecraft/versions/1.20.1-Forge/mods for mods
Loading mod: {视觉优化}[物理声效重制版] sound-physics-remastered-forge-1.20.1-1.5.1.jar
Loading mod: [Verity配置工具]verityconfig'2.2'-2.2.jar
```

`Loading mod:` 是 Forge 侧**逐个打开 jar** 的日志，最后一条被打印出来的文件名即出问题的那个（或紧随其后的下一个）。

（抽样：`zip END header not found` 7/296，全部来自 FCL 实例；AI 语料 141 条。）

**GroovyModLoader（GML）装载映射时读到截断的映射 jar**

```
[19:59:54] [GML Mappings Thread/ERROR]: Caught exception while setting up mappings...
java.util.zip.ZipException: zip END header not found
	at java.util.zip.ZipFile$Source.findEND(Unknown Source)
	at java.util.zip.ZipFile$Source.initCEN(Unknown Source)
	at java.util.zip.ZipFile$Source.<init>(Unknown Source)
	at org.groovymc.gml.mappings.MappingsProvider.loadLayeredMappings(MappingsProvider.groovy:131)
	at org.groovymc.gml.mappings.MappingsProvider.access$0(MappingsProvider.groovy)
	at org.groovymc.gml.mappings.MappingsProvider$_startMappingsSetup_closure2.doCall(MappingsProvider.groovy:92)
```

同一份日志随后写出崩溃报告，`Description` 为 `Initializing game`，正文异常与上面完全一致。该形态只在 **Sinytra Connector** 场景出现（日志中有 `SINYTRA CONNECTOR IS PRESENT!` 提示段与 `Found mod file <文件名>_mapped_srg_<版本>.jar of type MOD with provider org.sinytra.connector.locator.ConnectorLocator`）。

（抽样：`loadLayeredMappings` 1/296；AI 语料 `loadLayeredMappings` 7 条、`MappingsProvider` 9 条。）

**Java 启动器收到的文件不是有效 jar**

```
Jar Executor argument: -jar
Jar Executor argument: /data/user/0/com.tungsten.fcl/cache/fclauncher/自然之需.zip
OpenJDK exited with code : 1
Error: Invalid or corrupt jarfile /data/user/0/com.tungsten.fcl/cache/fclauncher/自然之需.zip
```

（抽样：1/296，来自 FCL；AI 语料 4 条。）

**中央目录条目标名非法（属「能打开但条目名读不动」，与截断区分）**

```
[me.drex.quickpack.packs.FastFilePackResources/ERROR]: Failed to open pack <路径>/<资源包名>.zip
java.util.zip.ZipException: invalid CEN header (bad entry name)
	at java.base/java.util.zip.ZipFile$Source.zerror(ZipFile.java:1769)
	at java.base/java.util.zip.ZipFile$Source.checkAndAddEntry(ZipFile.java:1242)
	at java.base/java.util.zip.ZipFile$Source.initCEN(ZipFile.java:1708)
```

（抽样：未单独统计，当时并入 `java.util.zip.ZipException` 家族；AI 语料 10 条。）

**核心库文件整体缺失（近亲现象，不是 zip 损坏）**

```
Caused by: java.io.UncheckedIOException: java.io.IOException: Invalid paths argument, contained no existing paths: [/storage/emulated/0/FCL/.minecraft/libraries/net/minecraftforge/fmlcore/1.20.1-47.4.21/fmlcore-1.20.1-47.4.21.jar]
Caused by: java.io.IOException: Invalid paths argument, contained no existing paths: [/storage/emulated/0/FCL/.minecraft/libraries/net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-srg.jar, /storage/emulated/0/FCL/.minecraft/libraries/net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-extra.jar, /storage/emulated/0/FCL/.minecraft/libraries/net/minecraftforge/forge/1.20.1-47.4.22/forge-1.20.1-47.4.22-client.jar]
	at cpw.mods.securejarhandler/cpw.mods.jarhandling.impl.Jar.<init>(Jar.java:82)
	at cpw.mods.securejarhandler/cpw.mods.jarhandling.SecureJar.from(SecureJar.java:70)
	at MC-BOOTSTRAP/fmlloader@1.20.1-47.4.22/net.minecraftforge.fml.loading.moddiscovery.ModJarMetadata.buildFile(ModJarMetadata.java:41)
	at MC-BOOTSTRAP/fmlloader@1.20.1-47.4.22/net.minecraftforge.fml.loading.moddiscovery.MinecraftLocator.scanMods(MinecraftLocator.java:37)
```

`contained no existing paths` 的含义是「路径字符串拼出来了，但**这些文件一个都不存在**」；`zip END header not found` / `zip file is empty` 的含义是「文件存在，但内容不是一个完整 zip」。两者出现在同一段 `SecureJar.from` 栈上，修复方向却不同。

（抽样：`Invalid paths argument` 7/296（FCL 6 / axolotl 1）；AI 语料 `Invalid paths argument, contained no existing paths` 91 条。）

**其它同族但本类不覆盖的签名**（`mod-dependency-failure` 已收录，这里仅列出以免混淆）：`java.util.zip.ZipException: invalid LOC header (bad signature)`、`Mod file <文件名>.jar is not a valid mod file`。

（抽样均未命中；AI 语料前者 5 条、后者 8 条。）

## 含义

zip（jar 也是 zip）的完整性由**文件尾部的中央目录记录（End of Central Directory，EOCD）**保证：读取器必须先定位 EOCD 才能列出条目。于是「文件坏了」在 Java 里只表现为三种读数：

| 报错文本 | 文件实际状态 | 谁在读 |
|---|---|---|
| `java.util.zip.ZipException: zip file is empty` | **0 字节**（或读取时长度为 0） | `ZipFile$Source.zerror`，Fabric `ModScanTask` / `LibClassifier` |
| `java.util.zip.ZipException: zip END header not found` | **有内容但尾部没有 EOCD**：写入被中断、被截断、或根本不是 zip | `jdk.zipfs.ZipFileSystem.findEND` / `ZipFile$Source.findEND`，Forge `UnionFileSystem`、GML `MappingsProvider` |
| `java.util.zip.ZipException: invalid CEN header (bad entry name)` | 结构完整，**条目名编码非法**（GBK 等非 UTF-8 名称） | `ZipFile$Source.checkAndAddEntry`，MC 资源包加载 |

前两种都是**完整性**问题（内容缺了），第三种是**编码**问题（内容没缺，名字读不出）。这个区分决定了修复动作：前两者必须重新获取文件，第三者改文件名即可。

损坏发生在**游戏主类加载之前**，因此这类日志的共同形态是：

- 只有 `logs/latest.log`（游戏进程已被 JVM 或加载器接管）或启动器的 `launcher_log.txt`，**不会有 `crash-reports/`**；例外是 GML 形态——它发生在游戏已启动之后，因此**会**写出崩溃报告，`Description: Initializing game`
- 有 `OpenJDK exited with code : 1` / `Java Exit code: 1` 一类退出标记
- 没有任何「进世界之后」的日志

**与「模组依赖解析失败」的分界**：依赖失败是加载器**读懂了**每个 jar 的元数据后判定关系不满足（`Mod resolution failed`、`Missing or unsupported mandatory dependencies`），前提是所有 jar 都完好；本类是**连读都读不动**，因此根本走不到依赖求解那一步。实测中两者互斥：同一份日志不会既 `zip file is empty` 又 `Mod resolution failed`。

**同一个损坏在两个启动器下的表现差异**（实质相同，读数不同）：

| 启动器 | 表现 | 读数重点 |
|---|---|---|
| FCL | Java 栈外面套一层 `mio.Wrapper.main(Wrapper.java:21)`；旧版 Forge 崩在 `UnionFileSystem`，新版 Fabric 崩在 `ModScanTask` | 看 `Caused by:` 第一行即可判断是空文件还是截断文件 |
| axolotl | ModLauncher 日志不套 wrapper，Fabric 侧 `Error analyzing [...]` 直接点出 jar 全路径；NeoForge + Connector 场景则由 GML 的映射线程先炸 | 路径（`Error analyzing`）比 wrapper 形态更容易定位 |
| ZL2 | 与 FCL 同为 Java 层包装，日志同样从 `main` 栈开始 | 同上按异常文本区分 |

**为什么移动端这一类比桌面端高发**：模组来源是**外部存储**（`/storage/emulated/0/...`）。文件管理器复制大文件、SAF 选择目录导入、解压应用解包、网盘客户端下载，任何一步被 Android 后台管控打断，都会留下一个**文件名正确但内容为空/半截**的文件——磁盘上看起来「模组在了」，实际是占位。整合包场景尤其明显：一次导入中断会让**几十上百个** jar 同时变成 0 字节。

## 常见触发

### 触发 A：下载 / 复制 / 导入在写入完成前被打断（0 字节文件）

最常见形态，且常常是**批量**的。Fabric 会在 `Error analyzing [<路径>]: java.util.zip.ZipException: zip file is empty` 里逐个点名，实测有一份日志一次列出了 88 个不同的空 jar（整个 `mods/` 目录几乎全空）。

典型特征：`zip file is empty` 且**带文件名路径**；同一份日志里同一个 jar 出现两次（`Suppressed:` 与 `Caused by:` 各一次，属同一条真正异常，不是两个 jar）。

### 触发 B：下载中断产生半截 jar（有内容、无 EOCD）

下载被中断后文件保留了前若干 KB，因此不是空文件，但缺少尾部中央目录。

典型特征：`zip END header not found`；Forge 侧崩在 `UnionFileSystem`，位置在 `Scanning mods dir <目录> for mods` 之后。

### 触发 C：核心库损坏（`libraries/` 下的文件）

MC 本体库、Forge 安装器产物、加载器自身依赖（如 `jspecify`、`fmlcore`、`client-*-srg.jar`）损坏或缺失。这类文件不由用户手工管理，因此往往指向**安装/更新过程被中断**。

典型特征：`error reading <libraries 路径>.jar` 或 `Invalid paths argument, contained no existing paths: [<libraries 路径>]`；`Fabric` 侧出现在 `LibClassifier.process` → `MinecraftGameProvider.locateGame`，`Forge` 侧出现在 `MinecraftLocator.scanMods`。

### 触发 D：把「不是 jar 的文件」当 jar 启动

启动器把整合包压缩包、`.zip`、下载到的 HTML 错误页、或扩展名被改过的文件当成主 jar 传给 `-jar`。

典型特征：`Error: Invalid or corrupt jarfile <路径>`，且路径的扩展名是 `.zip` 或与 jar 无关；同一段日志的 `Jar Executor argument: -jar` 下面一行就是该路径。这类「实为 HTML/文本」的文件在文本编辑器里打开会看到 `<!DOCTYPE html>` 或 `<html>` 开头。

### 触发 E：核心库文件整体缺失（近亲，非损坏）

`Invalid paths argument, contained no existing paths`：`SecureJar.from` 收到了一组路径，`Files.exists` 全部为假。实测被点名的都是 Forge 安装期下载的库（`fmlcore-<版本>.jar`、`forge-<版本>-client.jar`、`client-<版本>-srg.jar`、`client-<版本>-extra.jar`）。

与触发 A–C 的区别：**文件根本不存在**（下载/安装没跑完就被清除或从未写入），而不是存在但内容坏。修复动作是重装该库，不是「重新下载那个模组」。

### 触发 F：GML 映射 jar 损坏（Sinytra Connector 场景）

Connector 会把 Fabric 模组现场重映射并生成映射 jar，GML（GroovyModLoader）在其映射线程里读取这些文件。任一映射产物被写坏即触发。

典型特征：`[GML Mappings Thread/ERROR]: Caught exception while setting up mappings...` + `MappingsProvider.loadLayeredMappings`；日志前段有 `Starting runtime mappings setup...`、`Injected Jimfs file system`。

## 修复步骤

**触发 A（0 字节文件）**

1. 从 `Error analyzing [<完整路径>]` 读出**每一个**空 jar 的路径，逐个确认：文件大小 0 字节即确认。
2. 全部删除后重新下载；**不要**只处理列表里的第一个——一次导入中断通常是整批损坏。
3. 换用更可靠的搬运方式：避免用文件管理器大批量复制到外部存储后直接开游戏；下载完先核对文件大小与发布页一致。
4. 修复后重启游戏，不要在启动器里「刷新模组列表」后继续——加载器扫描是启动期一次性动作。

**触发 B（半截 jar）**

1. 定位出问题文件：Forge 侧读崩溃前最后一条 `Loading mod: <文件名>.jar`，或看 `Scanning mods dir <目录> for mods` 指向的目录。
2. 校验该 jar 的字节数：半截文件的大小通常是整数的 KB/MB 截断值，与发布页标注不符。
3. 删除并重新下载该 jar；网络不稳时优先用支持断点续传的方式，或改用整合包一键安装。
4. 仍失败时对整个 `mods/` 目录做一次完整性核对（文件数与大小），而不是反复重下单个文件。

**触发 C（核心库损坏/缺失）**

1. 读出报错中 `libraries/...` 的完整路径与坐标（`<组/名>/<版本>/<文件>.jar`）。
2. 在启动器的「安装 / 修复」功能里重装该加载器版本（FCL 对应「安装新版本」，axolotl 对应整合包/版本重装），让它重新拉取库文件。
3. 不要手工往 `libraries/` 里塞 jar——坐标与校验和由安装器维护，手工放入容易造成后续版本判断错乱。
4. 重装后仍报同一路径时，检查磁盘剩余空间：空间不足会让写入静默失败。

**触发 D（不是 jar 的文件）**

1. 读出 `Error: Invalid or corrupt jarfile <路径>` 里的路径，确认它是什么文件（`.zip` 整合包 / 下载页 HTML / 占位文件）。
2. 该路径由启动器生成时，重新导入整合包：导入过程会解包并生成正确的启动入口。
3. 该文件是下载页 HTML 时，说明下载链接失效或需要登录，重新获取正确文件即可。

**触发 E（核心库缺失）**

1. 按 `contained no existing paths: [<路径列表>]` 重装对应加载器/版本的库文件（与触发 C 同一动作）。
2. 手工核对路径是否存在，确认是「不存在」而非「空文件」——两者修复动作不同。
3. 库文件被外部清理工具（存储清理、杀毒）删除时，把实例目录加入白名单。

**触发 F（GML 映射 jar 损坏）**

1. 该形态只在 Sinytra Connector 场景出现，先按 Connector 官方诊断流程确认问题不是 Connector 自身引入（日志中的 `SINYTRA CONNECTOR IS PRESENT!` 提示段）。
2. 清掉 Connector 的映射缓存目录后重启，让其重新生成映射产物。
3. 重新生成仍失败时，逐个移除 `_mapped_srg_` 命名的模组做二分定位——这些是 Connector 现场生成的映射副本，写坏通常由单个模组引起。

## 置信度线索

- **确定（属本类）**：日志含 `java.util.zip.ZipException: zip file is empty`、`java.util.zip.ZipException: zip END header not found`、`Error: Invalid or corrupt jarfile`、`Invalid paths argument, contained no existing paths` 之一
- **确定（0 字节）**：`zip file is empty`，且报错行内带 `Error analyzing [<路径>]` 或 `error reading <路径>` —— **文件名已直接给出**，无需推断
- **较确定（截断）**：`zip END header not found`，且栈中出现 `findEND` / `initCEN`；文件名通常要回到崩溃前最后一条 `Loading mod:` 或 `Scanning mods dir` 推断
- **确定（不是 jar）**：`Error: Invalid or corrupt jarfile <路径>` 且路径扩展名与 jar 无关（如 `.zip`）——属启动入口问题，不是模组内容问题
- **较确定（批量损坏）**：同一份日志里 `Error analyzing [...]` 重复出现数十次且路径各不相同，指向一次性导入/复制中断，应先修存储与搬运方式，再逐个重下
- **需区分（资源包而非模组）**：`invalid CEN header (bad entry name)` 出现在 `Failed to open pack <路径>.zip` 之后时，是资源包 zip 的条目名编码问题（中文名用 GBK 写入），文件本身完整——**不要**让用户重新下载模组
- **需区分（依赖问题）**：日志中出现 `Mod resolution failed` / `Missing or unsupported mandatory dependencies` 时属依赖求解失败，jar 本身完好，修复方向是装前置而不是查文件完整性
- **需区分（空文件 vs 缺失）**：`zip file is empty` 是**存在但为空**，`contained no existing paths` 是**不存在**；前者重下文件，后者重装库
- **需追问**：日志只给出特征异常而无路径时，向用户确认「模组是怎么装进去的」（文件管理器复制 / 整合包导入 / 网盘下载），以及出问题前是否中断过导入；并索取 `mods/` 目录的文件数与大小列表

## 背景：移动端模组文件的落盘路径与风险点

移动端实例的模组目录通常位于**外部共享存储**（实测路径形如 `/storage/emulated/0/FCL/<实例>/versions/<版本>/mods/`、`/storage/emulated/0/Android/data/<启动器包名>/files/.minecraft/versions/<版本>/mods/`）。外部存储的写入不具备事务性，且写入过程随时可能被系统回收、省电策略或用户切后台打断。

整合包导入与「模组批量导入」是风险最高的两个动作：前者要一次性写出上百个文件，后者常经由 SAF / MediaStore 逐文件复制。中途被打断时，磁盘上会留下**目录结构完整、文件名正确、内容为空或半截**的一组文件——这类残留正是本类故障在移动端占比明显高于桌面端的原因。
