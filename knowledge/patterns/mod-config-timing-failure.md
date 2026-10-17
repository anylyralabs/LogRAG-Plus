# 模组配置加载时序失败（配置未就绪即被读取）

## 签名 (Signature)

下列频次的分母是 2026-10-10～10-16 期间分层抽取的 536 份真实日志全文（FCL 220 / axolotl 134 / ZL2 104 / AMCL 24 / Web 上传 25 / 其他 29），括号内为命中份数；标「AI 语料」的数字另有来源，见该条说明。

**读取尚未加载的配置值（Forge / NeoForge 专属，本类主签名）**

```
java.lang.IllegalStateException: Cannot get config value before config is loaded.
	at net.neoforged.neoforge.common.ModConfigSpec$ConfigValue.getRaw
	at com.lhy.wcwt.config.WcwtClientConfig.showToolkitHotbars(WcwtClientConfig.java:159)
	at com.lhy.wcwt.client.WcwtToolkitHud.onClientTickPre(WcwtToolkitHud.java:41)
```

```
[ne.ne.bu.EventBus/EVENTBUS]: Exception caught during firing event: Cannot get config value before config is loaded. at net.neoforged.neoforge.common.ModConfigSpec$ConfigValue.getRaw
```

```
	at ae2addon@1.2.3/com.ae2addon.config.AE2AddonConfig.debugLogs(AE2AddonConfig.java:210)
	at ae2addon@1.2.3/com.ae2addon.crafting.CraftingCompat.<clinit>(CraftingCompat.java:20)
	at ae2addon@1.2.3/com.ae2addon.mixin.AE2AddonMixinPlugin.shouldApplyMixin(AE2AddonMixinPlugin.java:63)
```

（本抽样 536 份 **0 命中**；2026-09-22～10-16 的 9353 条 AI 分析记录中 **32 条**命中，其中 19 条来自 FCL 实例、1 条来自 Zalith 启动器。实测环境为 MC 1.21.1 + NeoForge 21.1.249，点名模组 AE2 WCWT 1.3.9、AE2 Addon 1.2.3、Utilitarian 1.21.1-0.19.2。该签名在本抽样缺失不代表已消失，而是本抽样窗口内的日志实例以 Fabric 与更早版本的 Forge 为主。）

**在配置加载事件里做注册（1/536）**

```
[modloading-worker-0/ERROR]: Exception caught during firing event: null
Index: 1
Listeners:
	0: NORMAL
	1: ASM: class cn.autoforged.maid_cute_activity.ClientConfigEvents onConfigLoaded(Lnet/minecraftforge/fml/event/config/ModConfigEvent;)V
java.util.ConcurrentModificationException
	at java.base/java.util.HashMap.computeIfAbsent(Unknown Source)
	at TRANSFORMER/forge@47.4.26/net.minecraftforge.client.settings.KeyMappingLookup.put(KeyMappingLookup.java:89)
	at TRANSFORMER/maid_cute_activity@1.0.1/cn.autoforged.maid_cute_activity.ClientConfigEvents.onConfigLoaded(ClientConfigEvents.java:24)
	at LAYER PLUGIN/fmlcore@1.20.1-47.4.26/net.minecraftforge.fml.config.ModConfig.fireEvent(ModConfig.java:77)
	at LAYER PLUGIN/fmlcore@1.20.1-47.4.26/net.minecraftforge.fml.config.ConfigTracker.openConfig(ConfigTracker.java:62)
```

（实测 MC 1.20.1 + Forge 47.4.26，模组 `maid_cute_activity 1.0.1`。`Listeners:` 段落直接给出监听器所属类与事件类型，是判断「哪个模组在配置事件里做了不该做的事」的最短路径。）

**配置卸载阶段保存配置时对象类型不符（1/536）**

