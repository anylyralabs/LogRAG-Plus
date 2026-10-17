# Fabric Loader 自身失败（发现 / 入口点 / 类转换三个阶段）

## 签名 (Signature)

下列频次的分母是 2026-10-17 抽取的 499 份真实日志全文（FCL 369 / axolotl 77 / ZL2 51 / Web 上传 2），括号内为命中份数。

**阶段一：模组发现失败（致命，先于游戏主类）**

（`Mod discovery failed!` 3/499；同一份日志中 `Error analyzing [...]` + `zip file is empty` 4/499。这批日志含崩溃报告的比例为 0%。）

```
net.fabricmc.loader.impl.FormattedException: net.fabricmc.loader.impl.discovery.ModResolutionException: Mod discovery failed!
	at net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:63)
	at net.fabricmc.loader.impl.FabricLoaderImpl.load(FabricLoaderImpl.java:204)
	at net.fabricmc.loader.impl.launch.knot.Knot.init(Knot.java:156)
	at net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)
Caused by: net.fabricmc.loader.impl.discovery.ModResolutionException: Mod discovery failed!
	at net.fabricmc.loader.impl.discovery.ModDiscoverer.lambda$discoverMods$1(ModDiscoverer.java:155)
	at net.fabricmc.loader.impl.util.ExceptionUtil.gatherExceptions(ExceptionUtil.java:33)
	at net.fabricmc.loader.impl.discovery.ModDiscoverer.discoverMods(ModDiscoverer.java:155)
	at net.fabricmc.loader.impl.FabricLoaderImpl.setup(FabricLoaderImpl.java:222)
Suppressed: java.lang.RuntimeException: java.lang.RuntimeException: Error analyzing [/storage/emulated/0/FCL/.minecraft/versions/s2/mods/[3D 皮肤层] skinlayers3d-fabric-1.11.2-mc1.21.11.jar]: java.util.zip.ZipException: zip file is empty
	at net.fabricmc.loader.impl.discovery.ModDiscoverer$ModScanTask.compute(ModDiscoverer.java:300)
Caused by: java.util.zip.ZipException: zip file is empty
```

**阶段二：入口点执行失败**

（`Could not execute entrypoint stage` 14/499、19 行；**这批日志 93%（13/14）含崩溃报告**。）

```
java.lang.RuntimeException: Could not execute entrypoint stage 'client' due to errors, provided by 'jei' at 'mezz.jei.fabric.JustEnoughItemsClient'!
	at net.fabricmc.loader.impl.FabricLoaderImpl.lambda$invokeEntrypoints$0(FabricLoaderImpl.java:409)
	at net.fabricmc.loader.impl.util.ExceptionUtil.gatherExceptions(ExceptionUtil.java:33)
	at net.fabricmc.loader.impl.FabricLoaderImpl.invokeEntrypoints(FabricLoaderImpl.java:407)
	at net.fabricmc.loader.impl.game.minecraft.Hooks.startClient(Hooks.java:53)
	at knot//net.minecraft.client.MinecraftClient.<init>(MinecraftClient.java:475)

net.fabricmc.loader.impl.FormattedException: java.lang.RuntimeException: Could not execute entrypoint stage 'preLaunch' due to errors, provided by 'sodium'!
java.lang.RuntimeException: Could not execute entrypoint stage 'main' due to errors, provided by 'black_umbrella_addon' at 'cn.blockforge.blackumbrellaaddon.GeneratedMod'!
```

阶段名（`'client'` / `'main'` / `'preLaunch'` / `'server'`）与点名模组都直接写在消息里。实测出现过的模组：`jei`、`enhancedblockentities`、`rsls`、`caxton`、`sodium`、`black_umbrella_addon`。

**阶段三：类转换（Mixin 应用）失败**

（`Mixin transformation of ... failed` 11/499、54 行。）

```
net.fabricmc.loader.impl.FormattedException: java.lang.RuntimeException: Mixin transformation of net.minecraft.client.MinecraftClient failed
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.getPostMixinClassByteArray(KnotClassDelegate.java:435)
Caused by: java.lang.RuntimeException: Mixin transformation of com.xie.smfs.entity.GhostMasterEntity failed
Caused by: java.lang.RuntimeException: Mixin transformation of net.minecraft.client.render.WorldRenderer failed [in thread "Render thread"]
```

