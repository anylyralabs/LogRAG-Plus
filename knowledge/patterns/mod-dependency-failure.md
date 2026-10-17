# 模组依赖解析失败（Fabric / Forge / NeoForge，全平台通用）

## 签名 (Signature)

**Fabric（Loader 0.15+）**

```
[main/WARN]: Mod resolution failed
[main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE jei 27.4.0.15 {depends fabric-api @ [>=0.139.0+1.21.11]}, ROOT_FORCELOAD_SINGLE jei 27.4.0.15]
[main/INFO]: Reason: [HARD_DEP jei 27.4.0.15 {depends fabric-api @ [>=0.139.0+1.21.11]}]
[main/INFO]: Fix: add [add:fabric-api 0.139.0+1.21.11 ([[0.139.0+1.21.11,∞)])], remove [], replace []
[main/ERROR]: Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
A potential solution has been determined, this may resolve your problem:
	 - Install fabric-api, version 0.139.0+1.21.11 or later.
More details:
	 - Mod 'Just Enough Items' (jei) 27.4.0.15 requires version 0.139.0+1.21.11 or later of fabric-api, which is missing!
	at net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)
	at net.fabricmc.loader.impl.FabricLoaderImpl.load(FabricLoaderImpl.java:202)
	at net.fabricmc.loader.impl.launch.knot.Knot.init(Knot.java:142)
```

**Fabric 依赖错误正文的固定句式**（`Messages.properties` 中的模板）

```
<mod名> <mod版本> requires <版本范围> of <依赖ID>, which is missing!
<mod名> <mod版本> requires <版本范围> of <依赖ID>, but only the wrong version is present: <已装版本>!
<mod名> <mod版本> requires <版本范围> of <依赖ID>, which is disabled for this environment (client/server only)!
<mod名> <mod版本> requires <版本范围> of <依赖ID>, which can't be loaded due to other constraints!
<mod名> <mod版本> is incompatible with <版本范围> of <依赖ID>, yet a conflicting version is present: <已装版本>!
<mod名> <mod版本> conflicts with <版本范围> of <依赖ID>, which is present with the following version: <已装版本>!
```

**Forge / NeoForge**

```
[main/ERROR] [net.minecraftforge.fml.loading.ModSorter/LOADING]:
Missing or unsupported mandatory dependencies:
	Mod ID: 'fabric-api', Requested by: 'jei', Expected range: '[0.139.0+1.21.11,)', Actual version: '[MISSING]'
	Mod ID: 'sodium', Requested by: 'iris', Expected range: '[0.6,)', Actual version: '0.5.11'

[main/ERROR] [net.neoforged.fml.loading.ModSorter/LOADING]:
Unsupported installed optional dependencies:
	Mod ID: 'jei', Requested by: 'mymod', Expected range: '[15,)', Actual version: '[MISSING]'

[main/ERROR] [net.neoforged.fml.loading.ModSorter/LOADING]:
Incompatibilities between mods:
	Mod 'irisshaders' is incompatible with 'sodium', versions: '[0.6,)'; Version found: '0.5.11'

net.minecraftforge.fml.ModLoadingException: Missing or unsupported mandatory dependencies
net.neoforged.fml.ModLoadingException: Mod loading has failed
```

**加载器结构性失败**

```
Mod file <文件名>.jar is not a valid mod file
java.util.zip.ZipException: invalid LOC header (bad signature)
Mod <ID> requires <依赖ID> <版本范围>
Mods share ID with builtin mod <内置ID>
Caused by: net.fabricmc.loader.impl.FormattedException: Mod resolution failed
Mixin apply failed for <混入类> -> <目标类>: Injection failure
```

## 含义

模组在元数据里声明了依赖关系，加载器在启动前做统一求解；求解失败即**在游戏主类加载之前终止启动**，因此不会有世界加载、不会有 `crash-reports/`，只有加载器抛出的 `FormattedException` / `ModLoadingException`。

两类加载器的声明位置与语义不同：

