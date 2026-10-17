# 数据包 / 世界加载失败（注册表不匹配、数据包版本过新、加载拦截）

## 签名 (Signature)

**世界加载被拦截（MC 官方界面文案，最明确的判据）**

```
Errors in currently selected datapacks prevented the world from loading.
You can either try to load it with only the vanilla data pack ("safe mode"), or go back to the title screen and fix it manually.
Failed to load world
Failed to load world in Safe Mode. This world contains invalid or corrupted save data.
```

这三句是**界面文案**（弹窗中显示），只有极少数启动器会把它们转发到日志文件。598 份生产日志的实测结果是：这三句**全部为 0 命中**，真正的日志侧线索是下面那组注册表报错。因此判断本类故障时，应以注册表报错为准，而非依赖界面文案。

**注册表加载错误汇总段（服务端与客户端通用，实测存在）**

```
[main/ERROR] [minecraft/RegistryDataLoader]: Registry loading errors:
> Errors in registry minecraft:enchantment:
	java.lang.IllegalStateException: Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: <命名空间>:<条目ID>
```

**单个数据项引用了不存在的物品 / 方块（实测最高频的形态）**

```
[Worker-ResourceReload-1/ERROR]: Couldn't parse data file 'kaleidoscope_nether:blocks/doll_0' from 'kaleidoscope_nether:loot_table/blocks/doll_0.json': DataResult.Error['Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: kaleidoscope_nether:doll_0': net.minecraft.loot.LootTable@32424c4a]
[Worker-ResourceReload-5/ERROR]: Couldn't parse element minecraft:loot_table/rctmod:generic/epic/kanto_badge_3 - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: cobblemonpokemonbadges:thunder_badge
[Worker-ResourceReload-4/ERROR] [minecraft/LootDataType]: Couldn't parse element ResourceKey[minecraft:root / minecraft:loot_table]:railways:blocks/track_tfc_acacia - Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: railways:track_tfc_acacia
```

**配方 / 进度表引用了不存在的物品**

```
[Render thread/ERROR]: Parsing error loading recipe irons_spellbooks:curios/concentration_amulet: com.google.gson.JsonSyntaxException: Unknown item 'irons_spellbooks:mithril_ingot'
[Render thread/ERROR]: Parsing error loading recipe s_a_b:glassarmor
com.google.gson.JsonParseException: Unknown registry key in ResourceKey[minecraft:root / minecraft:item]: s_a_b:deleted_mod_element
[Render thread/ERROR]: Parsing error loading recipe lilis_lucky_lures:fish_trap/triggerfish
com.google.gson.JsonSyntaxException: Invalid or unsupported recipe type 'lilis_lucky_lures:fish_trap'
```

`deleted_mod_element` 是模组被删除后 MC 留存的占位 ID，出现它**直接证明**有模组被移除。

**标签缺失（数据包引用别的模组未提供的标签）**

```
DataResult.Error['Missing tag: 'storagedrawers:drawers' in 'minecraft:block'']
DataResult.Error['Failed to parse either. First: Not a tag id; Second: Failed to parse either. First: Not a json array: "mekanism:creative_bin"; Second: Failed to get element mekanism:creative_bin']
```

**存档中的实体已无对应注册项 / 存档级数据引用了已移除的注册项**

```
[Server thread/WARN]: Skipping Entity with id guardvillagers:guard
[Server thread/WARN]: Skipping Entity with id smallships:brigg
[Server thread/WARN]: Skipping Entity with id irons_spellbooks:priest
[Render thread] [net.minecraft.world.level.storage.SavedDataStorage/ERROR]: Failed to parse saved data for 'SavedDataType[minecraft:game_rules]': Unknown registry key in ResourceKey[minecraft:root / minecraft:game_rule]: jade:max_position_deviation
```

**注册项重复 / 世界生成数据与当前注册表集合不符**

```
[Render thread/ERROR]: Adding duplicate key 'ResourceKey[minecraft:worldgen/biome / galosphere:lichen_caves]' to registry
[Server thread/ERROR]: Element Reference{ResourceKey[minecraft:worldgen/processor_list / minecraft:empty]=ProcessorList[[]]} is not valid in current registry set
java.lang.IllegalStateException: Failed to parse quark:worldgen/placed_feature/glow_shrooms_extra.json from pack Quark-1.20-4.x.jar
```

**pack 元数据版本声明过新 / 缺字段 / JSON 损坏**

