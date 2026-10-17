# 实战案例：Mixin 注入失败与模组间冲突（MixinExtras 版本、同目标双注入、重复 mod ID）

本条汇集 logshare.cn 生产 AI 分析记录中**已核实**的 Mixin 与模组间冲突故障。抽象规则见
`patterns/mixin-injection-failure.md`、`patterns/mixin-target-not-found.md`、
`patterns/mixin-namespace-mismatch.md`、`patterns/mod-conflict.md`、`patterns/mod-runtime-api-mismatch.md`，
本条只给**真实形态**。

与 `cases/dependency-and-version.md` 的分工：条目依赖「缺谁、版本不在区间」归依赖一条；
本条处理**依赖求解已经通过、两个模组都能装**，但它们在字节码层面互相破坏的情况。

## 签名 (Signature)

**案例 1：MixinExtras 0.5.0 与运行时 Mixin 组合不匹配（MC 1.21.11 / Fabric Loader 0.18.4，logId: 1BLPZSu）**

```
[23:03:46] [main] [FabricLoader/MixinExtras|Service/INFO]: Initializing MixinExtras via com.llamalad7.mixinextras.service.MixinExtrasServiceImpl(version=0.5.0).
```

```
Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
	at org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:381)
	at org.spongepowered.asm.mixin.transformer.MixinTransformer.transformClass(MixinTransformer.java:237)
	at org.spongepowered.asm.mixin.transformer.MixinTransformer.transformClassBytes(MixinTransformer.java:202)
	at net.fabricmc.loader.impl.launch.knot.KnotClassDelegate.getPostMixinClassByteArray(KnotClassDelegate.java:435)
Caused by: java.lang.ClassCastException: class java.util.ArrayList cannot be cast to class org.objectweb.asm.tree.AnnotationNode (java.util.ArrayList is in module java.base of loader 'bootstrap'; org.objectweb.asm.tree.AnnotationNode is in ...
	at knot//com.llamalad7.mixinextras.wrapper.factory.FactoryRedirectWrapperMixinTransformer.transform(FactoryRedirectWrapperMixinTransformer.java:18)
	at knot//com.llamalad7.mixinextras.transformer.MixinTransformerExtension.preApply(MixinTransformerExtension.java:40)
	at org.spongepowered.asm.mixin.transformer.ext.Extensions.preApply(Extensions.java:156)
```

同一组合的实例共 7 份：logId `1BLPZSu`（`sponge-mixin-0.17.0+mixin.0.8.7`）、
`TkFnsON`、`maOlQza`、`infXavA`、`IjQXo4H`、`TbWwFQh`、`FdlGDRt`
（后六份均为 `sponge-mixin-0.17.3+mixin.0.8.7`），全部为 MC 1.21.11 / Fabric Loader 0.18.4 / 约 178 个模组。

**案例 2：两个模组注入同一个目标方法（MC 1.12.2 / Cleanroom 0.6.13-alpha / ZL2 2.7，logId: IbpegIs）**

```
[10:54:25] [Client thread/FATAL]: Mixin apply for mod datarium failed datarium.early.mixin.json:misc.MixinFallbackResourceManager from mod datarium -> net.minecraft.client.resources.FallbackResourceManager: org.spongepowered.asm.mixin.injection.throwables.Inva...
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: @At("INVOKE") on net/<P>/FallbackResourceManager::datarium$relinkExists with priority 1000 cannot inject into net/<P>/FallbackResourceManager::func_110536_a(Lnet/<P>/ResourceLocation;)
	at org.spongepowered.asm.mixin.injection.code.Injector.findTargetNodes(Injector.java:312)
	at org.spongepowered.asm.mixin.injection.code.Injector.find(Injector.java:248)
	at org.spongepowered.asm.mixin.injection.struct.InjectionInfo.prepare(InjectionInfo.java:475)
```

