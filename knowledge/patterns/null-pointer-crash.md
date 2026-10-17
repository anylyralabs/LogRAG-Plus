# 空指针崩溃（NullPointerException 在 Minecraft 崩溃报告中的判读）

## 签名 (Signature)

**带「因为什么为空」信息的 NPE（Java 14+ 帮助性消息，MC 1.17 起普遍可见）**

```
java.lang.NullPointerException: Cannot invoke "java.util.List.add(Object)" because "list" is null
java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "this.indexedMods" is null
java.lang.NullPointerException: Cannot invoke "java.util.ArrayList.iterator()" because "categories" is null
java.lang.NullPointerException: Cannot read field "connection" because "this.minecraft.player" is null
java.lang.NullPointerException: Cannot invoke "net.minecraft.core.HolderGetter$Provider.lookupOrThrow(net.minecraft.resources.ResourceKey)" because "provider" is null
java.lang.NullPointerException: Cannot invoke "net.caffeinemc.mods.sodium.client.render.chunk.region.RenderRegion$DeviceResources.getGeometryBuffer()" because the return value of "net.caffeinemc.mods.sodium.client.render.chunk.region.RenderRegion.getResources()" is null
java.lang.NullPointerException: Cannot invoke "net.fabricmc.fabric.api.renderer.v1.Renderer.meshBuilder()" because the return value of "net.fabricmc.fabric.api.renderer.v1.RendererAccess.getRenderer()" is null
```

**注册表条目缺失引发的 NPE（Forge / NeoForge 的固定句式，信息量大）**

```
java.lang.NullPointerException: Registry entry not present: create:schematic_and_quill
java.lang.NullPointerException: Registry Object not present: yyzsbackpack:iron_backpack
java.lang.NullPointerException: Mod with id iris not found in ModList
```

**MC 自己抛出的具名 NPE（消息本身就是根因）**

```
java.lang.NullPointerException: Block models not yet initialized
	at net.minecraft.client.resources.model.ModelManager.getBlockStateModelSet(ModelManager.java)
```

**旧版 / 无帮助信息的裸 NPE（1.16 及更早，或字节码未更新）**

```
java.lang.NullPointerException
	at net.minecraft.launchwrapper.LaunchClassLoader.findClass(LaunchClassLoader.java:182)
Caused by: java.lang.NullPointerException
	at org.spongepowered.asm.mixin.transformer.MixinInfo$SubType$Standard.validate(MixinInfo.java)
```

**崩溃报告的 `Server brand` 字段被 NPE 污染（客户端整合服特有，易被误当根因）**

```
	Level time: 0 game time, 0 day time
	Server brand: ~~ERROR~~ NullPointerException: Cannot read field "connection" because "this.minecraft.player" is null
	Server type: Integrated singleplayer server
```

**LWJGL 图标设置期的 NPE（噪音，非故障）**

```
[Client thread/INFO]: [org.lwjgl.opengl.Display:setIcon:951]: java.lang.NullPointerException
[Client thread/INFO]: [org.lwjgl.opengl.Display:setIcon:950]: 	at org.lwjgl.system.Pointer$Default.<init>(Pointer.java:58)
```

**调试期类加载记录（不是异常，只是 JVM 加载了该异常类）**

```
Event: 0.034 Loading class java/lang/NullPointerException
Event: 0.034 Loading class java/lang/NullPointerException done
```

## 含义

NPE 的含义只有一句：**代码对一个 `null` 引用做了「解引用」操作**。它本身**几乎从不说明根因**——`null` 只表明某个对象在那一刻不存在，至于它为什么不存在，必须由**堆栈**与 **`Caused by:` 链**给出。

Java 14 起 JVM 会在消息里补全「哪个表达式为 null」，这让判读效率大幅提升，但要理解它的两段结构：

```
Cannot invoke "java.util.List.add(Object)" because "list" is null
└──────── 被调用的方法 ────────┘         └─ 为 null 的那个引用 ─┘
```

`because` 后面是**空引用名**，这段名字常常直接暴露根因类型：

| `because` 内容 | 含义 | 排查方向 |
|---|---|---|
| `this.minecraft.player` / `this.level` | MC 客户端状态尚未就绪 | 时序问题：代码在错误的生命周期阶段访问 |
| `this.indexedMods` / `this.modList` | 加载器内部状态未初始化 | 加载器/模组列表相关；跨加载器环境常见 |
| `list` / `categories` / `provider` | 模组自己的容器未填充 | 该模组的配置、数据文件、依赖注入缺失 |
| `return value of X.getY()` | **被调用方返回了 null** | 责任在 `X`，不在当前帧 |

