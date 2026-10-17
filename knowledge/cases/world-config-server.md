# 实战案例：世界 / 资源包 / 配置 / 集成服务端（包元数据、注册表引用、tick 崩溃）

本条汇集 logshare.cn 生产 AI 分析记录中**已核实**的世界侧故障。抽象规则见
`patterns/save-corruption.md`、`patterns/datapack-world-load.md`、`patterns/json-config-corruption.md`、
`patterns/entity-tick-crash.md`、`server/server-issues.md`，本条只给**真实形态**。

**先说边界。** 本条覆盖四类互不相同的失效面：

| 失效面 | 典型判据 | 后果 |
|---|---|---|
| 资源包 / 数据包元数据 | `Pack declares support for version newer than 64 ...` | WARN，包被降级或禁用 |
| 数据包内容引用 | `Unknown registry key in ResourceKey[...]` | ERROR，条目被跳过 |
| 配置文件 | `Failed to load config from <路径>` | ERROR，回落默认值 |
| 集成服务端 tick | `Can't keep up!` / `Description: Ticking entity` | 卡顿或崩溃 |

**存档文件本身（`level.dat`、`session.lock`、`region/*.mca`）的损坏在移动端样本中几乎不存在**，
详见「置信度线索」中的实测计数。

## 签名 (Signature)

**案例 1：资源包缺 `min_format` / `max_format`（MC 26.2 / Fabric Loader 0.19.5，logId: 1Z9zcMS）**

```
[10:36:18] [Render thread/WARN]: Error reading pack metadata, attempting fallback type
com.google.gson.JsonParseException: Pack declares support for version newer than 64, but is missing mandatory fields min_format and max_format
	at knot//com.mojang.serialization.DataResult$Error.getOrThrow(DataResult.java:287)
	at knot//net.minecraft.server.packs.resources.ResourceMetadata$2.getSection(ResourceMetadata.java:40)
	at knot//net.minecraft.server.packs.AbstractPackResources.getMetadataSection(AbstractPackResources.java:26)
	at knot//net.minecraft.server.packs.repository.Pack.readPackMetadata(Pack.java:56)
	at knot//net.minecraft.server.packs.repository.Pack.readMetaAndCreate(Pack.java:41)
	at knot//net.minecraft.server.packs.repository.FolderRepositorySource.lambda$loadPacks$0(FolderRepositorySource.java:63)
	at knot//net.minecraft.server.packs.repository.FolderRepositorySource.discoverPacks(FolderRepositorySource.java:94)
```

同样的异常在**压缩包**资源包上换成另一个包装行，并且会指名是哪个包（MC 26.2 / Fabric Loader 0.19.3，logId: H7Oey7r）：

```
[09:14:32] [Render thread] [net.minecraft.server.packs.repository.Pack/WARN]: Failed to read pack file/Better Fresher 3D Books v1.4.zip metadata
com.google.gson.JsonParseException: Overlay "1.21.6-1.21.8" declares support for version newer than 64, but is missing mandatory fields min_format and max_format
[09:14:32] [Render thread] [net.minecraft.server.packs.repository.Pack/WARN]: Failed to read pack file/Enchantment Glows v1.3 [1.21].zip metadata
com.google.gson.JsonParseException: Overlay "1.21.6" declares support for version newer than 64, but is missing mandatory fields min_format and max_format
[09:14:32] [Render thread] [net.minecraft.server.packs.repository.Pack/WARN]: Failed to read pack file/FreshAnimations_v1.10.zip metadata
com.google.gson.JsonParseException: Overlay "21-5" declares support for version newer than 64, but is missing mandatory fields min_format and max_format
```

该签名**按包逐个打印**，所以在单份日志内会连打很多行（`H7Oey7r` 内出现 57 次、`1Z9zcMS` 内 2 次）；
两轮抽样中各命中 20 份日志（`1Z9zcMS`、`2nSwlQB`、`2xirxjr`、
`9LyuEAD`、`FErBmZa`、`H7Oey7r`、`JDMeii3`、`QyFukxO`、`anAG9kB`、`axjik88`、`bBqJ0H8`、`fVwe261`、
`g3p3Igl`、`gC6s9SD`、`lp9nxSy`、`lzsmcBH`、`s3jd2Ry`、`swTtFp3`、`tQvtdnB`、`x5gr5oQ`）。

**案例 2：数据包 / 战利品表引用了当前实例中不存在的注册项（MC 1.21.1 / NeoForge，logId: fDtTF54）**

```
[10:46:22] [Worker-Main-8/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:railways:blocks/track_tfc_acacia - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: railways:track_tfc_acacia
[10:46:22] [Worker-Main-8/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:railways:blocks/track_byg_rainbow_eucalyptus_wide - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: railways:track_byg_rainbow_eucalyptus_wide
```