| 加载器 | 依赖声明文件 | 必需 | 可选 | 互斥 |
|---|---|---|---|---|
| Fabric | `fabric.mod.json` 顶层字段 | `depends` | `recommends` / `suggests` | `breaks` / `conflicts` |
| Forge / NeoForge | `META-INF/mods.toml` 或 `META-INF/neoforge.mods.toml` 的 `[[dependencies.@]]` | `mandatory = true` | `mandatory = false` | `mandatory = false` + `ordering = "NONE"` 语义 |

依赖失败的四种实质：

| 句式 | 实质 | 处理方向 |
|---|---|---|
| `which is missing!` / `Actual version: [MISSING]` | 安装目录里完全没有这个依赖 | 补装依赖 |
| `but only the wrong version is present` | 依赖存在但版本不在允许范围 | 换依赖版本 |
| `which can't be loaded due to other constraints` | 依赖在目录里，但被别的约束挤掉了 | 解决更底层的冲突 |
| `is incompatible with` / `conflicts with` | 声明式互斥（`breaks`） | 二选一 |

Fabric 的 `Immediate reason` 一行比 `More details` 更精确：它给出求解器实际卡住的那一步。`HARD_DEP` 表示硬依赖不满足，`HARD_DEP_NO_CANDIDATE` 表示连候选版本都找不到，`ROOT_FORCELOAD_SINGLE` 表示该模组是唯一被强制的根节点。

版本范围的书写格式：`[0.139.0+1.21.11,)` 表示该版本及以上（方括号含端点，圆括号不含）；`(,0.5.3)` 表示低于该版本；`[1.0,2.0]` 表示闭区间；Fabric 的 `Fix:` 行里 `[[0.139.0+1.21.11,∞)` 是同一语义的另一写法。

## 常见触发

### 触发 A：缺少前置模组

被依赖的模组根本没下载。Fabric 的 `HARD_DEP_NO_CANDIDATE` 与 Forge 的 `Actual version: '[MISSING]'` 都属此类。

高频前置：`fabric-api`（几乎所有 Fabric 模组依赖）、`architectury-api`、`cloth-config`、`geckolib`、`kotlinforforge`、`MixinExtras`、`moonlight`。

已知实例：JEI 27.4.0.15 要求 `fabric-api >= 0.139.0+1.21.11`，未装 Fabric API 的服务端启动即报 `Mod resolution failed`。

### 触发 B：前置版本不符

前置装了，但版本落在允许范围之外。Fabric 报 `but only the wrong version is present`，Forge 报 `Expected range: 'X' , Actual version: 'Y'`。

经典场景是 `breaks` 声明的互斥：Immersive Portals 在 `fabric.mod.json` 中声明 `"breaks": { "sodium": ["<0.5.3", ">0.5.3"] }`，即只接受 `sodium` 恰好等于 `0.5.3`；装了 `0.5.11` 就触发互斥。

### 触发 C：加载器与模组类型不匹配

Forge 模组放进 Fabric 的 `mods/`（或反之）时，加载器根本不解析其元数据：

- Fabric：`Mod file xxx.jar is not a valid mod file`（缺 `fabric.mod.json`）
- Forge/NeoForge：`xxx.jar is not a valid mod file` 或找不到 `mods.toml`

Forge 与 NeoForge 之间同样互不兼容，1.20.1 的 Forge 模组放进 NeoForge 会因 `modLoader` 字段校验失败被跳过。

### 触发 D：客户端 / 服务端专属依赖

模组声明了 `environment` 或 `side`，在错误的一侧加载。Fabric 报 `which is disabled for this environment (client/server only)!`。

典型：仅客户端模组（如 `sodium`、`iris`）被放进服务端 `mods/`，或仅服务端模组（如 `lithium` 的部分分支）被放进客户端。

### 触发 E：Jar 文件损坏或重复