目标类可以是 MC 本体（`net.minecraft.client.MinecraftClient`、`net.minecraft.client.render.GameRenderer`、`net.minecraft.entity.LivingEntity`），也可以是模组自己的类（`com.xie.smfs.entity.GhostMasterEntity`）。实测频率最高的是模组自己的类（`com.xie.smfs.entity.GhostMasterEntity` 一份日志内出现 33 次）。

**附加：`fabric.mod.json` 含加载器不认识的顶层字段（WARN，多数无害）**

（32/499，6.4%、48 行；含崩溃报告的比例为 38%，**低于 46.7% 的基线**，属噪音。）

```
[ForkJoinPool-1-worker-3/WARN]: The mod "mr_kaleidoscope_deco" contains invalid entries in its mod json:
- Unsupported root entry "contact" at line 9 column 14

[ForkJoinPool-1-worker-4] [FabricLoader/Metadata/WARN]: The mod "openpartiesandclaims" contains invalid entries in its mod json:
- Unsupported root entry "" at line 26 column 4
- Unsupported root entry "mixins_temp_disabled" at line 33 column 27
```

## 含义

Fabric 的启动链是一条固定的调用序列，三个阶段各有自己的外层包装，**崩溃发生在哪个阶段决定了去哪找修复方向**：

| 阶段 | 调用点（栈里可读） | 本阶段失败的消息 | 是否生成 `crash-reports/` |
|---|---|---|---|
| 发现 | `KnotClient.main` → `Knot.init` → `FabricLoaderImpl.load/setup` → `ModDiscoverer.discoverMods` | `Mod discovery failed!`（内含 `Error analyzing [...]`） | 否（0/3） |
| 入口点 | `FabricLoaderImpl.invokeEntrypoints` → `Hooks.startClient` → `MinecraftClient.<init>` | `Could not execute entrypoint stage '<阶段>' due to errors, provided by '<模组ID>' at '<入口点类>'!` | 是（13/14） |
| 类转换 | `KnotClassDelegate.getPostMixinClassByteArray` | `Mixin transformation of <类> failed` | 是（6/11 实测含） |

三个阶段的外层异常都是同一个 `net.fabricmc.loader.impl.FormattedException`（本抽样 48/499 的日志出现该类名），因此**只看异常类名无法定位阶段**，必须看 `Caused by` 链上的第一个 Fabric 内部调用点：

- 有 `ModDiscoverer.discoverMods` → 发现阶段
- 有 `FabricLoaderImpl.invokeEntrypoints` → 入口点阶段
- 有 `KnotClassDelegate.getPostMixinClassByteArray` → 类转换阶段

这与依赖求解失败是**两件不同的事**，虽然外层异常同样叫 `FormattedException`：

| | 依赖求解失败 | 本类（发现阶段） |
|---|---|---|
| 消息 | `Mod resolution failed` + `requires ... which is missing!` | `Mod discovery failed!` + `Error analyzing [...]` |
| 含义 | 依赖图求不出解 | **jar 本身读不出来**（0 字节、截断、损坏） |
| 处置 | 补装 / 换版本依赖 | 重下那个 jar |

栈帧里的加载器名 `knot//`（如 `at knot//net.minecraft.client.MinecraftClient.<init>`）是 Fabric 自己的类加载器（`KnotClassLoader`，本抽样 30/499 的日志出现该类名），正常输出，不是故障。

`contains invalid entries in its mod json` 的措辞是"元数据里有加载器不认识的字段"，加载器**跳过该字段继续加载**，与 `fabric.mod.json` 整份解析失败是两件事（后者归「JSON 配置损坏」）。

## 常见触发

### 触发 A：发现阶段中止——`mods/` 目录里有读不出来的 jar

`Error analyzing [<jar 完整路径>]: java.util.zip.ZipException: zip file is empty`。

`ModDiscoverer` 的扫描任务对每个 jar 尝试读取元数据，遇到 0 字节或截断的文件即收集异常；收集完用 `ExceptionUtil.gatherExceptions` 汇总成 `Mod discovery failed!` 抛出。因此**同一份日志里 `Error analyzing` 的条数等于损坏文件数**，可以一次列全。

