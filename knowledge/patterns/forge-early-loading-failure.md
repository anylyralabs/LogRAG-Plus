# Forge / NeoForge 早期加载阶段失败（`EarlyLoadingException` 与生命周期事件异常）

## 签名 (Signature)

下列频次的分母是 2026-10-17 抽取的 499 份真实日志全文（FCL 369 / axolotl 77 / ZL2 51 / Web 上传 2），括号内为命中份数。

**模组扫描阶段的唯一列表构建失败（Forge，致命，先于游戏主类）**

（`EarlyLoadingException` 6/499、`Found duplicate mods` 6/499、`Failed to build unique mod list` 6/499；三者在同一份日志内成组出现。这批日志含崩溃报告的比例为 30%。）

```
[10:41:05] [main] [net.minecraftforge.fml.loading.UniqueModListBuilder/ERROR]: Found duplicate mods:
	Mod ID: 'jei' from mod files: REIPluginCompatibilities-forge-9.0.90.jar, jei-1.19.2-forge-11.6.0.1019.jar
[10:41:05] [main] [net.minecraftforge.fml.loading.moddiscovery.ModDiscoverer/ERROR]: Failed to build unique mod list after mod discovery.
net.minecraftforge.fml.loading.EarlyLoadingException: Duplicate mods found
	at MC-BOOTSTRAP/fmlloader@1.20.1-47.4.28/net.minecraftforge.fml.loading.UniqueModListBuilder.buildUniqueList(UniqueModListBuilder.java:87)
	at MC-BOOTSTRAP/fmlloader@1.20.1-47.4.28/net.minecraftforge.fml.loading.moddiscovery.ModDiscoverer.discoverMods(ModDiscoverer.java:78)
	at MC-BOOTSTRAP/fmlloader@1.20.1-47.4.28/net.minecraftforge.fml.loading.FMLLoader.beginModScan(FMLLoader.java:173)
```

**生命周期事件派发阶段的模组异常（Forge 单条形态 / NeoForge 汇总形态）**

（Forge 与 NeoForge 的 `ModLoadingException` 合计 19/499、69 行；**这批日志 100%（19/19）含崩溃报告**。）

```
net.minecraftforge.fml.ModLoadingException: Sophisticated Backpacks (sophisticatedbackpacks) encountered an error during the common_setup event phase
net.minecraftforge.fml.ModLoadingException: Create (create) encountered an error during the common_setup event phase
net.minecraftforge.fml.ModLoadingException: Annoying Villagers (annoyingvillagers) encountered an error during the sided_setup event phase
net.minecraftforge.fml.ModLoadingException: spark has class loading errors

net.neoforged.fml.ModLoadingException: Loading errors encountered:
	- Copper Age Backport (copperagebackport) encountered an error while dispatching the net.neoforged.neoforge.registries.RegisterEvent event
```

NeoForge 的 `Loading errors encountered:` 是**汇总行**，其下以制表符加 `- ` 逐条列出每个在事件派发中失败的模组，因此一次启动可以列出多条互不相关的失败，不要只处理第一条。

**加载器拒绝向已损坏的模组状态继续派发事件（级联症状，量大）**

（28/499，5.6%；全文合计 1503 行，单份日志最高数十行。**同样 100%（28/28）含崩溃报告**。）

```
[10:22:23] [Render thread] [net.minecraftforge.fml.ModLoader/ERROR]: Cowardly refusing to send event net.minecraftforge.client.event.EntityRenderersEvent$CreateSkullModels to a broken mod state
[10:33:14] [Render thread/ERROR] [ne.ne.fm.ModLoader/]: Cowardly refusing to send event net.neoforged.neoforge.client.event.EntityRenderersEvent$CreateSkullModels to a broken mod state
[10:55:04] [Render thread/ERROR] [ne.ne.fm.ModLoader/]: Cowardly refusing to send event net.neoforged.neoforge.client.event.sound.SoundEngineLoadEvent to a broken mod state
```

**1.12.2 时代：coremod 混入触碰了加载器自身的类（`was loaded too early`）**

（4/499；本抽样中只在 1.12.2 的 `net.minecraftforge.fml.common.*` 目标上出现。）

```
[10:53:31] [main/ERROR]: Critical problem: mixins.devenv.json:FMLModContainerMixin from mod loliasm target net.minecraftforge.fml.common.FMLModContainer was loaded too early.
```

**早期显示窗口的 TRACE（旁证：说明崩溃发生在模组加载期）**

（`Loading ImmediateWindowProvider fmlearlywindow` 133/499；`FMLConfig earlyWindow` 1/499、20 行；`[EARLYDISPLAY/...]` 26/499。这些行本身**都是正常输出**，不是故障。）

