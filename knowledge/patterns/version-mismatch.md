# 版本错配（MC 版本 / 加载器版本 / Java 版本 / 模块系统）

## 签名 (Signature)

**符号不存在（API 变动，最常见）**

```
java.lang.NoSuchMethodError: 'net.minecraft.class_1234 net.minecraft.client.SomeClass.method()V'
java.lang.NoSuchFieldError: legendaries
java.lang.NoSuchMethodError: 'void net.caffeinemc.mods.sodium.client.render.chunk.compile.ChunkBuildContext.<init>(...)'
java.lang.NoClassDefFoundError: com/example/some/Class
java.lang.IncompatibleClassChangeError: Found interface <类> but class was expected
java.lang.IncompatibleClassChangeError: class <类> can not implement <接口>, because it is not an interface
java.lang.AbstractMethodError: Receiver class <类> does not define or inherit an implementation of the resolved method
java.lang.IllegalAccessError: tried to access method <类>.<方法> from class <类>
java.lang.LinkageError: loader constraint violation / loader (instance of ...) previously initiated loading for a different type
```

**Java 版本不符**

```
java.lang.UnsupportedClassVersionError: <类> has been compiled by a more recent version of the Java Runtime
    (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0
java.lang.UnsupportedClassVersionError: <类> (class file version 61.0) while loading
```

**JPMS 模块系统解析失败（Forge / NeoForge 新版 Bootstrap）**

```
java.lang.module.ResolutionException: Modules <模块A> and <模块B> export package <包名> to module <模块C>
Caused by: java.lang.module.ResolutionException: Modules lwjgl and org.lwjgl.sdl export package org.lwjgl.sdl to module accesstransformers
	at java.base/java.lang.module.Resolver.resolveFail(Resolver.java:929)
	at net.minecraftforge.bootstrap@2.1.7/net.minecraftforge.bootstrap.Bootstrap.moduleMain(Bootstrap.java:166)
WARNING: Unknown module: net.minecraftforge.bootstrap specified to --add-exports
```

**启动器层的版本判定失败**

```
net.minecraftforge.fml.loading.EarlyLoadingException
Mod file <文件名>.jar is not a valid mod file
Mods share ID with builtin mod <内置ID>
This mod was built for Minecraft <版本> but you are running Minecraft <版本>
```

## 含义

模组在**编译期**针对某个特定版本的 MC、加载器（Forge / NeoForge / Fabric Loader）和 Java 运行时生成字节码，其内部保存的是**符号引用**（类名、方法名、描述符、字段名）。运行期由 JVM 解析这些引用，解析不到即在**类链接阶段**抛出 `LinkageError` 家族异常——此时崩溃点往往不在模组自己的代码里，而在调用它的那一行。

四种错配的层次完全不同：

| 错配类型 | 出错时机 | 特征异常 | 实测判据 |
|---|---|---|---|
| MC 版本 ↔ 模组 | 类链接（首次调用方法时） | `NoSuchMethodError` / `NoSuchFieldError` / `IncompatibleClassChangeError` | 描述符含混淆名 `class_NNNN` / `method_NNNN` / `field_NNNN` |
| 加载器版本 ↔ 模组 | 类链接 | `AbstractMethodError` / `NoClassDefFoundError` | 栈帧落在加载器 API 包（`net.minecraftforge.*`、`net.fabricmc.*`） |
| Java 版本 ↔ 类文件 | **类加载（最早）** | `UnsupportedClassVersionError` | 报错含 `class file version NN.0` 两个数值 |
| 模块系统 ↔ 依赖 | JVM 启动期（主类之前） | `module.ResolutionException` | 两个模块导出同一个包给同一目标模块 |

关键区别：`NoSuchMethodError` 系列发生在**运行到那一行时**（可能进游戏几分钟后才炸），而 `UnsupportedClassVersionError` 与 `module.ResolutionException` 发生在**游戏主类加载之前**，因此**不会产生 `crash-reports/`**，只有加载器或 JVM 自身的输出。

`AbstractMethodError` 的语义特殊：接口声明了方法、实现类没实现，通常源于**接口所在库与实现所在库版本不一致**（依赖同一库的两个大版本被同时加载）。