```
[Render thread/ERROR]: Couldn't load file/[资源]高贵的女孩包SGWPumpkinTexture.zip pack metadata: Pack declares support for version newer than 64, but is missing mandatory fields min_format and max_format
[Render thread/ERROR]: Couldn't load creativecore pack metadata: Pack declares support for format 50, but game versions supporting formats 17 to 64 require a supported_formats field. Add "supported_formats": [50, 64] or require a version greater or equal to 65.0.
[Render thread/ERROR]: Couldn't load mru pack metadata: com.google.gson.stream.MalformedJsonException: Use JsonReader.setStrictness(Strictness.LENIENT) to accept malformed JSON at line 4 column 24 path $.pack.pack_format
[Render thread/WARN]: Missing metadata in pack mru
[Render thread/WARN]: Error reading pack metadata, attempting fallback type
com.google.gson.JsonParseException: Multi-version packs cannot support minimum version of less than 15, since this will leave versions in range unable to load pack.
```

**数据包内的非法路径被跳过（大小写、空格、中文目录名）**

```
[Worker-Main-2/WARN]: Invalid path in datapack: suffuse:tacz_sounds/shared/magpouch (1).ogg, ignoring
[Worker-Main-7/WARN] [net.minecraft.server.packs.FilePackResources]: Invalid path in datapack: minecraft:textures/item/firerock/rainbow rocket base.png, ignoring
[Worker-ResourceReload-5/WARN]: Invalid path in datapack: needsofnature:geckolib/animations/afw/wolfmplayer-knot2/Nueva carpeta/wolfmplayer-knot2.p4_wolf.animation.json, ignoring
[Render thread/WARN]: Ignored non-lowercase namespace: ACelticTale.mp3 in java.util.zip.ZipFile@76f099c0
```

**数据包函数缺失 / 运行时动态数据包（后者为模组正常注入，非错误）**

```
[Worker-Main-3/ERROR]: Failed to load function kaleidoscope:cookery/stove/fry/out/meal
[Render thread/INFO] [minecraft/MinecraftServer]: Found new data pack create:dynamic_data, loading it automatically
[Render thread/INFO]: Found new data pack fabric, loading it automatically
```

## 含义

Minecraft 的世界数据由**注册表（Registry）**驱动：物品、方块、实体类型、维度、生物群系、配方、进度、战利品表、全局掉落修饰器都以「命名空间:路径」的 ID 注册进全局注册表，数据包与模组都是注册项的提供方。世界加载时会依次做三件事：

1. 扫描所有数据包与模组提供的注册项，建立注册表
2. 解析数据包 JSON，把其中引用的 ID 解析成注册表条目
3. 用注册表反序列化存档（`level.dat`、区块、实体、玩家数据）

**任一环节解析失败都会被记录**，但后果不同：注册表与存档层面的失败会让 MC 拒绝加载（主动拦截，不是崩溃——进程仍在运行，弹出选择界面），而数据包内容层面的失败只丢弃单个数据项。这就是「Errors in currently selected datapacks prevented the world from loading.」的来由。

失败分成性质完全不同的两类：

| 类别 | 触发点 | 后果 | 典型签名 |
|---|---|---|---|
| **数据包内容错误** | 第 2 步 | 单个数据项被丢弃，世界通常仍可加载 | `Couldn't parse data file` / `Couldn't parse element` / `Parsing error loading recipe` |
| **存档 ↔ 注册表不匹配** | 第 3 步 | 世界被拦截，无法进入 | `prevented the world from loading` / `Registry loading errors` / `Skipping Entity with id` / `Missing dimension` |

第一类**极为常见且绝大多数无害**：整合包里某个模组的战利品表引用了另一个未安装模组的物品，MC 打印一条 `Couldn't parse data file` 然后跳过该战利品表。实测 `Unknown registry key in ResourceKey[minecraft:root / minecraft:item]` 是最高频的注册表报错（单次抽样 62 条），且大量出现在正常运行的游戏里。

第二类才是真正打不开世界的原因。判断方式：世界是否**在选档界面就被拒绝**。若游戏能进到标题界面、单个数据项报错刷屏但世界能开，属第一类。