**同一个目标类上，`vintagefix` 也在另一份同组合日志里失败（logId: SUMNxTv）**：

```
Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure: Redirector useFasterException(Ljava/lang/String;)Ljava/io/FileNotFoundException; in mixins.vintagefix.json:resourcepacks.MixinFallbackResourceManager from mod vintagefix failed injection check, (0/1) succeeded.
```

`IbpegIs` 里的同一个 `vintagefix` 则是**另一类冲突**——它要注入的方法已经被另一个模组注入过，
Mixin 直接跳过该方法（不报错、但失效）：

```
[10:53:44] [main/WARN]: Method overwrite conflict for func_110592_c in mixins.vintagefix.json:resourcepacks.MixinAbstractResourcePack from mod vintagefix, previously written by lomka.starl.mixins.net.minecraft.client.resources.MixinAbstractResourcePack. Skipping method.
```

两个模组的版本可以从 `IbpegIs` 的模组清单直接读到：

```
| L     | datarium           | 0.6.1             | datarium-0.6.1.jar                               |
| L     | vintagefix         | 0.7.2             | vintagefix-0.7.2.jar                             |
```

`IbpegIs` 与 `SUMNxTv` 均实测为 MC 1.12.2 / Cleanroom 0.6.13-alpha / ZalithLauncher 2.7 / Java Internal-25。

> 注意别把「装了 VintageFix」当成这条签名：`WXKqV2p`、`aftmdbe` 同样装有 vintagefix，但日志里只有
> `Loading early loader org.embeddedt.vintagefix.core.VintageFixCore` 与 `Not applying mixin ... as
> 'mixin.version_protest' is disabled in config` 两类正常行，**没有任何注入失败**。判据必须是
> `InjectionError` / `InvalidInjectionException` / `Method overwrite conflict` 之一。

**案例 3：两个不同模组声明同一个 mod ID（Forge 1.19.2-43.3.8，logId: 378g7jG）**

```
[10:41:05] [main] [net.minecraftforge.fml.loading.UniqueModListBuilder/ERROR]: Found duplicate mods:
	Mod ID: 'jei' from mod files: REIPluginCompatibilities-forge-9.0.90.jar, jei-1.19.2-forge-11.6.0.1019.jar
[10:41:05] [main] [net.minecraftforge.fml.loading.moddiscovery.ModDiscoverer/ERROR]: Failed to build unique mod list after mod discovery.
net.minecraftforge.fml.loading.EarlyLoadingException: Duplicate mods found
	at MC-BOOTSTRAP/fmlloader@1.19.2-43.3.8/net.minecraftforge.fml.loading.UniqueModListBuilder.buildUniqueList(UniqueModListBuilder.java:87)
	at MC-BOOTSTRAP/fmlloader@1.19.2-43.3.8/net.minecraftforge.fml.loading.moddiscovery.ModDiscoverer.discoverMods(ModDiscoverer.java:105)
```

同形态共 6 份且**组合完全相同**：`378g7jG`、`77MJFca`、`Ad19Wxi`、`DVuHAk0`、`OTTSGtx`、`YxSAXXB`
（均为 `REIPluginCompatibilities-forge-9.0.90.jar` + `jei-1.19.2-forge-11.6.0.1019.jar`）。

**案例 4：同作者的两个模组版本不同步（Forge 1.20.1，logId: CClmrl4）**

```
Caused by: java.lang.NoSuchMethodError: 'void traben.entity_texture_features.utils.EntityIntLRU.defaultReturnValue(int)'
	at traben.entity_model_features.EMFManager.<init>(EMFManager.java:103) ~[entity_model_features_forge_1.20.1-2.4.1.jar%23222!/:?]
	at traben.entity_model_features.EMFManager.getInstance(EMFManager.java:110) ~[entity_model_features_forge_1.20.1-2.4.1.jar%23222!/:?]
	at traben.entity_model_features.EMF.testForForgeLoadingError(EMF.java:119) ~[entity_model_features_forge_1.20.1-2.4.1.jar%23222!/:?]
```