```
java.lang.ClassCastException: class com.electronwill.nightconfig.core.SimpleCommentedConfig cannot be cast to class com.electronwill.nightconfig.core.file.CommentedFileConfig (com.electronwill.nightconfig.core.SimpleCommentedConfig and com.electronwill.nightconfig.core.file.CommentedFileConfig are in module com.electronwill.nightconfig.core@3.7.4 of loader 'SECURE-BOOTSTRAP' @1750fbeb)
	at LAYER PLUGIN/net.minecraftforge.fmlcore@26.3-66.0.10/net.minecraftforge.fml.config.ModConfig.save(ModConfig.java:79)
	at LAYER PLUGIN/net.minecraftforge.fmlcore@26.3-66.0.10/net.minecraftforge.fml.config.ConfigTracker.closeConfig(ConfigTracker.java:90)
	at LAYER PLUGIN/net.minecraftforge.fmlcore@26.3-66.0.10/net.minecraftforge.fml.config.ConfigTracker.unloadConfigs(ConfigTracker.java:57)
	at TRANSFORMER/forgeconfigapiport@26.3.1/fuzs.forgeconfigapiport.forge.impl.neoforge.NeoForgeConfigSpecAdapter.lambda$registerEventHandlers$2(NeoForgeConfigSpecAdapter.java:59)
	at TRANSFORMER/net.minecraftforge.forge@66.0.10/net.minecraftforge.client.event.ForgeEventFactoryClient.firePlayerLogout(ForgeEventFactoryClient.java:182)
	at TRANSFORMER/minecraft@26.3/net.minecraft.client.Minecraft.disconnect(Minecraft.java:2192)
```

（实测 MC 26.3 + Forge 66.0.10 + ForgeConfigAPIPort 26.3.1，触发动作是**退出世界**而不是启动。）

**配置提供者注册失败（2/536，axolotl 2）**

```
[Render thread/ERROR] [Configured/]: Failed to load config provider from mod: iceberg
[Render thread/ERROR] [Configured/]: Failed to load config provider from mod: configured
```

**构造阶段的通用尾巴（非配置专属，必须回看第一条 ERROR）**

```
[Render thread/FATAL] [ne.mi.fm.ModLoader/LOADING]: Failed to complete lifecycle event CONSTRUCT, 1 errors found
[Render thread/FATAL]: Failed to complete lifecycle event CONSTRUCT, 8 errors found
[modloading-worker-0] [net.minecraftforge.fml.ModLoader/FATAL]: Failed to complete lifecycle event SIDED_SETUP, 1 errors found
[Render thread/ERROR] [ne.mi.fm.ModLoader/]: Cowardly refusing to send event net.minecraftforge.client.event.RegisterColorHandlersEvent$Block to a broken mod state
[Render thread/ERROR] [ne.ne.fm.ModLoader/]: Cowardly refusing to send event net.neoforged.neoforge.client.event.sound.SoundEngineLoadEvent to a broken mod state
Failed to create mod instance. ModID: man, class net.mcreator.man.ManMod
Failed to create mod instance. ModID: tanshugetrees, class tannyjung.tanshugetrees.TanshugetreesMod
Failed to create mod instance. ModID: physicsmod, class net.diebuddies.physics.ModExecutor
[net.neoforged.fml.ModLoader/CORE]: Error during pre-loading phase: Mod super_resolution is incompatible with gpu_tape 0 or above
Error during pre-loading phase: Mod sablemassview requires sable 1.0 or above
Error during pre-loading phase: Mod enchdesc requires bookshelf 21.1 or above, and below 21.2
```

（`Failed to complete lifecycle event` 7/536，其中 `CONSTRUCT` 6 / `SIDED_SETUP` 1；`broken mod state` 24/536；`Failed to create mod instance` 5/536；`Error during pre-loading phase` 7/536。**这四组是任何模组构造失败的公共出口，不指向配置**：本抽样含 `Failed to complete lifecycle event CONSTRUCT` 的 7 份日志，其上方分别出现 `Failed to create mod instance`、Mixin 注入失败、`ExceptionInInitializerError`，没有一份的成因是配置读取时序，详见「含义」的分界段。）