另一组容易混淆的概念是 **pack 元数据版本号**：`pack.mcmeta` 里的 `pack_format` 是**格式号**，资源包与数据包共用这一份元数据结构但数值不同（例如 1.21.8 的资源包格式为 64、数据包格式为 81），与 MC 版本号不是同一套数字，且随版本单调递增。格式号高于当前游戏支持的上界时 MC 拒绝加载该包——这可能来自**整合包升级后包没跟着升**，也可能来自**把更高版本的包装进低版本环境**。1.21.9 起改用 `min_format` / `max_format` 区间字段，因此只写旧式 `pack_format` 的高版本包会被判为「声明支持比 64 更新的版本但缺少必填字段」。

**这条判据在实测中最容易被忽略的一点**：这类报错的包名经常是**模组内嵌的包**而非用户手动放入的包（实测如 `armor_3d`、`creativecore`、`mru`、`[资源]高贵的女孩包SGWPumpkinTexture.zip`），因此**只移除用户自己的资源包并不能解决**，须更新对应模组或资源包本身。

## 常见触发

### 触发 A：移除了内容型模组后打开旧存档

提供物品、方块、维度的模组被删，存档里的战利品表、配方、实体、方块实体、存档数据仍引用那些 ID。

典型特征：`Unknown registry key ... <该模组的命名空间>`、`Skipping Entity with id <该模组的实体>`、`deleted_mod_element` 出现在报错 ID 中。

实测实例：`yyzsbackpack`（背包）、`guardvillagers`（卫兵实体）、`kaleidoscope_nether`（内容模组）被移除后，分别产生方块实体缺失、实体被跳过、战利品表解析失败三类报错。

### 触发 B：高版本存档降级到低版本打开

新版 MC 的注册表结构、维度格式、区块调色板格式在旧版无法解析。这是**不可逆**操作——旧版打开后会按自己的规则重写数据。

典型特征：加载时批量报注册表错误与区块错误，且报错量随存档规模线性增长。

### 触发 C：pack 元数据版本格式不匹配

整合包升级、包从高版本搬运到低版本，或包作者用旧格式书写。

典型特征：`Pack declares support for version newer than <N>, but is missing mandatory fields min_format and max_format`、`Pack declares support for format <N>, but game versions supporting formats 17 to 64 require a supported_formats field`、`Multi-version packs cannot support minimum version of less than 15`。

实测占比 3.3%，且报错包名多为模组内嵌包或用户资源包。

### 触发 D：两个数据包注册同一 ID

整合包自带的数据包与手动放入的数据包、或两个模组各自携带的数据包注册了相同的生物群系 / 结构 / 处理器列表 ID。

典型特征：`Adding duplicate key 'ResourceKey[...]' to registry`、`Element Reference{...} is not valid in current registry set`。

### 触发 E：数据包为另一个模组编写但该模组未安装

数据包 JSON 里引用了目标模组的物品或标签，目标模组不在。

典型特征：`Missing tag: '<标签>' in 'minecraft:item'`、`Failed to get element <ID>`、`Unknown item '<ID>'`。

这是**最常见的一类低频噪音**：报错量大但不影响进入世界。

### 触发 F：数据包内路径非法被跳过 / 服务端缺少自定义维度

数据包内文件名含空格、大写字母、中文目录名，或命名空间未小写时，MC 严格校验资源路径规范，不合规的条目被逐条忽略：`Invalid path in datapack: <命名空间>:<路径>, ignoring`、`Ignored non-lowercase namespace`。实测 `minecraft:textures/item/firerock/rainbow rocket base.png`（含空格）、`Nueva carpeta`（含空格目录）、`ACelticTale.mp3`（大写）都触发此类。

另一类是同族但更严重的情形：存档引用的自定义维度在服务端注册表中不存在（客户端装了该模组而服务端没装，或服务端配置被改动），报 `Missing dimension in a Minecraft server`。**只在服务端出现**，单机不因它拒绝加载。

## 修复步骤

**触发 A（模组被移除）**

1. **最直接的解法是把被移除的模组装回去**，其余手段都可能有数据损失。
2. 在加载失败界面选择**安全模式**（只加载原版数据包）先进入世界，进去后立刻把整个存档目录完整备份。
3. 装不回时（作者删库、版本不适配），用 NBT 编辑工具手工清理存档中引用已移除内容的条目；工作量与存档规模成正比。
4. `Skipping Entity with id <ID>` 是可容忍的——这些实体会在世界中被丢弃，但要提醒用户**这些实体已无法恢复**。
5. 若只是想让世界能开、不在意残留报错，安全模式进一次再正常进通常即可绕过拦截。

**触发 B（降级打开）**

