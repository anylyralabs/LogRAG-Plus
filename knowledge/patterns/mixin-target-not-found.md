# Mixin 目标类缺失（`@Mixin target ... was not found`，全平台高频）

## 签名 (Signature)

**Fabric / NeoForge 的成对 WARN（最常见形态，两行紧邻）**

```
[main/WARN]: Error loading class: dev/isxander/controlify/virtualmouse/VirtualMouseHandler (java.lang.ClassNotFoundException: dev.isxander.controlify.virtualmouse.VirtualMouseHandler)
[main/WARN]: @Mixin target dev.isxander.controlify.virtualmouse.VirtualMouseHandler was not found mixins.ipnext.json:MixinVirtualMouseHandler from mod inventoryprofilesnext
```

**带 Logger 前缀的写法（NeoForge / Fabric Loader 0.15+）**

```
[10:08:27] [main] [mixin/WARN]: @Mixin target umpaz.brewinandchewin.common.block.entity.KegBlockEntity was not found thirst.mixin.json:accessors.brewinandchewin.KegBlockEntityAccessor
[11:00:57] [main] [FabricLoader/Mixin/WARN]: @Mixin target net.fabricmc.fabric.impl.gametest.FabricGameTestModInitializer was not found mixins.cyclopscore.json:MixinFabricGameTestModInitializer from mod cyclopscore
```

**目标类属于另一个模组（模组名即被注入方）**

```
@Mixin target net.caffeinemc.mods.sodium.client.gui.SodiumGameOptionPages was not found mixins.iris.compat.sodium.json:MixinSodiumGameOptionPages from mod iris
@Mixin target mezz.jei.fabric.platform.RenderHelper was not found mixins.ipnext.json:MixinRenderHelper from mod inventoryprofilesnext
@Mixin target net.caffeinemc.mods.sodium.client.gui.SodiumOptionsGUI was not found mixins.iris.compat.sodium.json:MixinSodiumOptionsGUI from mod iris
@Mixin target com.simibubi.create.content.kinetics.deployer.DeployerHandler was not found valkyrienskies-common.mixins.json:mod_compat.create.IMixinDeployerHandler from mod valkyrienskies
@Mixin target xaero.common.patreon.Patreon was not found smsn.mixins.json:xaero.minimap.PatreonMixin
```

**配置文件归属无法确定**

```
@Mixin target net.caffeinemc.mods.sodium.client.render.occlusion.BlockOcclusionCache was not found optileaves.mixins.json:sodiumcompat.BlockOcclusionCacheMixin from mod (unknown)
```

**上一代包名残留（模组为旧版目标模组编译）**

```
Error loading class: me/jellysquid/mods/sodium/client/render/occlusion/BlockOcclusionCache (java.lang.ClassNotFoundException: me.jellysquid.mods.sodium...)
Error loading class: net/coderbot/iris/pipeline/newshader/ExtendedShader (java.lang.ClassNotFoundException: net.coderbot.iris.pipeline.newshader.ExtendedShader)
```

`me.jellysquid.mods.sodium.*` 是 Sodium 的旧包名，`net.coderbot.iris.*` 是 Iris 的旧包名；出现它们说明注入方是按老版本编译的。

**空类名（refmap 条目缺失导致的探查异常）**

```
[main/WARN]: Error loading class:  (java.lang.StringIndexOutOfBoundsException: begin 0, end -1, length 0)
```

**方法级缺失（与本类区分：这里是「类」找不到，不是「方法」找不到）**

```
Critical injection failure: @Inject annotation on getName could not find any targets matching 'getHoverName' in net/minecraft/item/ItemStack. No refMap loaded.
Critical injection failure: @Inject annotation on onServerExit could not find any targets matching 'Lnet/minecraft/server/MinecraftServer;method_xxxxx()V' in net/minecraft/server/MinecraftServer
```

以上两条是**方法**找不到，属「Mixin 注入失败」；本类故障是**类**找不到。区分方法：目标以 `L...;method_x()V` 或方法名形式出现 → 注入失败；以类全限定名出现 → 本类。

**refmap 无法读取（伴随现象，非本类故障）**

```
Reference map 'xaeroworldmap.refmap.json' for xaeroworldmap.mixins.json could not be read. If this is a development environment you can ignore this message
```

## 含义