## 含义

Forge / NeoForge 的启动是一条固定的生命周期序列，配置值在其中**有明确的就绪时点**：

| 顺序 | 阶段 | 配置状态 |
|---|---|---|
| 1 | 模组发现与 `ModConfigSpec` 注册 | spec 已注册，**值尚未加载** |
| 2 | `CONSTRUCT` 生命周期事件：反射构造每个模组实例 | 值仍未加载 |
| 3 | 配置加载：`ConfigTracker.loadConfigs` → `openConfig` → `ModConfig.fireEvent`，发出 `ModConfigEvent` | 此时才把磁盘上的 `.toml` 读入并绑定到 spec |
| 4 | `SIDE_SETUP`（客户端 / 服务端专用初始化） | 值已就绪 |
| 5 | `LOAD_COMPLETE` | 值已就绪 |
| 6 | 退出世界 / 退出游戏：`ConfigTracker.unloadConfigs` → `closeConfig` → `ModConfig.save` | 回写磁盘 |

`ModConfigSpec.ConfigValue.get()` / `getRaw()` 在阶段 1–2 调用时没有可读的值，因此抛 `IllegalStateException: Cannot get config value before config is loaded.`。这不是配置损坏，而是**读取时点早于阶段 3**；配置文件的语法与内容可以完全正常。

该异常一旦在事件回调中抛出，会被事件总线接住并记为 `Exception caught during firing event: <原异常消息>`（NeoForge 的 logger 名为 `[ne.ne.bu.EventBus/EVENTBUS]`），随后该模组被标记为损坏，游戏在此后每一次事件派发时打印 `Cowardly refusing to send event ... to a broken mod state`。**这就是「配置读取时序」与「broken mod state 噪音」之间的因果关系**：broken mod state 是后果，第一条 `Cannot get config value before config is loaded.` 才是原因。

**这些签名为什么只在 Forge / NeoForge 出现**：Fabric 没有中心化的配置系统，配置由各模组自行读写，不存在「加载器统一加载配置」的阶段，因此不会产生 `ModConfigSpec` 的加载前异常。同一句诊断在 Fabric 实例上不存在。

**与「JSON 配置文件损坏」的分界（按时序 vs 内容分）**：本类的配置文件**内容合法**，删掉它只会让模组重建一份同样会踩时序问题的新配置；JSON 损坏类则是内容无法解析（`EOFException: End of input at line 1 column 1 path $`、`MalformedJsonException`）。判据：日志出现 `Cannot get config value before config is loaded.` 或 `ConfigTracker` 栈帧时归本类；出现 gson / nightconfig 的**解析**异常（`Expected ...`、`Malformed`、`End of input`）时归 JSON 损坏类。

**与其它「模组加载失败」的分界**：`Failed to complete lifecycle event CONSTRUCT/SIDED_SETUP`、`Cowardly refusing to send event ... to a broken mod state`、`Failed to create mod instance`、`Error during pre-loading phase` 都是**加载器对「某个模组初始化失败」的统一表述**，成因分布很广：

| 通用尾巴行 | 实测其上方出现的真正成因 |
|---|---|
| `Failed to create mod instance. ModID: man, class net.mcreator.man.ManMod` | `Caused by: java.lang.ClassNotFoundException: software.bernie.geckolib.animatable.GeoEntity`（缺前置模组，属依赖失败） |
| `Failed to create mod instance. ModID: tanshugetrees, ...` | `java.lang.NoSuchMethodError: 'net.minecraft.resources.ResourceLocation net.minecraft.resources.ResourceLocation.fromNamespaceAndPath(...)'`（模组为更新的 MC 版本构建，属版本错配） |
| `Failed to complete lifecycle event CONSTRUCT, 8 errors found` | 上游 Mixin 注入失败（`InvalidInjectionException` 成批出现） |
| `Failed to complete lifecycle event CONSTRUCT, 2 errors found` | `Caused by: java.lang.ExceptionInInitializerError: Exception java.lang.RuntimeException: Failed to initilize JaVET Envirounment`（非配置） |
| `Error during pre-loading phase: Mod sablemassview requires sable 1.0 or above` | 前置模组缺失或版本不足，属依赖失败 |