同一形态在另外三个模组上也命中（每份日志成百次重复，**按模组成批出现**）：

```
[10:09:41] [Worker-ResourceReload-0/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:mekenergistics:blocks/me_absolute_overclocked_pressurised_reacting_factory - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: mekenergis...
```
（logId: wwgGToj）

```
[10:16:28] [Worker-ResourceReload-14/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:create_connected:blocks/dye_depot_slate_fan_dyeing_catalyst - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: create_connected:dye_dep...
```
（logId: NeafxfU，另有 7HWhiCO、MO8SxdL、SYaRNJT、ZtdPzNE、fVwe261、fpUgC9s、gC6s9SD、jA7wUC8、
l8rKn1c、lp9nxSy、wmnTA4N、wwgGToj、x5gr5oQ 共 15 份日志）

**缺的注册项不限于物品。** 同一句报错可以指向四种注册表，左半永远是「引用方」，右半是「缺失项」：

```
[10:46:22] [Worker-Main-8/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:railways:blocks/track_tfc_acacia - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: railways:track_tfc_acacia
```
```
[10:08:48] [Render thread/ERROR]: Unknown registry key in ResourceKey[minecraft:root / minecraft:entity_type]: cataclysm:old_netherite_monstrosity
```
```
Caused by: java.lang.RuntimeException: Unknown registry key in ResourceKey[minecraft:root / minecraft:worldgen/carver]: biomesoplenty:origin_cave
Caused by: java.lang.RuntimeException: Unknown registry key in ResourceKey[minecraft:root / minecraft:worldgen/feature]: biomesoplenty:bush_tree
```
```
[10:55:57] [Render thread/WARN]: Could not decode GlobalLootModifier with json id thirst:add_loot_shipwreck_supply - error: Unknown registry key in ResourceKey[minecraft:root / forge:global_loot_modifier_serializers]: thirst:add_loot_table
```

（依次为 logId `fDtTF54`、`ZtdPzNE`、`SYaRNJT`、`fpUgC9s`——`jA7wUC8`、`l8rKn1c` 与 `fpUgC9s` 同为
`forge:global_loot_modifier_serializers`，`wmnTA4N` 则是 292 行 `minecraft:item` 的成批重复。）

四类的共同点是**引用方的 JSON 还在、被引用的注册项不在**，处理方式相同（见「修复步骤」），
判断时不必纠结缺的是物品、实体类型还是世界生成类型；反过来，如果日志里 `Unknown registry key` 的
**左半**也不认识（例如 `ResourceKey[minecraft:root / <未知前缀>]`），那才是加载器/版本层面的问题。

**案例 3：配方 JSON 引用了未安装模组的配方类型（logId: sQy3pfU）**

```
[10:07:39] [Render thread/ERROR]: Parsing error loading recipe alltheores:mek_processing/<P>/from_raw_block: com.google.gson.JsonSyntaxException: Invalid or unsupported recipe type 'mekanism:purifying'
[10:07:39] [Render thread/INFO]: Skipping loading recipe ae2cs:aggregator/meka_tool as it's serializer returned null
[10:07:39] [Render thread/ERROR]: Parsing error loading recipe alltheores:mek_processing/<P>/from_raw_ore: com.google.gson.JsonSyntaxException: Invalid or unsupported recipe type 'mekanism:enriching'
```

**案例 4：模型 JSON 用了另一个加载器平台的 loader 名（Forge 1.20.1-47.4.28，logId: 1hcrlSp）**

```
com.google.gson.JsonParseException: Model loader 'neoforge:composite' not found. Registered loaders: forge:elements, forge:obj, forge:fluid_container, forge:composite, forge:separate_transforms, forge:empty, twilightforest:castle_door, forge:item_layers, twilightforest:patch, twilightforest:force_field, twilightforest:giant_block
	at net.minecraftforge.client.model.ExtendedBlockModelDeserializer.deserializeGeometry(ExtendedBlockModelDeserializer.java:103)
```

同一份日志里被点名的模型文件：

```
[10:31:12] [Worker-Main-14] [net.minecraft.client.resources.model.ModelBakery/WARN]: Unable to load model: 'create:block/fluid_tank/block_single_window_sw' referenced from: create:fluid_tank#bottom=true,shape=plain,top=true: java.io.FileNotFoundException: create:models/<P>/block_single_window_sw.jso...
```

`neoforge:` 前缀的 loader 在另一份日志里又换成 `neoforge:obj`（logId: Be7ZQsw）：

```
com.google.gson.JsonParseException: Model loader 'neoforge:obj' not found. Registered loaders: forge:elements, forge:obj, forge:fluid_container, forge:composite, forge:separate_transforms, forge:empty, forge:item_layers
	at TRANSFORMER/forge@47.4.10/net.minecraftforge.client.model.ExtendedBlockModelDeserializer.deserializeGeometry(ExtendedBlockModelDeserializer.java:103)
```