最后一行是关键判据：`because the return value of "..." is null` 说明**当前帧不是肇事者**，肇事者是括号里那个方法。

**判断 NPE 是否致命，看崩溃报告的 `Description` 行。** 同一个 NPE 出现在不同阶段，含义完全不同：

| `Description` | NPE 发生的阶段 | 典型含义 |
|---|---|---|
| `Initializing game` | 游戏初始化期 | 注册表未就绪、模组在资源加载前访问注册项、配置缺失 |
| `Unexpected error` | 渲染线程任意时刻 | 需看栈顶，多为模组代码对运行期状态的假设失效 |
| `Ticking entity` / `Ticking block entity` | 实体 tick | 存档数据缺失字段（见「实体 / 方块实体 tick 崩溃」） |
| `Rendering entity in world` / `Render Frame` | 渲染期 | 渲染器 / 模组对 GPU 资源的假设失效 |
| `Mod 'X' failed while registering config options.` | 模组配置注册 | 配置框架与被注册模组版本错配 |
| `Exception in server tick loop` | 服务端 tick 循环 | 服务端世界状态问题，非单个实体 |
| `Ticking screen` / `mouseClicked event handler` | GUI 交互 | GUI 状态问题，多数可关闭界面绕过 |

**日志中出现的 NPE 与「崩溃的 NPE」必须分开看。** 大量 NPE 只在日志里留一段栈而无对应崩溃报告，此时它是**被模组 `catch` 掉的局部故障**：功能缺失、界面元素消失、某个数据项加载失败，但游戏继续运行。这类不应作为根因。

## 常见触发

### 触发 A：注册表条目缺失（内容型模组被移除，或注册未完成）

模组持有对某个注册项的引用，实际运行时该注册项不存在。Forge / NeoForge 的 `RegistryObject.get()` / `RegistryEntry.get()` 在条目缺失时抛具名 NPE。

典型特征：`Registry Object not present: <命名空间>:<条目>`、`Registry entry not present: <命名空间>:<条目>`、`Mod with id <ID> not found in ModList`。

实测实例：`yyzsbackpack:iron_backpack` 缺失导致 `Initializing game` 阶段崩溃（物品染色表注册时找不到该物品）；`create:schematic_and_quill` 缺失导致客户端 tick 期每 tick 抛一次 NPE。

### 触发 B：某对象的提供方返回 null（责任在返回方）

`because the return value of "X.getY()" is null` 明确指向 `X`。通常是该模组的初始化未完成，或它依赖的前置模组未加载。

实测实例：`RendererAccess.getRenderer()` 返回 null（Fabric 渲染 API 未初始化）；`RenderRegion.getResources()` 返回 null（Sodium 区块区域未就绪）。

### 触发 C：加载时序错误（client / server 状态未就绪）

模组代码在资源加载、玩家登录、世界加载等事件之前访问了尚未初始化的对象。

典型特征：`because "this.minecraft.player" is null`、`this.minecraft.level is null`、`Block models not yet initialized`。

`Server brand: ~~ERROR~~ NullPointerException: ...` 属此类：崩溃报告在构造期间尝试读取服务器品牌，此时客户端状态已失效，于是这个字段本身被 NPE 覆盖。**它不是根因**，只是崩溃发生得太早或太晚的痕迹。

### 触发 D：模组自身的配置 / 数据文件缺失

模组的容器字段未被数据文件填充，构造器拿到 `null`。

典型特征：`because "list" is null`、`because "categories" is null`、`because "this.xxx" is null`，栈顶帧落在该模组的类中，且深度很浅（构造器或首次初始化）。

实测实例：`emojiful` 的自定义表情容器 `categories` 为 null（资源包未提供表情定义）；`enigmaticlegacy` 的酿造配方列表为 null。

### 触发 E：存档数据与当前模组不匹配

存档中的实体 / 方块实体 / 玩家数据缺少当前代码期望的字段（模组被移除或结构变更）。

典型特征：`Description: Ticking entity` 或 `Ticking block entity`，栈顶落在实体类中。

### 触发 F：跨加载器环境（Fabric 模组跑在 Forge 上）

经 Sinytra Connector 运行时，加载器的内部状态结构与 Fabric 侧假设不一致。