`module.ResolutionException` 的语义是 **JPMS 不允许两个模块向同一个第三方模块导出同一个包**。在 Forge / NeoForge 新版中，多个 LWJGL 构件 jar 都会提供 `org.lwjgl.sdl` 包，加载器的 `securejarhandler` 以模块方式组织它们，重复导出即解析失败。

## 常见触发

### 触发 A：模组与 MC 版本不符

模组装进了错误的 MC 版本实例。

典型签名：`NoSuchMethodError` / `NoSuchFieldError`，描述符中出现混淆名；或 `AbstractMethodError`。

已实测案例：`irzZ67E.log` 中 `PixelmonBroadcasts-1.12.2-0.6.1` 调用 `Pixelmon 8.4.3` 时抛 `java.lang.NoSuchFieldError: legendaries`，栈帧为 `SpawnListener.onSpawnEntityEvent`。这是「模组为另一个版本的 Pixelmon 编译」的典型形态——字段名在目标版本中已不存在。

### 触发 B：前置模组版本不符

模组自身版本正确，但它依赖的库/前置版本不对。

典型签名：`NoSuchMethodError` 指向**前置模组的包名**（如 `net.caffeinemc.mods.sodium.*`），或 `IncompatibleClassChangeError`。

已实测案例：`graphics-shader-conflict` 场景中不匹配的 Sodium / Iris 组合会抛 `NoSuchMethodError: 'void net.caffeinemc.mods.sodium.client.render.chunk.compile.ChunkBuildContext.<init>(...)'`。

### 触发 C：加载器版本与模组不符

Forge / NeoForge 大版本升级会变更加载器 API，旧模组调用的加载器方法被移除或改签名。

典型签名：`NoSuchMethodError` 或 `AbstractMethodError`，栈帧落在 `net.minecraftforge.fml.*` / `net.neoforged.fml.*` / `net.fabricmc.loader.*`。

1.12.2 及更早版本的 `net.minecraftforge.fml.common.eventhandler.*` 与现代版本的 `net.neoforged.bus.*` 是完全不同的 API，无法互调。

### 触发 D：Java 版本不符

类文件版本高于运行时支持的版本。类文件版本号与 Java 版本的对应：

| class file version | Java 版本 |
|---|---|
| 52.0 | Java 8 |
| 61.0 | Java 17 |
| 65.0 | Java 21 |
| 69.0 | Java 25 |

MC ≤ 1.16.5 用 Java 8，1.17–1.20.4 用 Java 17，1.20.5–1.21.x 用 Java 21，26.x 用 Java 25。选错即 `UnsupportedClassVersionError`。

### 触发 E：模块导出冲突（JPMS）

同一个包被两个模块导出给同一个第三方模块。

已实测案例：`fcl-latest-1068534404767446429.log` 中

```
java.lang.module.ResolutionException: Modules lwjgl and org.lwjgl.sdl export package org.lwjgl.sdl to module accesstransformers
```

崩溃链为 `mio.Wrapper.main` → `net.minecraftforge.bootstrap.Bootstrap.bootstrapMain` → `Bootstrap.moduleMain`，即发生在 **Forge 的模块解析阶段**。日志中同时出现 `WARNING: Unknown module: net.minecraftforge.bootstrap specified to --add-exports`。

成因是启动器注入的 LWJGL 组件目录（该案例为 `app_runtime/lwjgl/3.4.1/`）中同时存在合并模块 jar（`lwjgl-3.4.1-merged-modules.jar`）与分立的单模块 jar（`lwjgl-sdl.jar` 等），两者都声明了 `org.lwjgl.sdl` 包，Java 模块系统拒绝重复导出。

### 触发 F：加载器与模组类型不匹配

Forge 模组放进 Fabric 实例（或反之），或 Forge 模组放进 NeoForge 实例。加载器无法解析其元数据。

典型签名：`Mod file <文件名>.jar is not a valid mod file`、找不到 `mods.toml` / `fabric.mod.json`。

## 修复步骤

**触发 A（模组与 MC 版本不符）**

1. 从崩溃栈的**第一个非 MC、非 JDK 包名帧**确定肇事模组
2. 确认该模组发布页标注的支持版本与当前 MC 版本一致，不一致则重新下载对应构建
3. 描述符中出现 `class_NNNN` / `method_NNNN`（Fabric 混淆名）时，几乎可确定为 MC 版本错配
4. 模组只提供旧版本时，改用替代模组或降级 MC 版本（不要指望调参数修复）