Mixin 用 `@Mixin(目标类.class)` 声明「要把代码注入进哪个类」。这个声明在**类加载前**就无法解析成真实的类时，Mixin 框架记录一条 WARN 并**丢弃整条混入**——不注入、不报错、继续启动。

同一份日志里 `was not found` 后面紧接的两段信息决定它属于哪一种成因：

| 位置 | 内容 | 含义 |
|---|---|---|
| `@Mixin target` 与 `was not found` 之间 | 目标类全限定名 | 缺失的是**类**，不是方法 |
| `was not found` 之后 | `<mixin配置文件名>:<混入类名>` | 注入方所在的配置与混入类 |
| 行尾 | `from mod <模组ID>` | 注入方模组；`(unknown)` 表示框架无法从配置文件名反推模组 |
| 前一行 | `Error loading class: <类路径> (ClassNotFoundException)` | Mixin 的类探查器预加载目标类失败，与下一行成对 |

Mixin 把「目标类不存在」一律按**可选兼容**处理，因为它无法区分两种意图：

- 模组作者**有意**做成可选兼容（只在该模组安装时才注入）——目标类不存在是**预期结果**
- 模组作者**无意**写错（版本错配、包名搬迁）——目标类不存在是**缺陷**

因此这条 WARN 是**信息**而非**判决**，判断是否致命要看它是否伴随终止。

**与「Mixin 注入失败」的分界**：本类故障停在**类层面**（目标类根本不存在），注入动作从未开始；注入失败停在**方法层面**（目标类存在，但方法改名、签名不匹配、注入点计数为 0），会出现 `InjectionValidationException`、`Critical injection failure`、`MixinApplyError` 一类终止性异常。两者的日志形态差异很明确：前者只有 `WARN` 与 `was not found`，后者必有 `FAILED during APPLY` / `(0/N) succeeded` / `MixinTransformerError`。

## 常见触发

### 触发 A：目标模组未安装（可选兼容探测，占比最高）

注入方为「与某模组联动」编写了兼容混入，但该模组没装。目标类自然不存在。

典型特征：目标类的命名空间属于**日志中并不存在的模组**，且这一条 WARN 前后没有任何 FATAL。已实测：`xaero.common.patreon.Patreon`、`de.maxhenkel.easyvillagers.*`、`com.simibubi.create.*`、`fuzs.iteminteractions.*`、`toni.sodiumoptionsapi.*` 都属此类。

单份日志中出现上百条这类 WARN 是正常的——整合包普遍预置大量跨模组兼容混入。

### 触发 B：目标模组版本不符（类被改名、搬移或拆分）

注入方与被注入方版本错配，目标类在新版中被改名或迁移到新包。

典型特征：`Error loading class:` 里的路径是**旧包名**。已实测 `me/jellysquid/mods/sodium/client/render/occlusion/BlockOcclusionCache`（Sodium 旧包名）、`net/coderbot/iris/pipeline/newshader/ExtendedShader`（Iris 旧包名）、`net/fabricmc/fabric/impl/client/indigo/renderer/aocalc/AoCalculator`（Fabric API 内部类变动）。

同一份日志里出现**同一模组的多个不同包名前缀**时，说明注入方与被注入方跨了至少一个大版本。

### 触发 C：被注入的是 MC 本体，而模组没跟上 MC 版本

目标类属于 `net.minecraft.*`，模组为另一个 MC 版本构建。

典型特征：`was not found` 的目标是原版类，且日志中同时出现多条针对同一模组的 MC 类缺失。

### 触发 D：跨加载器或中间层注入

Fabric 模组经 Sinytra Connector 运行在 Forge/NeoForge 上时，Fabric 侧的兼容混入会大量失配；配置文件名不符合 `<模组ID>.mixins.json` 约定时，行尾出现 `from mod (unknown)`。

典型特征：日志含 `connector_pre_launch` / `SINYTRA CONNECTOR IS PRESENT` 提示段，且同一份日志出现数十至上百条 `was not found`。

### 触发 E：refmap 缺失导致探查异常

混入配置声明了 refmap，但构建产物里没有该文件，Mixin 无法把混淆名映射回真实类名，探查时拿到空字符串。