**案例 5：两个模组注册同一个网络包 ID（MC 1.21.x / Fabric，logId: 3p6H4Rt）**

```
Caused by: java.lang.IllegalArgumentException: Packet type net/<P>/CustomPayload$Id[id=yumou_zstu_builder_fabri:board_open] is already registered!
	at knot//net.fabricmc.fabric.impl.networking.PayloadTypeRegistryImpl.register(PayloadTypeRegistryImpl.java:58)
	at knot//cn.blockforge.generated.yumouzstubuilderfabri.client.YumClient.onInitializeClient(YumClient.java:17)
```

**案例 6：refmap 里留着未展开的构建占位符（按模组成批出现）**

```
Reference map '${mod_id}.refmap.json' for nemos_backpacks.mixins.json could not be read
Reference map '${mod_id}.refmap.json' for nemos_backpacks.client.mixins.json could not be read
Reference map '${archivesBaseName}-refmap.json' for createdieselgenerators.mixins.json could not be read
Reference map '${mixin_refmap}' for createschematicchecker.mixins.json could not be read
```

完整行带 Fabric 的固定后缀（同一份日志内成批出现）：

```
[10:19:02] [main/WARN]: Reference map 'mixins.betterbiomeblend.refmap.json' for mixins.betterbiomeblend.json could not be read. If this is a development environment you can ignore this message
```

占位符的名字就是**打包脚本的变量名**，可以直接反推是哪个构建配置漏了资源替换；实测占位符的种类与
份数随抽样批次的模组构成剧烈变化（一批 200 余份、另一批 17 份，后者几乎全是同一个模组）：

```
Reference map '${refmap_target}refmap.json' for ferritecore.predicates.mixin.json could not be read
Reference map '${refmap_target}refmap.json' for ferritecore.fastmap.mixin.json could not be read
```

所以这一条的判据是**占位符本身**（`${mod_id}` / `${refmap_target}` / `${archivesBaseName}` /
`${mixin_refmap}`），不是份数。

refmap 缺失会直接导致注入目标找不到：

```
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on OO0ooo0OooOoO0OoO0ooOO0o could not find any targets matching 'onStatusEffectsRemoved(Lnet/<P>/StatusEffectInstance;)V' in net/<P>/LivingEntity. No refMap loaded. [INJECT_PREP...
```
（logId: BB5MqKw，模组 `yes_steve_model`）

**案例 7：模组为另一个 MC 版本编译，refmap 有但目标方法不存在（logId: qCyqzZO）**

```
[10:46:53] [main/INFO]: Compatibility level set to JAVA_17
[10:46:54] [main/INFO]: Initializing MixinExtras via com.llamalad7.mixinextras.service.MixinExtrasServiceImpl(version=0.5.0).
[10:46:55] [main/FATAL]: Mixin apply failed flywheel.impl.mixins.json:MinecraftMixin -> net.minecraft.client.Minecraft: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @Inject annotation on flywheel$onEndI...
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure: @Inject annotation on flywheel$onEndInitialResourceReload could not find any targets matching 'lambda$new$5' in net.minecraft.client.Minecraft. Using refmap flywheel.refmap.json [PREINJ...
	at org.spongepowered.asm.mixin.injection.struct.InjectionInfo.validateTargets(InjectionInfo.java:656) ~[mixin-0.8.5.jar:0.8.5+Jenkins-b310.git-<H>]
```

**案例 8：两个模组各有一半注入点失效（logId: 9NMmWZO、Hkl15yW、QhrLYts）**

```
Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure: Constant modifier method smfsmir$widenSkillTriggerChance(F)F in smfsmir.mixins.json:server.GhostMasterTeamSkillMixin from mod smfsmir failed injection check, (0/1) succeeded. Scanned 0 target(s).
```
（`Scanned 0 target(s)` 表示一个候选点都没扫到）