实测路径形态：`/storage/emulated/0/FCL/.minecraft/versions/s2/mods/[3D 皮肤层] skinlayers3d-fabric-1.11.2-mc1.21.11.jar`。路径里有中文与方括号，但**非 ASCII 文件名不是失败原因**——同一批样本里大量含中文名的模组正常加载，本类的判据只是文件内容不可解。该 jar 的具体成因与校验方法见「模组 / 库 JAR 文件完整性损坏」。

### 触发 B：入口点阶段——模组在自己的入口点里抛异常

`provided by '<模组ID>' at '<入口点类>'` 直接点名模组与入口点实现类。阶段名的含义：

| 阶段名 | 执行时机 | 实测模组 |
|---|---|---|
| `preLaunch` | 游戏主类加载前，加载器刚就绪 | `sodium` |
| `main` | 模组初始化（两侧通用） | `black_umbrella_addon` |
| `client` | 客户端侧初始化（本抽样最常见） | `jei`、`enhancedblockentities`、`rsls`、`caxton` |
| `server` | 服务端侧初始化（本抽样未命中） | — |

`preLaunch` 阶段失败时崩溃报告可能来不及生成——该阶段发生在 MC 主类加载之前，而实测 13/14 含报告的那一份正是 `preLaunch` 之外的阶段。

### 触发 C：类转换阶段——某个混入把目标类改坏

`Mixin transformation of <类> failed`，外层被 Fabric 包装成 `FormattedException`。这一步是 Fabric 的类加载器在把字节码交给 Mixin 之后、返回给 JVM 之前失败，因此**失败原因在更下一层的 `Caused by`**，本条目只负责指出"它属 Fabric 类转换阶段，栈里带 `KnotClassDelegate.getPostMixinClassByteArray`"。

目标类是模组自己的类（`com.xie.smfs.entity.GhostMasterEntity`）时，通常该模组自己注册的混入或它依赖的库在转换时抛异常；目标是 MC 本体（`net.minecraft.client.render.WorldRenderer`）时，通常是某个混入的注入逻辑在执行期抛异常。后者的具体处置归「Mixin 注入失败」。

### 触发 D：`fabric.mod.json` 里有加载器不认识的顶层字段

`The mod "<模组ID>" contains invalid entries in its mod json:` 后以 `- Unsupported root entry "<字段>" at line N column N` 逐条列出。

实测被点名的字段：`contact`（正确写法在 `contact` 对象内部，顶层出现即为非法）、`mixins_temp_disabled`（用户手工禁用混入时追加的自定义字段）、以及**空字符串 `""`**（JSON 里出现了加载器无法归类的键）。

本抽样 32/499 命中，其中含崩溃报告的比例（38%）**低于基线**，说明这批日志里的崩溃大多与本条无关。

## 修复步骤

**触发 A（发现阶段：jar 不可读）**

1. 从 `Error analyzing [<路径>]` 读出完整的 jar 路径与文件名，逐个记录（条数 = 损坏文件数）。
2. 删除这些 jar，重新下载；不要改名、不要解压后放回目录。
3. 重复下载仍为 0 字节时，换网络环境或换下载源（启动器内置下载器与浏览器下载的完整性表现不同）。
4. 完成校验后重启。本阶段中止**不会**生成崩溃报告，验证方式只有重启后看日志是否越过 `Mod discovery failed!`。

**触发 B（入口点阶段：模组入口点抛异常）**

1. 从 `provided by '<模组ID>'` 读出模组 ID，从 `at '<入口点类>'` 读出实现类，两者都直接给出。
2. 从 `stage '<阶段>'` 读出失败时机（`preLaunch` / `main` / `client` / `server`），据此判断影响的是一侧还是两侧。
3. 继续向下读第一个 `Caused by:`，判定类型：`ClassNotFoundException` / `NoClassDefFoundError` 属缺前置或坏产物；`IllegalStateException`、`NullPointerException` 属该模组的实现缺陷。
4. 更新该模组到与当前 MC 版本匹配的构建；这是最常见且成本最低的处置；仍失败则移除它。
5. `jei` 一类的核心模组失败时，先确认它的前置（如 `fabric-api`）版本与它要求的范围一致。
6. `preLaunch` 阶段失败时不要期待崩溃报告，直接以日志末尾的栈为证据。

**触发 C（类转换阶段）**