**案例 5：模型 JSON 语法坏 / 数值越界（MC 26.2，logId: 2QjIcq5；MC 1.21.5，logId: h5FOgJh）**

```
[10:43:36] [Worker-Main-7/ERROR]: Failed to load model minecraft:models/item/item_rpo/enchanted_shield_blocking_medium_dynamic.json
com.google.gson.JsonSyntaxException: com.google.gson.stream.MalformedJsonException: Use JsonReader.setStrictness(Strictness.LENIENT) to accept malformed JSON at line 48 column 5 path $.display.thirdperson_righthand.rotation[1]
See https://<P>/Troubleshooting.md#malformed-json
	at knot//com.google.gson.internal.Streams.parse(Streams.java:60)
	at knot//com.google.gson.internal.bind.TreeTypeAdapter.read(TreeTypeAdapter.java:91)
```

```
com.google.gson.JsonParseException: Invalid rotation 25.0 found, only -45/<P>/45 allowed
	at TRANSFORMER/minecraft@1.21.5/net.minecraft.client.renderer.block.model.BlockElement$Deserializer.getAngle(BlockElement.java:94)
	at TRANSFORMER/minecraft@1.21.5/net.minecraft.client.renderer.block.model.BlockElement$Deserializer.getRotation(BlockElement.java:83)
	at TRANSFORMER/minecraft@1.21.5/net.minecraft.client.renderer.block.model.BlockElement$Deserializer.deserialize(BlockElement.java:52)
```

**案例 6：数据文件是空文件（MC 1.20.1，logId: 2i8QcZ8）**

```
[10:28:43] [Worker-Main-4/ERROR]: Couldn't parse data file epic_fight_avalon:merlin_gg from epic_fight_avalon:item_skins/merlin_gg.json
com.google.gson.JsonParseException: java.io.EOFException: End of input at line 1 column 1 path $
	at net.minecraft.util.GsonHelper.m_13780_(GsonHelper.java:526)
	at net.minecraft.util.GsonHelper.m_<N>_(GsonHelper.java:531)
	at net.minecraft.util.GsonHelper.m_13776_(GsonHelper.java:581)
```

**案例 7：配置文件字段类型变了，连备份一起坏（MC 26.3，logId: QyFukxO、lzsmcBH）**

```
[10:06:34] [Render thread] [flashback/ERROR]: Failed to load config from E:\我的世界\profiles\26.3生电优化 (1)\config\flashback\flashback.json
com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected a string but was BEGIN_ARRAY at line 134 column 30 path $.internalExport.selectedVideoEncoder
See https://<P>/Troubleshooting.md#unexpected-json-structure
	at knot//com.google.gson.internal.bind.ReflectiveTypeAdapterFactory$Adapter.read(ReflectiveTypeAdapterFactory.java:521)
	at knot//com.google.gson.internal.bind.ReflectiveTypeAdapterFactory$2.readIntoField(ReflectiveTypeAdapterFactory.java:271)
```

紧接着是同目录的备份文件（**行号与主文件不同、错误位置相同**）：

```
[10:06:34] [Render thread] [flashback/ERROR]: Failed to load config from E:\我的世界\profiles\26.3生电优化 (1)\config\flashback\.flashback.json.backup
com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected a string but was BEGIN_ARRAY at line 130 column 30 path $.internalExport.selectedVideoEncoder
```

**案例 8：配置文件不存在（首次运行的正常现象）**

```
[11:02:08] [Render thread/WARN]: Failed to read config file
java.nio.file.NoSuchFileException: /storage/emulated/0/Android/data/com.movtery.zalithlauncher.v2/files/.minecraft/versions/1.21.11 Fabric 0.20.0/config/show-durability.json
	at java.base/sun.nio.fs.UnixException.translateToIOException(Unknown Source)
	at java.base/sun.nio.fs.UnixFileSystemProvider.newByteChannel(Unknown Source)
	at java.base/java.nio.file.Files.readString(Unknown Source)
	at knot//net.thomilist.showdurability.Config.load(Config.java:33)
```
（logId: wyHd16v）

```
[10:10:31] [Render thread/ERROR]: loadFromFile(): Failed to load config file '/storage/emulated/0/FCL/.minecraft/versions/26.2-Fabric/config/malilib.json'
[10:10:31] [Render thread/ERROR]: loadFromFile(): Failed to load config file '/storage/emulated/0/FCL/.minecraft/versions/26.2-Fabric/config/tweakeroo.json'.
```
（logId: WkUMQUI，FCL；Windows 侧同形 logId: kxe20WZ，路径为 `D:\我的世界\.minecraft\versions\26.2-Fabric 0.19.5\config\malilib.json`）