```
Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [mixins.kingsword.json:Defense.SpecificMods.OtherMods.MoreAvaritiaMixin] from phase [DEFAULT] in config [mixins.kingsword.json] FAILED during APPLY
Caused by: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Invalid descriptor on mixins.kingsword.json:Defense.SpecificMods.OtherMods.MoreAvaritiaMixin->@Inject::preventKillEntity(Lnet/<P>/LivingEntity;Lnet/<P>/L...
```
（logId: Hkl15yW，`Invalid descriptor` 表示注入方法签名与目标不匹配）

```
Caused by: org.spongepowered.asm.mixin.transformer.throwables.MixinPreProcessorException: Attach error for fastanim.mixins.json:MathHelperMixin from mod faster_entity_animations during activity: [Transform -> Method lerpAngleDegrees(FFFLorg/spongepowered/asm/mixin/injection/callback/CallbackInfoReturnable;)V -> INVOKESTATIC -> java/lang/Float::valueOf:(F)Ljava/lang/Float;]
	at org.spongepowered.asm.mixin.transformer.MixinPreProcessorStandard.attach(MixinPreProcessorStandard.java:313) ~[sponge-mixin-0.13.3+mixin.0.8.5.jar:0.13.3+mixin.0.8.5]
```
（logId: QhrLYts）

**案例 9：模组之间互相禁用 Mixin（全局开关，抽样中百余份日志）**

```
[10:25:15] [main/WARN]: Force-disabling mixin 'world.player_chunk_tick.ThreadedAnvilChunkStorageMixin' as rule 'mixin.world.player_chunk_tick' (added by mods [krypton]) disables it and children
[10:25:16] [main/WARN]: Force-disabling mixin 'features.render.entity.CuboidMixin' as rule 'mixin.features.render.entity' (added by mods [iris]) disables it and children
[10:25:16] [main/WARN]: Force-disabling mixin 'features.render.entity.ModelPartMixin' as rule 'mixin.features.render.entity' (added by mods [iris]) disables it and children
```

**案例 10：模组在别人的类上注入，而那个模组不在场（logId: Glibzwj、1xemwtq）**

```
[11:00:34] [main] [mixin/WARN]: @Mixin target mezz.jei.library.gui.widgets.AbstractScrollWidget was not found manaita_plus_general.mixins.json:AbstractScrollWidgetAccessor
[11:00:34] [main] [mixin/WARN]: Error loading class: mezz/<P>/AbstractScrollWidget (java.lang.ClassNotFoundException: mezz.jei.library.gui.widgets.AbstractScrollWidget)
```
（logId: Glibzwj，模组 `manaita_plus_general` 在 JEI 的类上注入）

```
[10:56:53] [main] [mixin/WARN]: @Mixin target com.github.alexthe666.alexsmobs.entity.ai.SeagullAIStealFromPlayers was not found kaleidoscope_nether.mixins.json:alexsmobs.SeagullAIStealFromPlayersAccessor from mod kaleidoscope_nether
[10:56:53] [main] [mixin/WARN]: Error loading class: com/<P>/SeagullAIStealFromPlayers (java.lang.ClassNotFoundException: com.github.alexthe666.alexsmobs.entity.ai.SeagullAIStealFromPlayers)
```
（logId: 1xemwtq，模组 `kaleidoscope_nether` 在 Alex's Mobs 的类上注入）

## 含义

**先分清失败的阶段。** Mixin 的失败信息里带阶段名，阶段决定了排查方向：

| 日志片段 | 阶段 | 含义 |
|---|---|---|
| `MixinApplyError ... FAILED during PREPARE` | 准备 | 配置/类还没读进来就失败（如 `MixinConfig.prepareMixins`）|
| `MixinApplyError ... FAILED during APPLY` | 应用 | Mixin 类已加载，注入过程抛异常 |
| `InvalidInjectionException` / `InjectionError` | 注入 | 应用阶段内部的具体注入失败 |
| `MixinPreProcessorException: Attach error` | 应用 | 注入点改写时方法体结构不符 |
| `MixinTransformerError: An unexpected critical error was encountered` | 变换 | Mixin 管线自身抛异常，真正的异常在它的 `Caused by` 里 |