因此看到通用尾巴时，**必须向上读同一条模组加载流程里的第一条 `ERROR` / `Caused by:`**，不能把它当成根因，更不能据此去改配置文件。

**同一个问题在不同启动器下的表现差异**（实质相同，读数不同）：

| 启动器 | 表现 | 读数重点 |
|---|---|---|
| FCL | Java 栈外层套 `at mio.Wrapper.main(Wrapper.java:21)`；Forge 侧 logger 名被缩写为 `[ne.mi.fm.ModLoader/]`，事件包名为 `net.minecraftforge.client.event.*` | 日志里 `Failed to complete lifecycle event CONSTRUCT` 是 FATAL 行，成因在其上方；`OpenJDK exited with code : 1` 出现在构造期直接崩死时 |
| axolotl | 不套 wrapper，日志前缀为 `[modloading-worker-0]` / `[Render thread]`；NeoForge 侧 logger 为全名 `[net.neoforged.fml.ModLoader/]`，事件包名为 `net.neoforged.neoforge.client.event.*` | 可直接按 `net.neoforged.` 前缀区分 NeoForge 与 Forge；`Error during pre-loading phase` 集中出现于此启动器的样本 |
| ZL2 | 实例位于 `/storage/emulated/0/Android/data/com.movtery.zalithlauncher.v2/files/.minecraft/`，模组自读配置失败时消息形如 `loadFromFile(): Failed to load config file '<实例>/config/<文件>.json'`（实测 `malilib.json`） | 该消息含完整文件路径，可直接定位是哪个模组的配置；属模组自读失败，与加载器配置阶段无关 |

## 常见触发

### 触发 A：在配置加载完成前读配置（客户端 tick / HUD / 渲染事件）

模组的客户端 tick、HUD 渲染或屏幕事件在游戏极早期被触发，而配置值尚未绑定。

典型特征：`Cannot get config value before config is loaded.` 栈顶为 `ModConfigSpec$ConfigValue.getRaw`，其下是模组自己的类（如 `WcwtClientConfig.showToolkitHotbars`），再往下是 `onClientTickPre` 一类客户端事件；崩溃报告里 `Client ticks: 1 ticks` 表示崩在进游戏后的第一个 tick。

### 触发 B：在 Mixin 插件或静态初始化块里读配置

`MixinPlugin.shouldApplyMixin` 阶段或某个类的 `<clinit>` 静态初始化块里读配置，此时连 `CONSTRUCT` 都尚未开始。

典型特征：栈里出现 `<clinit>` 与 `AE2AddonMixinPlugin.shouldApplyMixin` 一类帧；`OpenJDK exited with code : 1` 且崩在 Mixin 应用阶段、早于渲染初始化。

### 触发 C：在配置加载事件里做注册或访问未初始化的注册表

模组在 `ModConfigEvent` 回调里注册按键、物品或渲染层，而注册表已经冻结或尚未建立。

典型特征：`Exception caught during firing event: null` 加 `Listeners:` 段落，指出监听器是 `<模组包名>.<类> onConfigLoaded(ModConfigEvent)`；异常多为 `java.util.ConcurrentModificationException`，其下是不可重入的注册表方法（如 `KeyMappingLookup.put`）。

### 触发 D：配置卸载 / 重载阶段保存配置时对象类型不符

退出世界或断开连接时加载器回写配置，模组提供的配置对象类型与加载器期望的类型不一致。