**案例 9：集成服务端主线程严重落后（MC 1.16.3 / Fabric Loader 0.19.5，logId: V2EuFw8）**

```
[10:41:12] [Server thread] [net.minecraft.server.MinecraftServer/WARN]: Can't keep up! Is the server overloaded? Running 2292ms or 45 ticks behind
[10:41:34] [Server thread] [net.minecraft.server.MinecraftServer/WARN]: Can't keep up! Is the server overloaded? Running 6558ms or 131 ticks behind
[10:46:04] [Server thread] [net.minecraft.server.MinecraftServer/WARN]: Can't keep up! Is the server overloaded? Running 54007ms or 1080 ticks behind
[10:46:48] [Server thread] [net.minecraft.server.MinecraftServer/WARN]: Can't keep up! Is the server overloaded? Running 2061ms or 41 ticks behind
```

同一份日志里还有视距被强制拉回与生物群系生成的 JSON 错误：

```
Changing view distance to 2, from 10
Changing view distance to 31, from 2
[10:34:23] [main] [net.minecraft.world.biome.GenerationSettings/ERROR]: Feature: Not a JSON object: "minecraft:freeze_top_layer"
```

**案例 10：tick 时找不到模组类（MC 26.1.1，logId: QqiDYZ5）**

```
net.minecraft.ReportedException: Exception ticking world
	at TRANSFORMER/minecraft@26.1.1/net.minecraft.server.MinecraftServer.tickChildren(MinecraftServer.java:1147)
	at TRANSFORMER/minecraft@26.1.1/net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1006)
	at TRANSFORMER/minecraft@26.1.1/net.minecraft.client.server.IntegratedServer.tickServer(IntegratedServer.java:145)
	at TRANSFORMER/minecraft@26.1.1/net.minecraft.server.MinecraftServer.processPacketsAndTick(MinecraftServer.java:1038)
```

```
Caused by: java.lang.ClassNotFoundException: com.hilornair.arcanevortex.Core.CoreEntity.IsRemovedHelper
```

**案例 11：整合数据结构在 tick 中越界（Forge 1.20.1-47.3.22，logId: fpUgC9s）**

```
Description: Exception ticking world
java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 65
	at it.unimi.dsi.fastutil.objects.Object2BooleanOpenHashMap.rehash(Object2BooleanOpenHashMap.java:1304) ~[fastutil-8.5.9.jar%2386!/:?] {re:mixin}
	at it.unimi.dsi.fastutil.objects.Object2BooleanOpenHashMap.insert(Object2BooleanOpenHashMap.java:249) ~[fastutil-8.5.9.jar%2386!/:?] {re:mixin}
	at it.unimi.dsi.fastutil.objects.Object2BooleanOpenHashMap.computeIfAbsent(Object2BooleanOpenHashMap.java:448) ~[fastutil-8.5.9.jar%2386!/:?] {re:mixin}
	at com.mrcrayfish.framework.entity.sync.SyncedEntityData.hasSyncedDataKey(SyncedEntityData.java:229) ~[framework-forge-1.20.1-0.6.16.jar%23574!/:1.20.1-0.6.16] {re:classloading}
```

**案例 12：模组事件递归导致栈溢出（MC 1.20.1，logId: LtXNzHO）**

```
Description: Ticking entity
java.lang.StackOverflowError: Ticking entity
	at net.minecraft.world.entity.ai.attributes.AttributeMap.m_22181_(AttributeMap.java:75) ~[client-1.20.1-<N>.<N>-srg.jar%23155!/:?] {re:classloading}
	at sen.manaita_plus_legacy_core.util.EventUtil.getAttributeValue(EventUtil.java:45) ~[ManaitaPlus%20Legacy-2.0.4.jar%23152!/:sen] {re:classloading}
	at net.minecraft.world.entity.LivingEntity.m_21133_(LivingEntity.java) ~[client-1.20.1-<N>.<N>-srg.jar%23155!/:?] {re:mixin,pl:accesstransformer:B,pl:ManaitaPlusLegacyLaunchBeforeApplyPluginService:A,pl:ManaitaPlusLegacyLaunchPluginService:
	at sen.manaita_plus_legacy_core.util.EventUtil.getMaxHealth(EventUtil.java:98) ~[ManaitaPlus%20Legacy-2.0.4.jar%23152!/:sen] {re:classloading}
```

## 含义

**判据 1：`Pack declares support for version newer than 64` 是包元数据的强制字段缺失。**
新版（自 1.21.9 起）要求 `pack.mcmeta` 的 `pack` 段用 `min_format` / `max_format` 声明支持的格式区间；
声称支持的格式高于 64 的包**必须**同时给出这两个字段，否则元数据读取失败。
日志里有两个包装行，看哪一个就知道包是什么形态：