**判据 1：`MixinTransformerError` 必须往下看两层。** 案例 1 的表层是 `MixinTransformerError`（抽样中
数十份日志都有这一行，不是案例 1 专有），真正的结论在 `Caused by: java.lang.ClassCastException: class java.util.ArrayList cannot be
cast to class org.objectweb.asm.tree.AnnotationNode`，并且栈帧落在
`com.llamalad7.mixinextras.*`。看到 `MixinExtras` 出现在栈里，就该先查 MixinExtras 与运行时 Mixin 的
版本组合（案例 1 的 7 份日志全部是 MixinExtras 0.5.0 + `mixin 0.8.7`）。

**判据 2：两个模组注入同一个目标时，日志会给出两个模组的名字。** 案例 2 的两条失败各自
点名了注入方——`from mod datarium` 与 `from mod vintagefix`——而目标都是
`net.minecraft.client.resources.FallbackResourceManager`。`@At("INVOKE") ... cannot inject into ...`
与 `failed injection check, (0/1) succeeded` 是**同一个注入点被前一个 Mixin 改写后消失**的两种表达。
这种情况下**单独卸载哪一个都能启动**，因此不能只按「报错最先出现的那个模组」处理。

**判据 3：`duplicate mod id` 不等于「同一个 jar 装了两份」。** 案例 3 的 `Mod ID: 'jei' from mod files:
REIPluginCompatibilities-forge-9.0.90.jar, jei-1.19.2-forge-11.6.0.1019.jar` 里，被点名的两个 jar 文件名
完全不同。REI Plugin Compatibilities 是一个**有意声明 `jei` 这个 mod ID 的 REI 兼容层**（它实现 JEI 的
API 但不包含 JEI），用途是让为 JEI 写的插件能在 REI 下工作；因此它与真正的 JEI 不能共存。
判定方式：比较 `from mod files:` 后面两个**文件名**——文件名不同却 ID 相同，就是两个不同的模组。

**判据 4：refmap 缺失有两种表现。** 案例 6 是**构建期**问题：`${mod_id}`、`${mixin_refmap}`、
`${archivesBaseName}` 是 Gradle 的占位符，说明打包时没有做资源替换；抽样中二百份左右日志里这一行是 WARN，
但同一份日志常常紧接着出现 `No refMap loaded`（案例 6 第二条），此时注入目标**退化为按字面名匹配**，
在开发映射与生产映射不一致的环境里必然找不到。Fabric 打印的
`If this is a development environment you can ignore this message` 在这里是误导——从启动器启动时它是
真实缺陷的征兆。

**判据 5：refmap 正常但目标不存在 = 模组为另一个 MC 版本编译。** 案例 7 里
`Using refmap flywheel.refmap.json` 说明 refmap 被读到了，仍然
`could not find any targets matching 'lambda$new$5'`。`lambda$new$5` 是编译器生成的 lambda 序号名，
**序号本身随 MC 版本重编译而改变**——这是目标与模组编译版本不一致的强信号。

**判据 6：模组之间会互相关掉对方的 Mixin。** 案例 9 的
`Force-disabling mixin '...' as rule 'mixin....' (added by mods [krypton]) disables it and children`
表示**由模组主动关闭**另一个模组的一整组 Mixin（`krypton`、`iris` 是常见的关闭方）。这是设计行为，
不是错误；但它意味着**「某个优化模组的 Mixin 没生效」的原因可能在另一个模组身上**。