1. 从 `Mixin transformation of <类> failed` 读出目标类。
2. 目标是 MC 本体 → 转「Mixin 注入失败」，按该条目的 `-> <目标类>` 与注入点计数线索排查是哪一个混入。
3. 目标是模组自己的类 → 该模组或其依赖库的转换器执行期抛了异常，继续向下读 `Caused by`；多为该模组与另一前置版本不匹配，按缺前置 / 版本错配处理。
4. 与 `-Dmixin.debug` 类调试参数无关，不要把它当修复手段。

**触发 D（元数据字段不被识别）**

1. 读出 `The mod "<模组ID>"` 与 `Unsupported root entry "<字段>"`。
2. `mixins_temp_disabled` 一类字段是**用户或第三方工具写入的自定义字段**，删掉该字段即可消除告警（该模组本体不受影响）。
3. 字段为空串 `""`（`Unsupported root entry "" at line N`）时，说明该 JSON 里混入了非标准键，通常由人工编辑或工具脚本追加造成，同样删除该键。
4. 若被点名的字段是 `depends`、`environment` 一类**带依赖语义**的字段，则说明该文件不是 Fabric 的元数据（可能是 Forge 的 `mods.toml` 改名而来），属加载器与模组类型不匹配，归「模组依赖解析失败」。
5. 只有该 WARN 而没有后续终止时，不要把它当崩溃原因——它低于基线，属噪音。

## 置信度线索

- **确定（属本类）**：`Mod discovery failed!`、`Could not execute entrypoint stage`、`Mixin transformation of ... failed` 三者之一。三者都用 `FormattedException` 包装，但消息文本互不重合，可唯一定位阶段
- **确定（阶段一而非依赖失败）**：`Caused by` 链里有 `ModDiscoverer.discoverMods` 且**没有** `Mod resolution failed` / `requires ... which is missing!` / `Incompatible mods found`。判据本质是"读 jar 失败"与"依赖图无解"的区别
- **确定（阶段二）**：`provided by '<模组ID>' at '<入口点类>'` 直接给出模组与类，无需推断；`stage '<阶段>'` 给出时机
- **较确定（阶段二而非阶段一）**：栈里有 `FabricLoaderImpl.invokeEntrypoints` 或 `Hooks.startClient` 或 `MinecraftClient.<init>`——说明 MC 主类已被加载，发现阶段已通过
- **较确定（阶段三）**：栈里有 `KnotClassDelegate.getPostMixinClassByteArray` 或 `KnotClassDelegate.tryLoadClass`
- **确定（无崩溃报告 ≠ 无崩溃）**：发现阶段实测 0%（0/3）含崩溃报告，入口点阶段 93%（13/14）、类转换阶段 55%（6/11）含。阶段越早越拿不到报告，因此不能以"有没有 `crash-reports/`"反推是否崩过
- **易误判（`contains invalid entries in its mod json`）**：32/499 命中，含崩溃报告比例 38%，**低于 46.7% 基线**，属噪音；只有它之外还有终止性异常时才值得追查
- **易误判（把加载器名当故障）**：栈帧前缀 `knot//` 与类名 `KnotClassLoader`（30/499）是 Fabric 类加载器的正常标识，出现在栈里不表示类加载失败；类加载器层面的失败另见「类加载与类初始化失败」
- **需区分（依赖求解失败）**：`Mod resolution failed` / `Incompatible mods found` / `Missing or unsupported mandatory dependencies` / `which is missing!` 归「模组依赖解析失败」，本类不处理依赖明细
- **需区分（jar 完整性）**：`zip file is empty` 的成因分析（0 字节 / 截断 / 校验方式）归「模组 / 库 JAR 文件完整性损坏」，本条目只负责指出它是**发现阶段中止**的诱因
- **需区分（元数据整体损坏）**：`fabric.mod.json` 整份解析失败（`MalformedJsonException`、`EOFException`）归「JSON 配置损坏」；本类的 `Unsupported root entry` 是"部分字段不被识别"而非"整体不可解析"
- **需追问**：日志未给出 `Loading Minecraft <版本> with Fabric Loader <版本>` 头时，向用户确认 MC 与加载器版本，以及 `mods/` 目录的文件清单（入口点失败常源于某个模组与 MC 版本错配）