- 下载中断导致 jar 截断：`java.util.zip.ZipException: invalid LOC header (bad signature)`
- 同一模组的多个版本同时存在：`Mods share ID with builtin mod`
- 同一 ID 的多个候选，加载器选错：`Immediate reason` 里出现 `ROOT_FORCELOAD_SINGLE`
- 嵌套 jar（JiJ）带来的隐式依赖：`More details` 中出现 `is being provided through e.g. <内嵌 jar 名>`

### 触发 F：Mixin 层面的实际不兼容

依赖求解通过后仍在运行期失败，说明两个模组修改了同一个目标方法：

```
Mixin apply failed for <模组>.<混入类> -> <目标类>: Injection failure
org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
```

## 修复步骤

**触发 A（缺前置）**

1. 直接按 `Fix: add [...]` 或 `A potential solution has been determined` 段落给出的**模组名与版本**下载安装
2. 模组 ID 与文件名不对应时（如 ID `fabric-api` 对应文件 `fabric-api-0.139.0+1.21.11.jar`），用 ID 去 Modrinth / CurseForge 搜索
3. 一次性补全：日志里列出的每个 `Mod ID:` 都要处理，不要把缺前置当成单个问题
4. 服务端补装后重启整服，不要用 `/reload`

**触发 B（版本不符）**

1. 读 `Expected range` 与 `Actual version` 两个值：前者是要求，后者是现状
2. 要求是区间（如 `[0.139.0+1.21.11,)`）时，升级依赖到区间内即可
3. 要求是**互斥区间**（如 `breaks: {"sodium": ["<0.5.3", ">0.5.3"]}`）时不能升级，必须把依赖**降到被允许的那个具体版本**
4. 模组自身老于依赖时，反向操作：降级依赖或升级模组，二者只能改一个

**触发 C（加载器不匹配）**

1. 确认实例的加载器类型与 MC 版本，只下载该加载器的模组构建
2. Fabric 实例只放 `fabric.mod.json` 的 jar；Forge 1.20.1 与 NeoForge 1.20.1 的 jar 不能互换
3. 用启动器的「模组列表」核对每个 jar 被识别出的模组名与版本

**触发 D（环境错误）**

1. 服务端 `mods/` 中移除所有仅客户端模组（渲染、光影、HUD、按键绑定类）
2. 客户端 `mods/` 中移除仅服务端模组（性能优化中部分仅服务端的分支、反作弊类）
3. 不确定时查该模组发布页的 `Environment` / `Side` 标注

**触发 E（Jar 损坏或重复）**

1. 同一模组只保留一个 jar，删除旧版本
2. 校验下载文件大小与发布页一致，或用哈希比对
3. 解压报错的 jar 验证：损坏的 zip 无法打开，重新下载
4. 嵌套 jar 造成的隐式依赖冲突，改用不内嵌的独立版本

**触发 F（Mixin 冲突）**

1. 二分法定位：先禁用一半模组启动，按报错是否复现缩小范围
2. 查看 `Mixin apply failed` 中的目标类，搜索同时修改该类的模组
3. 两者都是必需模组时，寻找其中一个的兼容版本，或找功能替代品
4. `Not Enough Crashes` 会干扰崩溃诊断，排查 Mixin 冲突时先移除它

## 置信度线索

- **确定**：日志含 `Mod resolution failed` / `Some of your mods are incompatible with the game or each other!` / `Missing or unsupported mandatory dependencies` 之一，且附带 `Mod ID: ... Expected range: ... Actual version: ...` 明细
- **较确定**：只有 `Incompatible mods found!` 而无明细时，仍可通过 `Immediate reason` 的 `{depends <ID> @ [<范围>]}` 片段确定缺失目标
- **较确定**：`Mixin apply failed` 属运行期不兼容，与依赖求解失败是两回事，需按触发 F 单独处理
- **需追问**：日志未标明加载器类型与 MC 版本时，应向用户确认（同一份日志里 `Loading Minecraft X with Fabric Loader Y` 或 `ModLauncher running: args [--fml.mcVersion, X]` 可提供该信息）