**判据 7：`NoSuchMethodError` 指向库作者自己的包名 = 同作者模组版本不同步。** 案例 4 的符号
`traben.entity_texture_features.utils.EntityIntLRU.defaultReturnValue(int)` 落在
`entity_texture_features`（ETF）包里，而调用方是 `entity_model_features`（EMF）
（`entity_model_features_forge_1.20.1-2.4.1.jar`）。两个模组由同一作者维护、共享工具类，必须**成对更新**。
这与 `cases/dependency-and-version.md` 里 `NoSuchMethodError` 指向 `net.minecraft.*`（MC 版本错配）
的区别在于：**符号所属的包名是不是加载器/游戏/加载器的**。

## 常见触发

### 触发 A：MixinExtras 与运行时 Mixin 版本组合不匹配（案例 1）

MixinExtras 可以由多个模组各自 jar-in-jar 打包，Fabric Loader 会选其中最高的一个并打印
`Initializing MixinExtras via ...MixinExtrasServiceImpl(version=X.XX.X)`；而 `sponge-mixin-<版本>+mixin.0.8.7`
由加载器自己提供。两者是**两条独立的版本线**，任何一条偏了都可能出现案例 1 的 `ClassCastException`。
实测 7 份日志的组合是 MixinExtras 0.5.0 + `mixin 0.8.7`。

同类但不同写法的注入失败（同一份日志里可以同时出现多种）：

- `Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure: Callback method flushItemBatching(Lnet/<P>/GuiGraphics;IIFLorg/<P>/CallbackInfo;Lcom/<P>/LocalFloatRef;Lcom/<P>/LocalBooleanRef;)V in acceleratedrendering.compat.sophisticated.mixins.json:StorageS`（logId: 1hYcdK9、31tvt36、RelCWPr）
- `Caused by: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure: Callback method iris$beginClouds(Lcom/<P>/PoseStack;Lorg/joml/Matrix4f;FDDDLorg/<P>/CallbackInfo;)V in mixins.oculus.json:MixinLevelRenderer failed injection check, (0/1) succeeded. Scanned 1 targ`（logId: BrnG3s0）

### 触发 B：两个模组改同一个目标类（案例 2）

命中条件是「功能重叠」：`datarium` 与 `vintagefix` 都在改 `FallbackResourceManager`（资源包回退逻辑）。
同类组合在实测中还有：

- `mixins.iris.compat.sodium.json` 的 `MixinRenderSectionManager` 与 Sodium 自身的渲染注入（refmap 找不到时打印 `Reference map 'iris.refmap.json' for mixins.iris.compat.sodium.json was not found`）
- `manaita_plus_general` 注入 JEI 的 `AbstractScrollWidget`（案例 10）
- `kaleidoscope_nether` 注入 Alex's Mobs 的 `SeagullAIStealFromPlayers`（案例 10）

**两种不同的后果**：注入点被抢走 → `cannot inject into ...`（崩溃，案例 2）；目标类整个不存在 →
`@Mixin target ... was not found` 的 WARN（不崩溃，案例 10）。后者是 WARN 级，日志会继续，
但那个模组的功能**静默失效**。

### 触发 C：一个 jar 声明了别人的 mod ID（案例 3）

实测全部 6 份都是同一对（REI Plugin Compatibilities 与 JEI）。触发条件是用户同时装了 REI 家族与 JEI，
常见于「整合包带了 REI，用户又按教程装了 JEI 及其插件」。Forge 的检查发生在
`UniqueModListBuilder.buildUniqueList`，即**模组发现阶段**，早于依赖求解，因此日志里
**看不到任何 `Reason` / `Fix` 行**，也**没有 `crash-reports/`**。

### 触发 D：同作者的一组库模组版本不同步（案例 4）

`entity_model_features`（EMF）与 `entity_texture_features`（ETF）共享工具类，
`traben.entity_texture_features.utils.*` 是它们之间的私有 API。只更新其中一个就会出现
`NoSuchMethodError`，且错误发生在模组自己的 `<init>` / 静态初始化里，看起来像「模组坏了」。