1. **禁止用低版本 MC 打开高版本存档**，这会造成不可逆的区块与注册表重写。
2. 必须先整目录备份再尝试。
3. 确认存档的目标版本：查看 `level.dat` 中的 `DataVersion` 字段。
4. 只能升级打开，不能降级打开；确需降级须用专门的降级工具，不能直接开档。

**触发 C（pack 元数据版本格式）**

1. 从报错读出包名（`Couldn't load <包名> pack metadata:` 中的 `<包名>`）与要求格式号。
2. 该包是手动放入的资源包时，更新到与当前 MC 版本匹配的发布版本（作者通常在 `pack.mcmeta` 中同步维护格式号）。
3. 包为自建或已停更时，手工改 `pack.mcmeta`：把 `pack_format` 改为当前游戏支持的格式号；1.21.9 起改用 `min_format` / `max_format` 区间字段。
4. 包名看不出是用户资源包时（形如 `creativecore`、`armor_3d`、`mru`），它是**模组内嵌的包**，需要更新对应模组，改用户自己的资源包无效。
5. 只是警告（`Error reading pack metadata, attempting fallback type`）时 MC 会自行回退，可暂不处理。

**触发 D（重复注册）**

1. 从 `Adding duplicate key 'ResourceKey[...]'` 读出重复的 ID 与注册表类型（如 `minecraft:worldgen/biome`）。
2. 找出同时提供该 ID 的两个来源：整合包自带数据包与手动放入的数据包并存是最常见组合。
3. 删除其中一个数据包；无法确认来源时，先移出手动放入的那个再验证。

**触发 E（数据包依赖的模组缺失）**

1. 从 `Missing tag:` / `Failed to get element` / `Unknown item` 读出缺失 ID 的命名空间。
2. 该命名空间对应的模组安装即解决；不需要该功能时，直接忽略这类报错——它们不影响游戏运行。

**触发 F（路径非法 / 缺少维度）**

1. 从 `Invalid path in datapack:` 读出违规路径，定位到数据包内的文件；把文件名与目录名改为全小写、无空格、无中文。条目被忽略只影响该单个资源，通常无需紧急处理。
2. `Missing dimension in a Minecraft server` 时确认该自定义维度由哪个模组提供，服务端补装该模组，或从 `level.dat` 中清除该维度引用（需先备份）。
3. 客户端装了、服务端没装时，把两侧模组列表对齐。

## 置信度线索

- **确定（世界被拦截，需向用户确认）**：用户报告界面出现 `Errors in currently selected datapacks prevented the world from loading.` —— 这是 MC 主动拒绝加载，不是崩溃。**但该文案极少进入日志文件**（实测 598 份日志 0 命中），只能由用户反馈获得，日志侧应改用下一条判据。
- **确定（注册表层面，实测判据）**：`Registry loading errors:` 后附 `Unknown registry key in ResourceKey[minecraft:root / <注册表>]` 明细段；或单条 `Unknown registry key in ResourceKey[...]` 成规模出现（实测占比 3.0%，为本类在日志中的主要形态）。
- **确定（模组被移除）**：报错 ID 中出现 `deleted_mod_element`，或 `Skipping Entity with id <命名空间>:<实体>` 的命名空间在模组列表中不存在。
- **确定（数据包版本过新）**：`Pack declares support for version newer than` / `require a supported_formats field` / `Multi-version packs cannot support minimum version`。
- **较确定（数据项被丢弃，不致命）**：只有 `Couldn't parse data file` / `Couldn't parse element`（实测占比 4.3%）或 `Parsing error loading recipe`（3.3%）而无 `Registry loading errors` 段落 —— 属单个数据项被跳过，世界仍可加载，**不应作为打不开世界的原因**。
- **较确定（重复注册）**：`Adding duplicate key 'ResourceKey[...]' to registry`，方括号内给出重复 ID 与注册表类型。
- **需区分（客户端 / 服务端）**：`Missing dimension in a Minecraft server` 只在服务端出现；`Skipping Entity with id` 在两侧都可能出现但影响不同。判断时要确认运行环境。
- **易误判（噪音）**：`Invalid path in datapack`（实测占比 6.6%）与 `Found new data pack ..., loading it automatically` 中前者是被跳过的资源、后者是模组正常注入的动态数据包，两者都不是故障。
- **需追问**：判断是否属于「模组被移除」必须知道用户最近改动了什么——日志本身无法证明某个 ID 是被移除的，只能证明它当前不存在。应向用户确认是否删除过模组、是否用过低版本打开过该存档。