```
[10:49:57] [main/TRACE]: FMLConfig earlyWindowControl is true
[10:49:57] [main/TRACE]: FMLConfig earlyWindowProvider is fmlearlywindow
[10:58:23] [main/INFO]: Loading ImmediateWindowProvider fmlearlywindow
[10:58:49] [main] [EARLYDISPLAY/INFO]: Requested GL version 4.6 got version 4.6
```

## 含义

Forge / NeoForge 的启动是一条阶段链，每个阶段的失败都有专属的异常类型，且**越早的阶段越没有证据可查**：

| 阶段 | 加载器动作 | 失败时的异常 | 是否生成 `crash-reports/` |
|---|---|---|---|
| 扫描 | `FMLLoader.beginModScan` → `ModDiscoverer.discoverMods` | `EarlyLoadingException` | **否** |
| 唯一列表 | `UniqueModListBuilder.buildUniqueList` | `EarlyLoadingException: Duplicate mods found` | **否** |
| 生命周期事件 | `ModLoader` 逐个派发 `common_setup` / `sided_setup` / `RegisterEvent` / `RegisterClientExtensionsEvent` … | `ModLoadingException` | 是（19/19） |
| 事件派发被跳过 | 某模组已被标记损坏，加载器不再向它派发 | `Cowardly refusing to send event ... to a broken mod state` | 是（28/28） |

前两行是**加载器自身的失败**（栈帧前缀为 `MC-BOOTSTRAP/fmlloader@<版本>`，即加载器在模块化类路径上的类加载器名），后两行是**模组失败的后果**。

这里有一条与直觉相反、但本抽样反复验证的规律：

**`EarlyLoadingException` 中止时没有崩溃报告，而 `ModLoadingException` 与 `Cowardly refusing` 一定有。** 崩溃报告的写入需要 MC 主类与游戏窗口已建立，扫描 / 唯一列表阶段发生在它们之前，进程直接退出；后两者则发生在 MC 已启动、早期显示窗口已存在之后（`[EARLYDISPLAY/INFO]` 与 `Loading ImmediateWindowProvider fmlearlywindow` 就是窗口已建的证据）。因此**日志里找不到 `crash-reports/` 不能证明"没有崩溃"**。

`Cowardly refusing ... to a broken mod state` 的语义是"该模组此前已经失败，我不再向它派发事件"。它**不是原因**：一条事件对应一行，单个根因可以放大成上千行（实测 28 份日志共 1503 行）。真正的原因在**它之前**的第一条 `ModLoadingException` / `Exception caught during firing event` / `Failed to create mod instance` 上。

**Forge 与 NeoForge 的判读方式**：包名 `net.minecraftforge.fml.*` 是 Forge，`net.neoforged.fml.*` 是 NeoForge；logger 名 `[ne.mi.fm.ModLoader/]` 是 Forge 的缩写形式、`[ne.ne.fm.ModLoader/]` 是 NeoForge 的缩写形式，与全名 logger（`[net.minecraftforge.fml.ModLoader/]`）指的是同一个类，不能仅凭 logger 缩写判断版本。

**各启动器下的表现差异（同一个故障，读数不同）**：

| 启动器 | 表现 | 读数重点 |
|---|---|---|
| FCL | Java 栈外层套 `at mio.Wrapper.main(Wrapper.java:21)`；进程异常退出后另起一行 `OpenJDK exited with code : 1` | 早期中止时**只有**这一行收尾，既无崩溃报告也无 FATAL；判断依据全部来自 `OpenJDK exited` 之上的最后一段栈 |
| axolotl | 不套 wrapper，日志直接以加载器栈结尾 | NeoForge 的 `Loading errors encountered:` 汇总段在 axolotl 样本里更常见，可据此一次列出所有失败模组 |
| ZL2 | 不套 wrapper，日志前缀为标准 Java 栈 | 与 axolotl 同判；日志内 `Loading Minecraft <版本>` 行可用于确认运行版本 |

## 常见触发

### 触发 A：同一个 mod ID 出现两份 jar，唯一列表无法收敛

`Found duplicate mods:` 后逐条给出 `Mod ID: '<ID>' from mod files: <jar1>, <jar2>`。

实测形态值得注意：其中一个 jar 往往不是该模组本体，而是**别的模组的兼容插件**。上例中 `Mod ID: 'jei'` 的两个来源是 `REIPluginCompatibilities-forge-9.0.90.jar`（REI 为 JEI 写的兼容插件）与 `jei-1.19.2-forge-11.6.0.1019.jar`（JEI 本体），即兼容插件把 `jei` 声明成了自己的身份。因此排查时**不能只按文件名去找"重复的两个 JEI"**，要以日志给出的文件名对为准。

删除动作见「模组间冲突」；本条目只负责指出它属**扫描阶段中止**、不会有崩溃报告。

### 触发 B：模组在生命周期事件的回调里抛异常