### 触发 E：注册同一个网络包 ID / 条目（案例 5）

Fabric 侧表现为 `Packet type ... is already registered!`（logId: 3p6H4Rt），
Forge 侧同类表现为 `Skipping automatic mod flansmod entity registration for already registered entry ...`
（DEBUG 级，不致命）。

### 触发 F：模组为另一个 MC 版本编译或打包不完整（案例 6、7、8）

三种子形态：

| 子形态 | 判据 | 是否崩溃 |
|---|---|---|
| refmap 占位符未展开 | `Reference map '${...}' for <config> could not be read` | 不崩溃，但可能连锁 `No refMap loaded` 崩溃 |
| refmap 正常、目标方法不存在 | `could not find any targets matching '<名字>' ... Using refmap <文件>` | 崩溃（`FATAL`） |
| 注入描述符不匹配 | `Invalid descriptor on <config>->@Inject::<方法>(<签名>)` | 崩溃 |

## 修复步骤

**触发 A（MixinExtras / Mixin 组合）**

1. 先找出**决定性的一行**：从 `Caused by` 里抄出真正抛出的异常（`ClassCastException`、`NoSuchMethodError`、`IllegalStateException`），不要停在外层 `MixinTransformerError`
2. 若栈里出现 `com.llamalad7.mixinextras.*`，读 `Initializing MixinExtras via ... version=X` 得到当前生效版本
3. 让加载器**统一提供** MixinExtras：升级 Fabric Loader 到与 MC 版本匹配的最新版，或移除那些自带 MixinExtras 的模组（一份日志里出现多个 MixinExtras 版本时更应如此）
4. 多份日志共用同一组合（案例 1 为 7 份）时，可判定为**该组合的系统性不兼容**，不是单个用户的环境问题

**触发 B（同目标双注入）**

1. 在 `Mixin apply for mod <A> failed ... from mod <A>` 与 `... from mod <B>` 两条里**收集全部模组名**，两边都要处理
2. 逐个禁用验证：先禁 A 能启动就说明 B 是兼容的，反之亦然；找到两者中**较旧 / 较久未更新**的那个
3. 两个模组功能重叠（都是资源包回退优化）时，保留一个即可，不要试图调优先级——`priority 1000` 已经是很高的优先级仍然失败
4. 出现 `@Mixin target ... was not found` 的 WARN 时，检查被注入的那个模组**是否装了、是否是同一版本线**

**触发 C（重复 mod ID）**

1. 从 `Found duplicate mods:` 块里读出 `Mod ID:` 与接下来的 `from mod files:` 两个文件名
2. 文件名不同而 ID 相同时，**卸载功能重复的那一个**（实测对为 REI Plugin Compatibilities 与 JEI：装了 REI 就不要装 JEI，反之亦然）
3. 处理完重启游戏；这一步发生在模组发现阶段，`/reload` 无效
4. 该问题**不产生 crash-report**，日志中也没有 `Reason` / `Fix` 行，不要把「找不到崩溃报告」当作「没有崩溃原因」

**触发 D（同作者库不同步）**

1. 从 `NoSuchMethodError` 的描述符里取**包名**（如 `traben.entity_texture_features.utils.*`）
2. 用包名反查它属于哪个模组，然后把**同作者的同组模组一起更新到同一发布时间线**
3. 单独更新报错方无效——缺失的符号在**另一个**模组里

**触发 E（包 ID / 条目重复注册）**

1. 从 `Packet type ... is already registered!` 里取完整的 `namespaced:id`（如 `yumou_zstu_builder_fabri:board_open`）
2. 该命名空间前缀即重复注册的模组（`...fabri` 后缀说明是某个源模组的附属），禁用其中一个
3. `Skipping automatic mod ... for already registered entry` 是 DEBUG 级，**不要**当成故障处理