**触发 B（前置版本不符）**

1. 读出 `NoSuchMethodError` 中的类名属于哪个前置模组
2. 把该前置模组升级到与当前 MC 版本匹配的最新版，并确认依赖它的模组也同步更新
3. 若前置模组刚更新、依赖它的模组未更新，反向操作：把前置降回依赖方编译时的版本
4. **同一模组家族必须整体对齐版本线**：如渲染类模组与光影类模组的版本是成对发布的，不能只更新其中一个

**触发 C（加载器版本不符）**

1. 确认栈帧落在加载器 API 包，据此判定是加载器问题而非 MC 问题
2. 把加载器更新到该 MC 版本的**最新推荐版**（Forge 的推荐版号可在其官网按 MC 版本查询）
3. 加载器更新后仍需同步更新模组——加载器更新只解决它自己的 API，不解决模组的
4. Forge 1.12.2 时代的事件总线 API 与新版完全不兼容，跨版本不能复用模组

**触发 D（Java 版本不符）**

1. 从 `UnsupportedClassVersionError` 中读出两个数值：`class file version`（类需要的 Java）与 `only recognizes class file versions up to`（当前 Java 支持的上限）
2. 在启动器的 Java 设置里切换到满足下限的运行时（`Internal-8` / `Internal-17` / `Internal-21` / `Internal-25`）
3. 按 MC 版本选择：≤1.16.5 → Java 8，1.17–1.20.4 → Java 17，1.20.5–1.21.x → Java 21，26.x → Java 25
4. 切换运行时后重启游戏验证

**触发 E（模块导出冲突）**

1. 在启动器的「组件 / 运行时管理」里**重装 LWJGL 组件**
2. 重装后仍失败，检查 LWJGL 组件目录中是否同时存在 `lwjgl-*-merged-modules.jar` 与分立的 `lwjgl-<模块>.jar`（如 `lwjgl-sdl.jar`）——两者共存即冲突根源
3. 该目录位于应用私有空间，普通文件管理器无法访问，必须通过启动器自带功能操作
4. 确认启动器与 Forge / NeoForge 版本匹配，模块化加载需要新版本加载器支持
5. 不要手工编辑 `--add-exports` 参数——重复导出是模块系统的硬性拒绝，加参数无法绕过

**触发 F（加载器类型不匹配）**

1. 确认实例的加载器类型与 MC 版本，只安装该加载器的模组构建
2. Fabric 实例只放含 `fabric.mod.json` 的 jar；Forge 1.20.1 与 NeoForge 1.20.1 的 jar 不能互换
3. 用启动器的「模组列表」核对每个 jar 被识别出的名称与版本，识别不出即为类型不匹配

## 置信度线索

- **确定（模组 ↔ MC）**：`NoSuchMethodError` / `NoSuchFieldError` + 描述符含混淆名 `class_NNNN` / `method_NNNN`，或字段名是明显的旧版命名
- **确定（Java 版本）**：`UnsupportedClassVersionError` 直接给出「需要 NN.0」与「当前仅支持 NN.0」两个数值，方向无歧义
- **确定（模块系统）**：`java.lang.module.ResolutionException` 加 `Modules A and B export package P to module C` 句式，直接点名冲突的两个模块与包名
- **较确定（加载器 ↔ 模组）**：`AbstractMethodError` 或 `NoSuchMethodError` 的栈帧落在加载器 API 包而非 MC 包
- **较确定（前置 ↔ 模组）**：符号缺失的**类名**属于另一个模组，而非 MC 本体或加载器
- **需排除（重要）**：`ClassNotFoundException` 若类名是玩家可见的模组类，更可能是**文件损坏或模组没装上**，应先查文件完整性，不要当作版本错配
- **需区分**：`UnsupportedClassVersionError` 与 `module.ResolutionException` 都在**主类加载之前**发生，因此**没有 `crash-reports/`**——日志中找不到崩溃报告不代表没有崩溃
- **需追问**：日志未标明 MC 版本与加载器版本时向用户确认。同一份日志中 `Loading Minecraft X with Fabric Loader Y`、`Minecraft argument: --version`、崩溃报告 `Mod List` 段落均可提供依据