典型特征：`Error loading class:  (java.lang.StringIndexOutOfBoundsException: begin 0, end -1, length 0)` —— **类名位置为空**。同一份日志通常还有若干条 `Reference map '<文件>.refmap.json' for <配置>.mixins.json could not be read`。

26.1 起 Mojang 不再混淆，`Reference map ... could not be read` 成为预期输出（见「光影与渲染模组冲突」），此时它与崩溃无关。

## 修复步骤

**触发 A（目标模组未安装）**

1. 不做任何处理。这是兼容混入的正常留痕，缺少的那个模组本就没装。
2. 确认方式是核对命名空间与 `mods/` 目录：命名空间对应的模组不在列表里，即可判定为预期。
3. 若用户的目标是「让被跳过的功能生效」，则需要装回那个模组，而不是修改 Mixin 参数。

**触发 B（目标模组版本不符）**

1. 读出 `Error loading class:` 的**旧包路径**，确定它属于哪个模组与哪个历史版本。
2. 把**被注入方**（目标模组）换成注入方所要求的版本；或反过来，把注入方升级到支持当前目标模组版本的构建。
3. 两方都是必需模组时，只能配对到一组兼容版本，不能只升一个。
4. 大批量出现（同一份日志数十条以上）说明是整体版本错配，应整体核对整合包内各模组的 MC 版本支持范围，不要逐条修。

**触发 C（MC 本体类缺失）**

1. 从 `was not found` 的目标类全限定名（`net.minecraft.*`）与配置文件名定位模组。
2. 把该模组换成与当前 MC 版本匹配的构建。
3. 该模组尚未适配当前 MC 版本时，只能降 MC 版本或移除该模组。

**触发 D（跨加载器）**

1. 单独用 Connector 官方提供的诊断方式确认问题是否由 Connector 引入（Connector 会在崩溃报告开头插入 `SINYTRA CONNECTOR IS PRESENT!` 提示段）。
2. 把 Connector 与所有 Fabric 侧模组升级到同一批发布周期的版本。
3. 升级后仍有大量 `was not found` 时，移除非必需的 Fabric 兼容类模组。

**触发 E（refmap 缺失）**

1. 该模组的构建产物不完整，重新下载该模组的正式发布构建（不要用开发快照）。
2. 26.1 及以后的 MC 版本上 `Reference map ... could not be read` 属预期输出，无需处理。

**统一前提**：不要把 `-Dmixin.debug=true` 一类调试参数当作修复手段，它只让日志更详细地记录同一次失败，并会显著拖慢启动。

## 置信度线索

- **确定（属本类）**：日志含 `@Mixin target <类> was not found`，且**不含** `MixinTransformerError` / `Critical injection failure` / `FAILED during APPLY` / `(0/N) succeeded`。只有 WARN 而无终止，即为本类的良性形态。
- **确定（致命，转注入失败）**：同一行或邻近行出现 `MixinApplyError`、`MixinTransformerError`、`InjectionValidationException`、`InvalidInjectionException` 之一，此时故障已从「类不存在」升级为「注入点不匹配」，修复方向转为版本配对（见「Mixin 注入失败」）。
- **较确定（触发 A）**：目标类的命名空间在整份日志的 `mods/` 加载列表里**从未出现**，且日志无 FATAL 终止 —— 属可选兼容探测，非崩溃原因。
- **较确定（触发 B/C）**：`Error loading class:` 给出的路径是旧包名（`me.jellysquid.*`、`net.coderbot.*`），或目标类是 `net.minecraft.*`。
- **较确定（触发 D）**：行尾为 `from mod (unknown)`，或日志含 `connector_pre_launch` / `SINYTRA CONNECTOR IS PRESENT`。
- **确定（触发 E）**：`Error loading class:` 的类名位置为空白，异常为 `StringIndexOutOfBoundsException: begin 0, end -1, length 0`。
- **易误判（高频）**：本条 WARN 在**三成以上**的真实日志中出现，其中多数同时另有崩溃报告，但崩溃的 `Description` 分布极广（`Unexpected error`、`Initializing game`、`Exception in server tick loop`…），且这些崩溃的栈顶与本条 WARN 无因果关系。**不得因为看到它就把根因归给它**——真正原因必须由崩溃报告栈顶帧或 FATAL 行确定。
- **需追问**：日志未给出被缺失模组是否安装时，向用户确认 `mods/` 目录内容与该整合包是否曾删减模组。