**触发 F（编译版本 / 打包不全）**

1. `Reference map '${...}'` 里的 `${...}` 是构建占位符 → 该模组的 jar **打包不完整**，直接换该模组在对应 MC 版本下的另一个构建
2. `could not find any targets matching '<名字>'` 且名字里带 `lambda$` → 目标方法与当前 MC 版本不符，改下载匹配当前 MC 版本的构建
3. `Invalid descriptor on ...->@Inject::<方法>(<签名>)` → 注入方法签名与目标方法不匹配，同样是版本不符
4. 三者都**不是** `--add-opens`、JVM 参数或内存设置能解决的

## 置信度线索

> **份数的读法**：本文所有「份数」都是**抽样观测值**，不是全库比例。观测方式为取生产库最近上传的
> 700 条记录（去重后 685 份日志，2026-10）。同一签名的份数在批次间可差一个数量级（`Reference map '...'`
> 一批 204 份、另一批 213 份，而 `Found duplicate mods` 一批 6 份、另一批 1 份），因为模组构成随流量变化。
> 判据一律用**签名本身**，份数只作量级参考。

- **确定（MixinExtras 参与）**：`Caused by` 的栈帧里出现 `com.llamalad7.mixinextras.*`，或日志有 `Initializing MixinExtras via ... version=X`
- **确定（同目标双注入）**：同一条 `Mixin apply for mod <A> failed ... from mod <A>` 与另一次 `<B>` 指向同一目标类名，且两次都把 `<配置文件名>` 打印出来
- **确定（重复 mod ID）**：`Found duplicate mods:` + `Mod ID: '<ID>' from mod files: <A>.jar, <B>.jar`，且 `<A>.jar` 与 `<B>.jar` 文件名不同。此时日志**没有** `Reason` / `Fix` 行
- **确定（refmap 打包不完整）**：`Reference map '` 后出现 `${mod_id}` / `${mixin_refmap}` / `${archivesBaseName}` 等**未展开的占位符**
- **确定（MC 版本不符）**：`could not find any targets matching '<含 lambda$ 的名字>'`、`failed injection check, (0/N) succeeded`、`Invalid descriptor on ...->@Inject::...`
- **确定（同作者库不同步）**：`NoSuchMethodError` 描述符中的包名**既不是** `net.minecraft.*` **也不是** `net.minecraftforge.* / net.neoforged.* / net.fabricmc.*`，而是第三方库自己的包名（如 `traben.entity_texture_features.utils.*`）。此时不是 MC 或加载器版本错配
- **需区分（WARN 不等于根因）**：以下三行在抽样中分别出现 二百份左右 / 一百份以上 / 数十份，都是 WARN，日志继续：
  - `Reference map '...' for ... could not be read. If this is a development environment you can ignore this message`
  - `Force-disabling mixin '...' as rule '...' (added by mods [...]) disables it and children`
  - `@Mixin target ... was not found` 与紧随的 `Error loading class: ... (java.lang.ClassNotFoundException: ...)`
  只有当崩溃栈里出现 `No refMap loaded` 或 `could not find any targets matching` 时，refmap 才升级为根因
- **需区分（`MixinTransformerError` 只是外壳）**：单独出现 `MixinTransformerError: An unexpected critical error was encountered` 无法定位问题，必须读它的 `Caused by`。抽样中数十份日志含这一行，其中真正的异常各不相同
- **需追问**：日志未给出 Mixin / 加载器版本时向用户确认。`Loading Minecraft X with Fabric Loader Y`、`sponge-mixin-A+mixin.B.jar` 的方括号版本号、`Initializing MixinExtras via ... version=Z` 三者合起来即可复原完整版本组合
- **边界提示**：本条只处理「两个模组都装得上」的冲突。若日志出现 `Mod resolution failed` / `Some of your mods are incompatible with the game or each other!` / `HARD_DEP*`，请转 `cases/dependency-and-version.md`