| 包装行 | 包的来源 | 后续行为 |
|---|---|---|
| `Error reading pack metadata, attempting fallback type` | 文件夹形式的包（`FolderRepositorySource`） | 按 fallback 类型继续加载 |
| `Failed to read pack file/<名字>.zip metadata` | zip 包 | 该包元数据不可读 |

`Overlay "..." declares support ...` 是同一判据在**附加层（overlay）**上的版本，说明坏的是包的 overlay 段。

**判据 2：`Unknown registry key in ResourceKey[minecraft:root / minecraft:item]` 是「引用了不存在的东西」。**
错误信息是一对——左边是**正在解析的条目**（`minecraft:loot_table`），右边是**找不到的注册表键**
（`minecraft:item`）。实测三个模组（`railways`、`create_connected`、`mekenergistics`）都是同一种成因：
**它们的战利品表/数据包还在，但引用的物品已不在游戏里**（对应模组缺失、被移除或被改名）。
`ResourceKey[minecraft:root / minecraft:loot_table]` 中的 `minecraft:root` 是注册表根，不是命名空间，
不要误读成「minecraft 的命名空间下缺东西」。

**判据 3：`Invalid or unsupported recipe type 'mekanism:purifying'` 是配方类型来自未安装的模组。**
`alltheores:mek_processing/...` 这些配方由 `alltheores` 提供，但类型 `mekanism:*` 属于 Mekanism。
Mekanism 不在场时，MC 无法为该类型找到序列化器，于是跳过这些配方。
紧随其后的 `Skipping loading recipe ... as it's serializer returned null` 是同一原因的另一说法。

**判据 4：模型 JSON 的报错可以分成三层，修法不同。**

| 错误文本 | 层次 | 含义 |
|---|---|---|
| `Unable to load model: 'X' referenced from: Y: java.io.FileNotFoundException: X.json` | 文件层 | JSON 文件不存在（被引用了但没打包进去）|
| `Model loader 'neoforge:composite' not found. Registered loaders: forge:elements, ...` | 序列化器层 | JSON 是合法的，但 loader 名不属于当前平台 |
| `MalformedJsonException: ... at line N column M path $.display...` | 语法层 | JSON 语法坏（`path` 直接指出坏在哪个字段）|

判据 4 的第一例里 `Registered loaders:` 列出了三十多个名字，其中**没有** `neoforge:*` 而只有 `forge:*` 与
`twilightforest:*`——这就足以确认「模组是为 NeoForge 构建的，却装在了 Forge 上」。

`Invalid rotation 25.0 found, only -45/<P>/45 allowed` 属**数值校验层**：JSON 语法与结构都对，
只是数值超出该字段允许范围（`BlockElement$Deserializer.getAngle` 直接抛出）。

**判据 5：`java.io.EOFException: End of input at line 1 column 1 path $` 是空文件。**
`line 1 column 1 path $` 表示**还没读到任何 token 就结束了**，与 `MalformedJsonException`（读到一半坏了）
是两件事。实测该文件是模组的数据文件（`epic_fight_avalon:item_skins/merlin_gg.json`），
说明是打包/解压产出的零字节文件。

**判据 6：`Expected a string but was BEGIN_ARRAY at line N column M path $.<字段路径>` 是字段类型变了。**
JSON 本身语法合法（否则会报 `MalformedJsonException`），失败原因在 `path` 里：
`$.internalExport.selectedVideoEncoder` 期望字符串，实际是数组。
案例 7 的关键在于**主文件与 `.backup` 都在同一字段上失败**（`line 134` 与 `line 130`，`column 30` 相同），
说明备份不是「坏文件的备份」，而是**同一版本写出的两份同样结构的文件**——
「从备份恢复」这条路在该案例里不通。

**判据 7：`Failed to load config from` 与 `Failed to read config file` 是两种性质。**
前者（案例 7）是**内容坏了**，会回落到默认配置且可能反复重写；
后者（案例 8）的 `java.nio.file.NoSuchFileException` 是**文件不存在**，
在模组首次运行时必然发生，属于正常现象，不要当故障。

**判据 8：`Can't keep up!` 是性能，不是崩溃；`Description:` 才是崩溃。**
`Can't keep up! Is the server overloaded? Running <毫秒>ms or <tick 数> ticks behind` 由
`net.minecraft.server.MinecraftServer/WARN` 打出，是**集成服务端**主线程落后于 20 TPS 的度量
（`Running 54007ms or 1080 ticks behind` 表示单帧卡了 54 秒）。
崩溃报告的描述字段则是另一套文本：`Description: Ticking entity`、`Description: Exception ticking world`
（1.20.1 及以下）或 `Exception ticking world`（新版）。

**判据 9：tick 崩溃的三种根因在栈里可直接区分。**