典型特征：崩点栈为 `ConfigTracker.unloadConfigs` → `closeConfig` → `ModConfig.save`，异常为 `ClassCastException: ... SimpleCommentedConfig cannot be cast to ... CommentedFileConfig`；触发动作在**退出世界**的调用链上（`Minecraft.disconnect` → `firePlayerLogout`），不是启动。

### 触发 E：配置提供者注册失败（配置界面类前置）

配置界面库（如 `Configured`）在解析模组配置定义时找不到可用的提供者。

典型特征：`Failed to load config provider from mod: <模组ID>`，行首 logger 为该配置界面库名（`[Configured/]`），说明该库在为这个模组生成配置界面时取不到它注册的配置提供者。实测同时点名过 `configured`（该库自身）与 `iceberg` 两个模组 ID。

## 修复步骤

**触发 A、B（读取时点过早）**

1. 从异常栈里读出**模组自己的类与行号**（`WcwtClientConfig.java:159`、`AE2AddonConfig.java:210`），它们直接指出过早读取的一行。
2. 把该模组升级到修复了配置读取时点的版本；这类问题只能由模组作者修复，用户侧没有配置项可以绕开。
3. 暂时无法升级时，移除该模组（或移出 `mods/` 目录）即可恢复启动，其他模组不受影响。
4. 不要删除 `config/` 下的相关配置文件——本类与文件内容无关，删除后重建的配置仍会在同一时点被读取。
5. 触发 B 的模组若被其他模组硬依赖，需同时停用依赖方，否则会连带报 `ClassNotFoundException`。

**触发 C（配置事件里做注册）**

1. 从 `Listeners:` 段落读出监听器所属类与事件类型（如 `ClientConfigEvents onConfigLoaded(ModConfigEvent)`）。
2. 该模组把注册动作放在了配置加载事件里，属实现缺陷；升级该模组，或移除它。
3. 报错中的 `Exception caught during firing event: null` 本身不含异常类名，需向下看紧跟的异常对象（`java.util.ConcurrentModificationException`）与其栈帧才能定位真正的注册动作。
4. 同一份日志里随后成片出现的 `Cowardly refusing to send event ... to a broken mod state` 是后果，不必逐条处理。

**触发 D（卸载阶段类型不符）**

1. 识别触发动作：栈里出现 `Minecraft.disconnect` / `firePlayerLogout` 时，问题是**退出世界**触发，而不是启动或进世界。
2. 点名的适配模组（如 `forgeconfigapiport`）与加载器版本需配套；升级该适配模组或调整为与该加载器同一发布周期的版本。
3. 该问题不影响游戏进入，只影响退出流程；正常游戏时表现为「退出世界即报错」。
4. 若伴随配置未被写回（重启后设置回到默认值），检查该模组是否有独立配置文件需要手工保留。

**触发 E（配置提供者缺失）**

1. 读出 `Failed to load config provider from mod: <模组ID>` 中的模组 ID。
2. 该模组缺少配置界面库所要求的前置，或前置版本不匹配；补齐 / 更新前置模组。
3. 单独出现该行时不影响游戏运行，仅该模组的配置界面不可用。

**通用尾巴（构造阶段失败）**

1. 定位第一条 `ERROR` / `Caused by:`，不要把 `Failed to complete lifecycle event`、`broken mod state`、`Failed to create mod instance`、`Error during pre-loading phase` 当根因。
2. `Failed to create mod instance. ModID: <ID>` 已点名模组，从其后的 `Caused by:` 判断类型：`ClassNotFoundException` 属缺前置，`InvalidInjectionException` 属 Mixin 冲突。
3. `Error during pre-loading phase: Mod <A> requires <B> <版本>` 属依赖版本不足，按提示补装或调整前置版本。
4. 只有在通用尾巴**上方**确实出现 `Cannot get config value before config is loaded.` 或配置栈帧时，才按触发 A–D 处理。

## 置信度线索

