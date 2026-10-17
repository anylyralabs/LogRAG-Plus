# 模组间冲突（功能重叠、注册冲突、二进制不兼容）

## 签名 (Signature)

**重复模组 ID（Forge / NeoForge）**

```
[main/ERROR] [net.minecraftforge.fml.loading.UniqueModListBuilder/LOADING]: Found duplicate mods:
	Mod ID: 'examplemod', files: '[examplemod-1.0.jar, examplemod-2.0.jar]'
net.minecraftforge.fml.loading.EarlyLoadingException: Duplicate mods found
[main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]: Duplicate Mods Found / Multiple files for mod file <文件名> found
```

**重复模组 ID（Fabric）**

```
net.fabricmc.loader.impl.discovery.ModResolutionException: duplicate mod <模组ID>
Mods share ID with builtin mod <内置ID>
```

**注册冲突（同 ID 被两个模组注册）**

```
java.lang.IllegalArgumentException: ID already registered: <命名空间>:<路径>
java.lang.IllegalArgumentException: Cannot register <类型> <ID>, already registered
java.lang.IllegalStateException: Duplicate registration for <注册表名> <ID>
java.lang.IllegalArgumentException: Cannot set already-set entry: <注册表键>
```

**二进制不兼容（两个模组改同一处 / 为不同版本编译）**

```
java.lang.NoSuchFieldError: legendaries
java.lang.NoSuchMethodError: '<返回类型> <类>.<方法>(<参数>)'
java.lang.IncompatibleClassChangeError: Found interface <类> but class was expected
java.lang.NoClassDefFoundError: <类路径>
```

**模组内部直接报出的冲突（部分模组会自检并提示）**

```
Mod(s) [<模组A>] are modifying <被改动的类>, which may cause instability.
Mixin into <目标模组> internals detected. This instance is now tainted.
```

## 含义

模组冲突的本质是**两个模组对同一个全局命名空间或同一份字节码提出了互相矛盾的要求**。按冲突对象分四层：

| 层次 | 冲突对象 | 典型签名 | 可恢复性 |
|---|---|---|---|
| 文件层 | 同一个模组 ID 存在多个 jar | `Found duplicate mods` / `duplicate mod <ID>` | 删掉冗余 jar 即解决 |
| 注册层 | 同一个注册 ID 被两个模组占用 | `ID already registered` | 需移除其中一个模组 |
| 字节码层 | 同一个方法被两个模组改写 | `Method overwrite conflict` / `NoSuchFieldError` | 取决于是否必需 |
| 语义层 | 两个模组功能重叠且同时运行 | 无固定异常，表现为行为异常或运行期崩溃 | 需二选一 |

**「功能重叠」是最难识别的一类**，因为它常常没有明确报错：多个优化模组、多个地图/小地图模组、多个光影加载器同时运行时，每个单独都能启动，但组合后互相破坏对方假设的内部状态。

**「二进制不兼容」是识别冲突的关键判据**：当 `NoSuchFieldError` / `NoSuchMethodError` 的**肇事帧属于模组 A**、而**缺失的符号属于模组 B** 时，说明 A 是为另一个版本的 B 编译的——这不是版本错配（B 的版本本身可能正确），而是 **A 与 B 这对组合不兼容**。

模组自检提示（`Mod(s) [...] are modifying ...`、`Mixin into ... internals detected`、`This instance is now tainted`）是**部分模组主动输出的免责声明**，表明它检测到了其他模组修改自己的内部类。这类提示本身不是崩溃，但精确指出了冲突参与方，是定位冲突最有价值的线索。

## 常见触发

### 触发 A：同一模组存在多个 jar

模组的多个版本同时留在 `mods/` 目录中，或 jar 与其解压后的目录并存。

典型签名：`Found duplicate mods:` 后列出 `Mod ID: '...', files: '[a.jar, b.jar]'`；Fabric 报 `duplicate mod <ID>`；同为内置 ID 时报 `Mods share ID with builtin mod`。

### 触发 B：两个模组注册同一个 ID

两个模组声明了相同的注册名（方块、物品、实体、音效、配方类型等）。多见于派生模组、汉化/补丁模组与原模组并存，或整合包中混入了两份同源模组。

典型签名：`IllegalArgumentException: ID already registered: <命名空间>:<路径>`。

### 触发 C：功能重叠的多个模组（本类最隐蔽）

同类功能的模组同时安装，各自改写同一批 MC 类。

高频重叠组合：多个渲染优化模组（同属一套渲染重写体系的不同分支）、多个小地图/地图模组、多个光影加载器、多个性能优化模组、多个维度/世界生成模组。

表现有两种：

- 模组自检输出 `Mod(s) [...] are modifying <类>, which may cause instability.`
- 无显式冲突提示，直接在其他位置崩溃

### 触发 D：二进制不兼容（模组 A 为模组 B 的旧版本编译）

模组 A 直接调用模组 B 的内部 API，而 B 的版本已变动。

典型签名：`NoSuchFieldError` / `NoSuchMethodError`，**肇事栈帧属于模组 A**，**缺失符号的宿主类属于模组 B**。

已实测案例（`irzZ67E.log`）：