| 形态 | 判据 | 案例 |
|---|---|---|
| 类缺失 | `Caused by: java.lang.ClassNotFoundException: <模组包名>.*` | 案例 10 |
| 第三方数据结构越界 | `ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 65` 且栈里有第三方库（`com.mrcrayfish.framework.*` → `fastutil`）| 案例 11 |
| 事件递归 | `java.lang.StackOverflowError` 且栈里同一对方法互相调用（`EventUtil.getAttributeValue` ↔ `LivingEntity.getMaxHealth`）| 案例 12 |

案例 12 的因果很清楚：`ManaitaPlus` 的 `EventUtil.getMaxHealth` 调用原版
`LivingEntity.m_21133_`（读属性），而原版读属性又会触发 `AttributeMap.m_22181_` → 再次进入 `EventUtil`，
形成无限递归。这类栈溢出在日志里通常**只截取到几十帧**，但那一对反复出现的方法名就是定位依据。

## 常见触发

### 触发 A：MC 升到 1.21.9 / 26.x 后老资源包与数据包元数据失配（案例 1）

触发路径就是**升级游戏版本**：包作者仍用旧写法（只写 `pack_format`，或 `pack_format` 高于 64 却不给
`min_format`/`max_format`）。实测两份日志的 MC 版本是 26.2，加载器为 Fabric Loader 0.19.3 与 0.19.5，
说明该错误在 26.2 上仍在持续产生；20 份日志命中该签名。

注意覆盖范围：这一判据同时命中**资源包与数据包**（`FolderRepositorySource` 会扫描多个目录），
并且会命中 `Overlay` 段与 zip 包内的 `pack.mcmeta`。日志中会明确写出包名
（`Failed to read pack file/Better Fresher 3D Books v1.4.zip metadata`），据此直接定位。

### 触发 B：模组被移除/改名，但它的数据包与引用关系残留（案例 2、3）

两种情况都命中：

- 战利品表还在，物品没了 → `Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: railways:track_tfc_acacia`（15 份日志）
- 配方还在，配方类型所属模组没了 → `Invalid or unsupported recipe type 'mekanism:purifying'`（抽样中 `Parsing error loading recipe` 16 份、`Invalid or unsupported recipe type` 4 份）

判定方式：**报错里的 `<命名空间>:<路径>` 前缀就是缺东西的那个模组**。
`railways:blocks/track_tfc_acacia` 说明 `railways`（Create 的蒸汽机车附属）与 `tfc` 的兼容物品不在场；
`create_connected:*` 说明 Create Connected 的方块没注册上。

### 触发 C：模组为另一个加载器平台构建（案例 4）

`Model loader 'neoforge:composite' not found. Registered loaders: forge:elements, ...` 里的
`Registered loaders` 列表是**决定性证据**——它列出了当前平台真正注册的 loader 名。
Forge 平台不会注册 `neoforge:*`（反之亦然），因此 NeoForge 构建的模组装在 Forge 上必然如此。
实测 1hcrlSp 与 Be7ZQsw 都是 Forge 1.20.1（`forge-1.20.1-47.4.28`、`forge@47.4.10`），
被点名的是 `create` 的流体罐模型与 `gtceu`（格雷科技）的模型。

同属这一类的还有：`Model loader 'neoforge:obj' not found`（Be7ZQsw）、
`create:block/fluid_tank/...` 系列 `Unable to load model ... java.io.FileNotFoundException`（Be7ZQsw、bRQI5Iw、dG1jEiO）。

### 触发 D：模组升级后配置文件字段类型变化（案例 7）

`Expected a string but was BEGIN_ARRAY at line 134 column 30 path $.internalExport.selectedVideoEncoder`
里的 `path` 就是那个改过类型的字段。**两个实测实例（QyFukxO、lzsmcBH）来自同一份存档路径**
（`profiles\26.3生电优化 (1)\config\flashback\`），说明这是特定版本升级导致的字段迁移，
不是随机损坏。案例 7 的备份文件同样失败这一点很重要：
`.flashback.json.backup` 报 `line 130 column 30`，**同一 column、同一 path**。

### 触发 E：集成服务端卡顿与 tick 崩溃（案例 9、10、11、12）

移动端全是**集成服务端**（IntegratedServer）。实测三类：

- 性能落后：`Can't keep up!` 在抽样中命中数十份日志（每轮三十份上下），最大值 `Running 54007ms or 1080 ticks behind`
- tick 时类缺失：`Exception ticking world` + `ClassNotFoundException: com.hilornair.arcanevortex.Core.CoreEntity.IsRemovedHelper`（QqiDYZ5）
- tick 时数据结构越界：`Index -1 out of bounds for length 65`（fpUgC9s）
- tick 时事件递归：`StackOverflowError: Ticking entity`（LtXNzHO）