- **确定（属本类）**：日志含 `Cannot get config value before config is loaded.`，或含 `ConfigTracker.openConfig` / `ConfigTracker.unloadConfigs` / `ModConfig.fireEvent` 之一
- **确定（配置阶段）**：`Listeners:` 段落里出现 `onConfigLoaded(...ModConfigEvent)`；事件类型名即证明失败发生在配置加载事件内
- **判据（时序而非内容）**：配置文件本身可正常打开、语法合法，报错却是 `IllegalStateException: Cannot get config value before config is loaded.`；修复动作是升级或移除模组，不是改配置
- **确定（卸载阶段）**：栈里同时有 `Minecraft.disconnect` / `firePlayerLogout` 与 `ConfigTracker.unloadConfigs`，说明发生在退出世界时
- **较确定（Forge 还是 NeoForge）**：包名 `net.minecraftforge.*` 为 Forge，`net.neoforged.*` 为 NeoForge；logger 名 `[ne.mi.fm.*]` 是 Forge 的缩写形式
- **需区分（不是本类）**：`Failed to complete lifecycle event CONSTRUCT, N errors found`、`Cowardly refusing to send event ... to a broken mod state`、`Failed to create mod instance. ModID: ...`、`Error during pre-loading phase: ...` 是**模组构造失败的通用出口**，成因可能是缺前置、Mixin 冲突、静态初始化异常；本抽样 7 份含 CONSTRUCT 失败的日志中，没有一份的成因是配置读取时序
- **需区分（配置内容损坏）**：`EOFException: End of input at line 1 column 1 path $`、`MalformedJsonException`、`Expected ... to be a string, was an object` 属 JSON 配置损坏，见「JSON 配置文件损坏」
- **需区分（模组自读配置失败）**：`loadFromFile(): Failed to load config file '<路径>'`、`Failed to load config: <文件>! Overwriting with default config` 是模组自己读写配置文件失败（IO 或内容），与加载器的配置阶段无关
- **需区分（启动器重复传参，非本类）**：`joptsimple.MultipleArgumentsForOptionException: Found multiple arguments for option gameDir, but you asked for only one` 是启动器把 `--gameDir`、`--username` 一类参数拼接了两次，属启动器侧问题（AI 语料中的实测案例为 FCL 实例，日志内路径含 `FCL/.minecraft/versions/`），与配置加载时序无关；本抽样 536 份 0 命中，AI 语料 47 条记录命中
- **需追问**：日志未给出加载器类型与版本时，先索取这两项——本类签名只可能在 Forge / NeoForge 上出现，缺此前提无法定性

## 背景：Forge / NeoForge 的配置加载在模组构造之后

Forge 自 1.13 起用 `nightconfig` 统一管理模组配置，模组通过 `ModConfigSpec` 声明配置项。声明与加载是**两件事**：模组类加载时静态字段完成 spec 声明，真正的 `.toml` 读取由加载器在 `CONSTRUCT` 之后统一执行 `ConfigTracker.loadConfigs`。NeoForge 沿用同一套机制（`net.neoforged.fml.config.ConfigTracker` 与 `net.neoforged.neoforge.common.ModConfigSpec`）。

这套设计的目的是让配置值在写代码处直接可用（`ConfigValue.get()` 看起来像读普通字段），代价是**取值时点被隐藏**：开发者看不到「值是否已加载」，因此在客户端 tick、Mixin 插件、静态初始化块等更早的时机调用 `get()`，就会撞上 `Cannot get config value before config is loaded.`。这类缺陷在模组作者侧通常只在特定加载顺序或特定前置组合下暴露，因此同一个模组在部分整合包里能正常启动、在另一部分里启动即崩。

Fabric 不提供等价的加载器级配置系统，模组的配置读写各自实现、各自决定时点，因此不存在这一句诊断；同样地，`ConfigTracker` 的加载/卸载栈帧也是 Forge / NeoForge 专有。