```
java.lang.NoSuchFieldError: legendaries
	at com.github.xpxpand.pixelmonbroadcasts.listeners.SpawnListener.onSpawnEntityEvent(SpawnListener.java:141)
	~[SpawnListener.class:1.12.2-0.6.1-universal]
	at com.pixelmonmod.pixelmon.api.spawning.SpawnAction.doSpawn(SpawnAction.java:89) [SpawnAction.class:1.12.2-8.4.3]
```

`PixelmonBroadcasts 0.6.1` 在 `Pixelmon 8.4.3` 的 `legendaries` 字段上失败。崩溃报告的 `Description:` 为 `Exception in server tick loop`，最终由 `Encountered an unexpected exception` 终止进程并写出 `crash-2026-09-14_21.15.01-server.txt`。

该案例的另一个特征是**同时出现像素级重合的多次重复报错**：`Exception caught during firing event ...`（按事件逐个打印）、`Encountered an unexpected exception`（终止）、以及 `1: ASM: ...` / `3: ASM: ...` / `5: ASM: ...` 形式的监听器序号清单。

### 触发 E：类名冲突

两个不同模组（常来自不同作者的功能重命名分支）定义了完全相同的全限定类名。

典型签名：`LinkageError: loader constraint violation`、`NoClassDefFoundError` 指向两个模组都包含的类，或 `IncompatibleClassChangeError: Found interface ... but class was expected`。

## 修复步骤

**触发 A（重复 jar）**

1. 按 `Found duplicate mods:` 给出的 `Mod ID` 与文件列表，进 `mods/` 目录只保留**一个**最新版 jar
2. 检查隐藏副本：`.jar.disabled`、带 `(1)` / `(2)` 后缀的重复下载文件、以及解压后的同名目录
3. 整合包用户优先使用启动器的「验证 / 重装整合包」功能，而不是手工删文件
4. 删完后重启整服/整客户端，不要用 `/reload`

**触发 B（注册 ID 冲突）**

1. 从 `ID already registered:` 读出命名空间（冒号前的部分），命名空间即模组 ID
2. 在模组列表中找到该 ID 对应的模组，确认是否存在两个提供同一命名空间的模组
3. 移除其中一个；若两者都必需，查找是否其中一个是补丁/汉化类模组，用不冲突的版本替换
4. 配方与音效类 ID 冲突有时可通过配置文件单独关闭其中一方的注册

**触发 C（功能重叠）**

1. 按功能分组检查模组列表，重点排查优化类、地图类、光影类、维度类四组
2. 每组只保留一套：多个渲染优化模组保留其一，多个光影加载器保留其一
3. 借助模组自检输出缩小范围：`Mod(s) [<模组A>] are modifying <类>` 中的模组 A 即冲突参与方之一
4. 无自检输出时用停用一半模组的方式二分定位
5. 保留的模组需与其前置版本配对（渲染优化模组与光影加载器的版本是成对发布的）

**触发 D（二进制不兼容）**

1. 读出 `NoSuchFieldError` / `NoSuchMethodError` 中**缺失的符号名**（如案例中的 `legendaries`），确定它属于哪个模组（案例中属于 Pixelmon）
2. 读出**肇事栈帧**（案例中属于 PixelmonBroadcasts），确定是谁在调用
3. 判定方向：肇事方（PixelmonBroadcasts）需升级到支持当前目标模组（Pixelmon 8.4.3）的版本
4. 肇事方没有新版时，反向降级目标模组到肇事方编译时的版本
5. 两者都无合适版本时，移除肇事方模组
6. 注意此类冲突**不一定在启动时暴露**，可能在游戏运行数分钟后由某个事件触发（案例中为生物生成事件）

**触发 E（类名冲突）**

1. `LinkageError: loader constraint violation` 会指出两个类加载器与冲突的类名
2. 两个模组提供了相同的全限定类名时，二者不能共存，必须移除其一
3. 此类情况多出现在同一模组的不同分支（如不同作者维护的重命名版本）被同时安装时

## 置信度线索

- **确定（重复 jar）**：`Found duplicate mods:` / `duplicate mod <ID>` 直接给出模组 ID 与文件名列表，属机械操作问题
- **确定（注册冲突）**：`ID already registered:` 给出了完整命名空间，冒号前即肇事模组 ID
- **确定（二进制不兼容）**：`NoSuchFieldError` / `NoSuchMethodError` 中，**肇事帧所属模组**与**缺失符号宿主类所属模组**是两个不同的模组。这是与「版本错配」区分的关键——版本错配的宿主通常是 MC 本体，而模组冲突的宿主是另一个模组
- **较确定（功能重叠）**：出现 `Mod(s) [...] are modifying <类>, which may cause instability.` 或 `Mixin into ... internals detected` / `This instance is now tainted` 自检提示，提示中的模组即冲突参与方
- **较确定（运行期才暴露）**：崩溃报告 `Description:` 为 `Exception in server tick loop` 或事件触发类描述，且启动阶段完全正常——说明是运行期行为冲突而非加载期冲突
- **需注意（重复报错）**：同一异常按事件逐个打印数十次是 Forge 事件总线的正常行为，**不代表有多个独立问题**，应按同一个根因处理
- **需追问**：日志未给出完整模组列表时向用户确认。崩溃报告的 `Mod List` 段落、`coremods are present:` 段落与日志开头的 `Loading X mods` 行均可提供完整列表