Forge 报 `<模组显示名> (<模组ID>) encountered an error during the <阶段> event phase`，NeoForge 报 `- <模组显示名> (<模组ID>) encountered an error while dispatching the <事件全名> event`。

两种措辞的粒度不同：Forge 给的是阶段名（实测 `common_setup`、`sided_setup`），NeoForge 给的是**具体事件类全名**（实测 `net.neoforged.neoforge.registries.RegisterEvent`、`net.neoforged.neoforge.client.extensions.common.RegisterClientExtensionsEvent`）。NeoForge 的措辞更有用，可直接定位到那个事件。

同一个阶段可以并列多条不同模组的失败（`Loading errors encountered:` 之下），务必全部读出。

### 触发 C：前一个模组把加载器状态搞坏，后续事件全部被跳过

`Cowardly refusing to send event <事件> to a broken mod state`。这是**后果**，不是原因。

判据：先看它**之前**有没有 `ModLoadingException` / `Exception caught during firing event` / `Failed to create mod instance`。有 → 按那一条处理；完全没有（整份日志只有 `Cowardly refusing`）→ 说明根因在更早的日志段（可能被启动器截断），需要索取完整日志。

### 触发 D：1.12.2 及更早版本的 coremod 在加载器自身初始化前触碰了 `net.minecraftforge.fml.*`

`Critical problem: <配置>:<混入类> from mod <模组ID> target net.minecraftforge.fml.common.FMLModContainer was loaded too early.`

目标是**加载器自己的类**（`net.minecraftforge.fml.*`），说明该 coremod 的注入时机早于加载器初始化。1.12.2 的句式与现代版本不同，`from` 后面会写成 `from owner <模组ID>` 或 `from mod <模组ID>` 两种形式。

本抽样中该句式仅 4 份，远比「Mixin 注入失败」条目给人的印象稀有；现代（1.13+）版本上目标被过早加载的形态改由 Mixin 框架自己的 `MixinTargetAlreadyLoadedException` 表达，不再走这一句。

### 触发 E：中止点落在早期显示窗口阶段

日志中出现 `FMLConfig earlyWindow*` 的 TRACE 与 `[EARLYDISPLAY/...]` 行之后随即终止，且无 `crash-reports/`。此时故障发生在"窗口已建、模组仍在加载"的窗口期，证据只在日志里。

`Loading ImmediateWindowProvider fmlearlywindow` 在正常启动中同样出现（133/499），**单独出现不能作为故障判据**；只有它之后紧跟终止（如 `OpenJDK exited with code : 1`）才说明中止点在此阶段。

NeoForge 侧的早期中止形态与 Forge 不同：本抽样中 NeoForge 的早期失败全部表现为生命週期事件阶段的 `ModLoadingException: Loading errors encountered:`（`while dispatching the <事件> event`），**没有观测到 NeoForge 抛出 `EarlyLoadingException`**——`EarlyLoadingException: Duplicate mods found` 的 6 份实测样本全部来自 Forge（1.19.2 / 1.20.1）。因此在 NeoForge 实例上按本条目排查时，应直接找 `Loading errors encountered:` 段，不要等 `EarlyLoadingException` 出现。

## 修复步骤

**触发 A（重复 mod ID）**

1. 按 `Mod ID: '<ID>' from mod files:` 给出的**两个文件名**进 `mods/` 目录，删掉多余的那个（不是删 ID 对应的模组本体，见触发 A 的说明）。
2. 取舍原则：两个文件里哪一个是你真正要的功能就留哪一个；兼容插件（如 `REIPluginCompatibilities-*`）与本体（如 `jei-*`）并存时，通常删兼容插件，因为它只是给本体做适配。
3. 删完后重启整客户端 / 整服，不要用 `/reload`。
4. 早期中止不会有崩溃报告，验证方式只有重启后看日志是否越过 `Failed to build unique mod list`。

**触发 B（生命周期事件异常）**

1. 读出异常行点名的**模组显示名与模组 ID**（两种措辞都直接给出，不必从栈里推断）。
2. NeoForge 形态还要读出 `while dispatching the <事件> event` 里的事件类全名——它指出该模组在哪个生命周期事件上失败。
3. 先更新该模组到与当前加载器同一发布周期的版本；这是成本最低、命中率最高的处置。
4. 只有一个模组失败、且它非必需时，移除它即可恢复启动。
5. `Loading errors encountered:` 下有多条时逐条处理，不要只处理第一条——它们通常是彼此独立的问题。
6. 不要删除 `config/` 下的文件：本类失败发生在事件回调里，与配置文件内容无关（两者分界的实测依据见「模组配置加载时序失败」）。

**触发 C（broken mod state 级联）**