典型特征：`because "this.indexedMods" is null`（Forge 的 `ModList` 内部映射未填充），日志含 `SINYTRA CONNECTOR IS PRESENT!` 提示段。此时崩溃报告常带 `Failed to get system info for Mod List`。

## 修复步骤

**触发 A（注册表条目缺失）**

1. 从业已具名的消息读出缺失条目，如 `Registry Object not present: yyzsbackpack:iron_backpack` 中的 `yyzsbackpack`。
2. `yyzsbackpack` 在 `mods/` 中不存在 → 装回该模组；存在但版本不符 → 换成与当前 MC 版本匹配的构建。
3. `Mod with id X not found in ModList` 中的 `X` 是**被查找方**，肇事者通常是发出这次查找的另一个模组（栈顶帧里的模组名）。把两者版本配对。
4. 崩溃发生在 `Initializing game` 时，无法通过在游戏中操作绕过，必须处理模组。

**触发 B（提供方返回 null）**

1. 读出 `because the return value of "X.getY()" is null` 中的 `X`——肇事者是 `X` 所属模组，不是栈顶帧。
2. 检查 `X` 的必需前置是否安装（Fabric 模组查 `fabric.mod.json` 的 `depends`）。
3. `X` 是被兼容的第三方模组的 API 时，检查两者的版本配对。

**触发 C（加载时序）**

1. 核对栈顶帧所属模组的支持 MC 版本；时序问题绝大多数是模组未适配。
2. 更新该模组到适配当前 MC 与加载器版本的构建。
3. 若崩溃报告只有 `Server brand: ~~ERROR~~ NullPointerException` 而没有真正的异常栈，说明真正的异常在日志更前面，继续向前找。

**触发 D（配置 / 数据文件缺失）**

1. 读出栈顶帧的模组类，定位该模组的配置目录（`config/<模组ID>/`）与资源包目录。
2. 删除该模组的配置文件让其重新生成默认值。
3. 若缺失的是**自身数据文件**（如表情定义、动画定义随模组提供），重新下载该模组，不要只复制配置文件。

**触发 E（存档不匹配）**

1. 按「实体 / 方块实体 tick 崩溃」处理：优先装回被移除的模组。
2. 无法装回时定位坐标并用区块编辑工具清理，操作前必须完整备份存档。

**触发 F（跨加载器）**

1. 先按 Connector 官方诊断流程确认问题是否由 Connector 引入。
2. 把 Connector 与 Fabric 侧模组升级到同一批发布周期的版本。
3. 若仅有这一条 NPE 且游戏能继续，视为可容忍噪音。

**通用前提**：不要删除整个 `config/` 目录——多数模组的配置文件携带用户的既有设置，只在确认某个文件损坏时单独删除它。

## 置信度线索

- **确定（NPE 是根因）**：异常出现在崩溃报告的 `Description` 之后第一个异常位置（栈顶异常），且有完整栈；`Description` 为 `Initializing game` / `Ticking entity` / `Unexpected error` 等阶段说明。
- **确定（NPE 不是根因）**：NPE 只出现在日志正文中、**没有**对应的 `---- Minecraft Crash Report ----` 段；或出现在崩溃报告的 `Server brand:` 字段里。
- **确定（注册表缺失）**：`Registry Object not present:` / `Registry entry not present:` / `Mod with id ... not found in ModList`。
- **较确定（责任方定位）**：`because the return value of "X.getY()" is null` —— 责任在 `X`；`because "this.<字段>" is null` —— 责任在当前栈顶帧所属的类。
- **较确定（可容忍）**：`org.lwjgl.opengl.Display:setIcon` 的 NPE（LWJGL 在部分移动端驱动上设置窗口图标的已知噪音）、`Loading class java/lang/NullPointerException`（只是 JVM 加载了该类）。
- **易误判**：`Description: Unexpected error` 是最常见的 NPE 崩溃阶段标签（实测占 NPE 崩溃的一半），信息量极低——**必须看栈顶第一帧**才能判断归属，不要因标签笼统而放弃定位。
- **易误判**：`StringIndexOutOfBoundsException` 等其它异常也可能伴随 NPE 段落出现，注意不要把它们混为本类。
- **需追问**：日志未标明最近是否增删过模组时，向用户确认——触发 A / D / E 三类都无法只靠日志证明「某个东西是被移除的」，只能证明它当前不存在。