`Changing view distance to 2, from 10` / `Changing view distance to 31, from 2` 这类行是
服务端按负载调整视距的**正常输出**，与 `Can't keep up!` 同时出现时说明系统正在自我保护，
仍应结合 tick 落后量判断严重程度。

### 触发 F：数据包/世界生成 JSON 结构不符（案例 9 后半）

`Feature: Not a JSON object: "minecraft:freeze_top_layer"`（抽样中多份日志）表示
`GenerationSettings`（生物群系生成设置）在解析某个 feature 时，期望一个 JSON 对象却拿到了字符串。
这是**数据包/世界生成 JSON 的结构问题**，与案例 2 的「键不存在」不同——键的写法本身不被接受。

## 修复步骤

**触发 A（包元数据缺 min_format / max_format）**

1. 从 `Failed to read pack file/<名字>.zip metadata` 里抄出**具体是哪个包**；没有这一行时它是文件夹形式的包，去 `resourcepacks/`、`datapacks/` 逐个试
2. 打开该包的 `pack.mcmeta`，在 `pack` 段补上 `min_format` 与 `max_format`（两者都填该包声明的格式号）
3. 包是 `Overlay` 报错（`Overlay "1.21.6" declares support ...`）时，要改的是**overlay 段**，不是最外层
4. 包作者未更新时，直接**在资源包列表里停用该包**——它是 WARN，停用即可继续游戏
5. 这类包在列表里可能看起来是「启用但无效」，不要反复重启游戏

**触发 B（注册表引用失效）**

1. 从 `Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: <命名空间>:<路径>` 里读出**命名空间**
2. 若该命名空间对应的模组**已卸载**：装回该模组，或一并停用它的数据包（战利品表/配方）
3. 若模组**在位但改名**：升级到改名后的新版本，旧数据包不要与新版混用
4. `Invalid or unsupported recipe type '<模组>:<类型>'` 同理：装回类型所属的模组，或停用提供方模组
5. 这类错误是 ERROR 级但**通常不阻断启动**，表现为「某些物品没有掉落物/某些配方不存在」，按上面的命名空间定位即可

**触发 C（加载器平台不符的模型）**

1. 读 `Registered loaders:` 列表，确认当前平台**没有**报错里那个前缀
2. 把报错里的 loader 前缀（`neoforge:` / `forge:`）与当前加载器（`net.minecraftforge.fml...` 出现即为 Forge）对比
3. 到该模组的发布页选择**与当前加载器同名**的构建（Forge 版 / NeoForge 版是两份独立发布物）
4. 这类错误表现为模型缺失或渲染异常，不一定会崩；同一模组的所有模型都要一起换

**触发 D（配置文件字段类型变化）**

1. 从 `path $.` 后面抄出字段名（案例 7 为 `internalExport.selectedVideoEncoder`）
2. 打开该配置文件，把该字段改成**报错文本里期望的类型**（`Expected a string` 就改成字符串）
3. **不要盲目用 `.backup` 覆盖**：案例 7 的两份文件在同一 `path`、同一 `column` 上失败，备份不是干净副本
4. 该字段属于最近升级的模组时，先看该模组发布说明里有没有「配置迁移」条目；没有就直接删除该配置文件让它重建为默认值
5. 若字段值本身是用户在游戏内改的（如导出编码器选择），重建后**改回可用的旧取值**即可

**触发 E（集成服务端 tick）**

1. 先分清是性能还是崩溃：只有 `Can't keep up!` 无 `Description:` → 按性能处理；有 `Description:` → 按崩溃处理
2. 性能：降视距/模拟距离、降实体密度、减少实体 AI 类模组；`Running <毫秒>ms` 的数值越大越接近不可玩
3. 崩溃且 `Caused by: ClassNotFoundException: <包名>.*` → 装回该模组（案例 10 的 `com.hilornair.arcanevortex.*`）
4. 崩溃且栈里有第三方 + `fastutil` 的 `Object2BooleanOpenHashMap`（案例 11）→ 更新那个第三方框架模组；该栈是它的同步数据结构在实体 tick 时被写入而越界
5. 崩溃且 `java.lang.StackOverflowError`（案例 12）→ 报告中给出的那一对互相调用的方法即为递归环，禁用其中**非原版**的那一方（案例 12 为 `ManaitaPlus`）

**触发 F（世界生成 JSON 结构）**

1. 从 `Feature: Not a JSON object: "<ID>"` 里读出那个 ID
2. 到提供该 feature 的数据包里，把该处写成**对象**而不是字符串
3. 找不到提供方时，停用最近添加的世界生成类数据包，逐个二分定位

## 置信度线索

> **份数的读法**：本文所有「份数」都是**抽样观测值**，不是全库比例。观测方式为取生产库最近上传的
> 700 条记录（去重后 685 份日志，2026-10）。同一签名在批次间可有数倍波动（`Unknown registry key`
> 一批 15 份、另一批 10 份；`Can't keep up!` 一批 39 份、另一批 28 份），因为日志的模组构成随流量变化。
> 判据一律用**签名本身**，份数只作量级参考。