1. **不要**按 `Cowardly refusing` 里的事件名去查模组，那只是被跳过的下游。
2. 在它**之上**找到第一条 `ModLoadingException` / `Exception caught during firing event` / `Failed to create mod instance. ModID: <ID>`，那才是元凶。
3. 这些"通用出口"行本身不含成因，必须继续向上读到第一条 `Caused by:`；其类型决定方向：`ClassNotFoundException` 属缺前置、`InvalidInjectionException` 属 Mixin 冲突、`ExceptionInInitializerError` 属类初始化失败。
4. 处理完根因后，这上千行 `Cowardly refusing` 会一并消失，不需要逐条清理。

**触发 D（coremod 过早加载）**

1. 读出 `target <类>`。目标是 `net.minecraftforge.fml.*` → 该 coremod 在加载器初始化前就加载了加载器自身的类。
2. 更新该 coremod 模组；它只存在于 1.12.2 及更早版本，且多为老牌性能 / 优化类 coremod。
3. 没有更新版本时移除它。不要试图通过调整模组加载顺序"把它排在后面"来绕过——这是类加载触发时机问题，不是排序问题。
4. 崩溃报告的 `WARNING: coremods are present:` 段落会列出全部已加载的 coremod，是确认嫌疑对象的最短路径。

**触发 E（早期窗口阶段中止）**

1. 确认日志中 `[EARLYDISPLAY/...]` / `FMLConfig earlyWindow*` 之后是否有栈，或直接以 `OpenJDK exited with code : 1` 收尾；只有"之后紧跟终止"才成立。
2. 该阶段的崩溃同样不写 `crash-reports/`，因此需要向用户索取**完整日志**（启动器可能只上传了尾部若干行）。
3. 定位中止点时以日志中最后一条 `INFO` / `TRACE` 行为基准，而不是以文件名或时间戳判断。

## 置信度线索

- **确定（属本类）**：日志含 `EarlyLoadingException` / `ModLoadingException` / `Cowardly refusing to send event` / `was loaded too early` 之一
- **确定（阶段归属）**：栈帧前缀为 `MC-BOOTSTRAP/fmlloader@<版本>/` 或 `MC-BOOTSTRAP/fml_loader@<版本>/` → 失败发生在加载器阶段而非模组运行期；`beginModScan` / `buildUniqueList` / `discoverMods` 三个方法名可直接读出具体阶段
- **确定（重复 ID）**：`Found duplicate mods:` 之后紧跟 `Mod ID: '<ID>' from mod files: <jar1>, <jar2>` 明细；文件名对是唯一定位依据
- **确定（元凶模组）**：`encountered an error during the <阶段> event phase` 与 `while dispatching the <事件> event` 都直接点名模组显示名与 ID
- **确定（无崩溃报告 ≠ 无崩溃）**：本类的两个阶段证据相反——`EarlyLoadingException` 组仅 30%（3/10）含崩溃报告，`ModLoadingException` 与 `Cowardly refusing` 各为 100%（19/19、28/28）。含崩溃报告的那 3 份属同一实例的另一次崩溃残留，不能据此反推本类故障会写报告
- **易误判（把后果当原因）**：`Cowardly refusing ... to a broken mod state` 是本类里最容易被当成根因的一行——它出现的次数最多（1503 行）、单独看最像"具体故障"，但它指名的模组只是**被跳过**的那个。判据：它**之前**必须有一条更早的 `ModLoadingException` / `Exception caught during firing event` / `Failed to create mod instance`
- **易误判（把正常输出当故障）**：`Loading ImmediateWindowProvider fmlearlywindow`（133/499）与 `[EARLYDISPLAY/INFO]: Requested GL version ... got version ...`（26/499）在健康启动中大量出现，它们只说明早期窗口已建，**不构成任何故障判据**
- **易误判（`earlyWindowControl` 的值）**：`FMLConfig earlyWindowControl is true` 与 `is false` 都实测存在，它只反映配置项取值（`config/fml.toml` 的 `earlyWindowControl`），与崩溃无关；不要据此判定"早期窗口被关闭导致无法显示错误"
- **需区分（重复 mod ID 的处置）**：删除哪个 jar 的动作与依据归「模组间冲突」，本条目只提供"扫描阶段中止、无崩溃报告"这一层判断
- **需区分（broken mod state 的成因分布）**：`Cowardly refusing` 与 `Failed to complete lifecycle event` 的成因列表（缺前置 / Mixin 冲突 / 配置读取时序 / 静态初始化异常）已在「模组配置加载时序失败」中逐条实测，本条目只负责指出它是级联后果
- **需追问**：日志未给出加载器类型与 MC 版本时向用户确认。Forge 与 NeoForge 的措辞不同（`encountered an error during` / `while dispatching`），且 1.12.2 与 1.13+ 的 `loaded too early` 句式不同，缺这两项无法给出准确处置