- **确定（包格式声明不足）**：`Pack declares support for version newer than <数字>, but is missing mandatory fields min_format and max_format`，或它的 `Overlay "<范围>" declares support for version newer than ...` 变体
- **确定（包装形态）**：`Error reading pack metadata, attempting fallback type` → 文件夹包；`Failed to read pack file/<名>.zip metadata` → zip 包
- **确定（注册表引用失效）**：`Unknown registry key in ResourceKey[minecraft:root / <类型>]:<ID>`。冒号前是缺东西的模组命名空间
- **确定（配方类型缺失）**：`Invalid or unsupported recipe type '<模组>:<类型>'`，或被跳过的配方出现 `as it's serializer returned null`
- **确定（加载器平台不符）**：`Model loader '<前缀>:<名>' not found. Registered loaders: ...`，且 `Registered loaders` 里没有该前缀。这是唯一能证明平台错配的一行
- **确定（JSON 空文件）**：`java.io.EOFException: End of input at line 1 column 1 path $`
- **确定（JSON 语法坏）**：`MalformedJsonException` + `path $.<字段>`；`Use JsonReader.setStrictness(Strictness.LENIENT)` 是 Gson 的固定文案，**不要**据此去改模组代码
- **确定（JSON 类型变）**：`Expected a <类型> but was BEGIN_<类型> at line N column M path $.<字段>`，语法合法、字段类型不符
- **确定（模型文件缺失）**：`Unable to load model: '<ID>' referenced from: <引用方>: java.io.FileNotFoundException: <ID>.json`
- **确定（配置内容坏）**：`Failed to load config from <绝对路径>` + Gson 异常。此处路径往往是 Windows 盘符路径（`E:\`、`D:\`），在移动端日志里出现不代表运行在 Windows
- **确定（配置不存在 ≠ 坏）**：`java.nio.file.NoSuchFileException: .../config/<名>.json` 或 `loadFromFile(): Failed to load config file '...'` 在模组首次运行时必然出现
- **确定（tick 崩溃）**：崩溃报告里有 `Description: Ticking entity` / `Description: Exception ticking world`（1.20.1 及以下）或 `Exception ticking world`（新版）
- **需区分（性能 ≠ 崩溃）**：`Can't keep up! Is the server overloaded? Running <毫秒>ms or <tick 数> ticks behind` 是 WARN 级度量，本身不导致崩溃
- **需排除（告警，不是根因）**：`options.txt already exists - last modified <N>`（`[defaultoptions/]` 打出，抽样中数份）、`Target config options.txt already exists, skipping copy` / `Restored options.txt from backup`（logId: OiI9PYp），都是配置初始化行为
- **重要边界（存档损坏在移动端几乎不存在）**：两轮抽样（各约 700 份）中 `Chunk file at` 0 份、`chunk file` 0 份、`Failed to load world` 0 份、`Exception loading world` 0 份；`session.lock` 只命中 1 份，且是正常输出（`[YOSBR/INFO]: Applying default options for \saves\Tutorial World v4\session.lock from \config\yosbr\saves\Tutorial World v4\session.lock`，logId: 3un0RMV——模组在备份/写入默认存档配置）；`level.dat` 命中 2 份（`NHF2vl7`、`dO7z1zH` 的 `java.io.FileNotFoundException: level.dat (No such file or directory)`），且两份的栈都来自 `com.mojang.rubydung.level.Level.load`——那是旧原型占位实现，**不是存档损坏**。真正出现「region」字样的 3 份全是正常输出（`PlanetSeeder ... seeded 12 new region file(s)`、`region cache preloaded 16384 chunks from 16 region files ... (missing=0, failed=0)`、`RegionFileStorage` 的正常栈帧）。**不要把「区块/存档损坏」当作移动端日志的常见解释**；先按本条的四类失效面排查
- **重要边界（端口占用在移动端样本中为 0）**：`Address already in use` / `EADDRINUSE` / `Failed to bind` 三者在两轮抽样中均为 0 份；出现「dedicated server」字样的 4 份也与开服无关（模组提示或 `Skipped <模组> bootstrapping because: on dedicated server`）。移动端样本全部是集成服务端，**专用服务端的端口/绑定类故障不在本条的适用范围内**，遇到时应转向 `server/server-issues.md`
- **需追问**：日志未标 MC 版本时向用户确认。`Loading Minecraft X with Fabric Loader Y`（Fabric）、`Minecraft Info: X, <加载器> - <版本>`（ZalithLauncher）、`forge-1.20.1-<版本>-universal.jar` / `TRANSFORMER/minecraft@<版本>`（Forge 系）均可提供依据
