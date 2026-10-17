# Mixin / ClassTweaker 命名空间错配（映射层）

## 签名 (Signature)

下列频次的分母是 2026-10-10～10-16 期间分层抽取的 536 份真实日志全文（FCL 220 / axolotl 134 / ZL2 104 / AMCL 24 / Web 上传 25 / 其他 29），括号内为命中份数。

**classTweaker 声明的命名空间与运行期不符（致命，崩在游戏启动之前）**

```
Caused by: java.lang.RuntimeException: Failed to read classTweaker file from mod trinkets
	at net.fabricmc.loader.impl.FabricLoaderImpl.loadClassTweakers(FabricLoaderImpl.java:543)
	at net.fabricmc.loader.impl.launch.knot.Knot.init(Knot.java:145)
	at net.fabricmc.loader.impl.launch.knot.Knot.launch(Knot.java:66)
Caused by: net.fabricmc.loader.impl.lib.classtweaker.reader.ClassTweakerFormatException: line 1: Namespace (intermediary) does not match current runtime namespace (official)
	at net.fabricmc.loader.impl.lib.classtweaker.reader.ClassTweakerReaderImpl.error(ClassTweakerReaderImpl.java:332)
	at net.fabricmc.loader.impl.lib.classtweaker.reader.ClassTweakerReaderImpl.read(ClassTweakerReaderImpl.java:93)
```

（1/536。实测环境 MC 26.1.2 + Fabric Loader 0.20.0，点名模组 `trinkets 3.10.0`。两行括号里分别直接给出「声明的命名空间」与「运行期命名空间」，是本类唯一自带双向证据的签名，不需要推断。）

**refmap 缺失，运行期只能按构建期命名空间的名字逐字查找（`No refMap loaded`）**

```
Critical injection failure: @Inject annotation on onAddStatusEffect could not find any targets matching 'method_6092' in net.minecraft.world.entity.LivingEntity. No refMap loaded.
Critical injection failure: @Inject annotation on getName could not find any targets matching 'getHoverName' in net/minecraft/item/ItemStack. No refMap loaded.
org.spongepowered.asm.mixin.transformer.throwables.InvalidMixinException: @Shadow method getOBB in ashvehicle.mixins.json:VehicleEntityMixin from mod ashvehicle was not located in the target class com.atsuishio.superbwarfare.entity.vehicle.base.VehicleEntity. No refMap loaded.
```

（10/536：axolotl 6 / ZL2 2 / FCL 2。其中目标名确为异命名空间形态的 1 份，即第一条 `method_6092`，运行环境为 Forge 47.4.10 + MC 1.20.1；其余目标名是普通模组类成员名，属目标模组结构变动，见「含义」的分界说明。）

**refmap 存在但不再参与翻译（26.1 起的高频预期输出，本身不是故障）**

```
[main/WARN]: Reference map 'iris.refmap.json' for mixins.iris.json could not be read. If this is a development environment you can ignore this message
[main/WARN]: Reference map 'balm.refmap.json' for balm.mixins.json could not be read. If this is a development environment you can ignore this message
```

（183/536，占 34.1%：axolotl 82 / FCL 52 / ZL2 35 / 其他 9 / Web 上传 5。单份日志内可命中数十个不同模组，实测覆盖 Iris、Balm、Clumps、ChatAnimation、XaeroLib、XaeroWorldMap、YACL、FerriteCore、GeckoLib、Searchables、TrashSlot、EntityCulling 等；分布几乎与启动器无关，只取决于该整合包里装了多少个 1.21 及以前构建的模组。）

## 含义

Minecraft 的类与成员在不同环节使用**不同的命名空间**，一次加载要把构建期的名字翻译成运行期的名字：

| 命名空间 | 形态示例 | 谁在什么环节使用 |
|---|---|---|
| official | `net.minecraft.world.entity.LivingEntity`、`addEffect` | 26.1 起的运行期本体；官方名即 Mojang 名，无需翻译 |
| intermediary | `net/minecraft/class_1309`、`method_6092` | Fabric 在 1.21.x 及以前的运行期本体；Fabric 模组构建时的中间名 |
| named（Yarn / Mojang 名） | `net/minecraft/entity/LivingEntity`、`addStatusEffect` | 1.21.x 及以前 Fabric 模组在开发环境与构建产物中写下的目标名；Yarn 的包路径与 official 不同 |
| SRG | `net.minecraft.world.entity.LivingEntity`（路径同 official）、`m_21241_`（成员名为 SRG 形式） | Forge / NeoForge 的运行期本体 |

翻译由两样东西承担，本类故障就是这两样东西与运行期不匹配：

- **classTweaker 文件（`*.classtweaker`）**：声明「本模组要扩展 MC 的哪些类」，文件头带一个 `namespace` 字段。Fabric Loader 在 `Knot.init` → `FabricLoaderImpl.loadClassTweakers` 阶段把该字段与运行期命名空间比对，**不等即拒绝整份文件并直接中止启动**。此时游戏尚未开始加载，所以日志停在 `OpenJDK exited with code : 1` 一行，`crash-reports/` 不会生成。
- **refmap（`<模组名>.refmap.json`）**：Mixin 的翻译表，把模组写下的 named/intermediary 名字映射到运行期名字。缺失时 Mixin 不会报错，而是**跳过翻译、直接拿构建期的字面名去目标类里查找**；查不到就抛 `could not find any targets matching '<构建期名字>'`，并在同一行末尾附上 `No refMap loaded.` 作为「翻译为什么没发生」的解释。

因此判读本类只需要一次比对：**报错里给出的目标名属于哪个命名空间，运行期是哪个命名空间。** 两者不同即本类故障；两者相同而方法名对不上，属「Mixin 注入失败」。

| 报错文本 | 含义 | 是否致命 |
|---|---|---|
| `ClassTweakerFormatException: line N: Namespace (A) does not match current runtime namespace (B)` | classTweaker 声明的 A 与运行期 B 不符 | 致命，启动中止 |
| `Failed to read classTweaker file from mod <模组ID>` | 上一行的外层包装，点名文件属于哪个模组 | 致命，启动中止 |
| `could not find any targets matching '<名字>'` + `No refMap loaded.` | refmap 缺失，按构建期字面名查找失败；`<名字>` 为 `method_\d+` / `class_\d+` / `f_\d+_` 或 named 形态时即命名空间错配 | 视模组配置，多为致命 |
| `Reference map '<文件>.refmap.json' for <配置>.mixins.json could not be read` | refmap 文件存在但当前运行期不再需要它 | 非致命，纯 WARN |

**与「Mixin 注入失败」的分界**：本类问的是「这个名字根本不属于这个运行期」，注入失败问的是「名字属于这个运行期，但方法已被改名或搬移」。落地判据有两条，满足任一条即归本类：(1) 报错行含 `No refMap loaded.` 且目标名是异命名空间形态；(2) 报错含 classTweaker 的 `Namespace (...) does not match current runtime namespace (...)`。只有 `(0/N) succeeded`、`Scanned N target(s)`、`Method overwrite conflict` 这类计数与冲突信息时，归「Mixin 注入失败」。同一份日志两者并存时，**先修命名空间错配**——注入失败可能只是它的下游。

**与「Mixin 目标类缺失」的分界**：本类全程在**成员层面**（方法/字段名解析失败），目标类本身能被加载；`@Mixin target <类> was not found` 是**类层面**失败，目标类根本不存在。

**同一个问题在不同启动器下的表现差异**（实质相同，读数不同）：

| 启动器 | 表现 | 读数重点 |
|---|---|---|
| FCL | Java 栈外面套一层 `at mio.Wrapper.main(Wrapper.java:21)`，日志以 `OpenJDK exited with code : 1` 收尾；`Reference map ... could not be read` 的 logger 前缀可能是 `[main/WARN]`（无 logger 名） | classTweaker 形态末尾有 `MioLibPatcher/INFO]: Patch target class:` 一类补丁日志，容易被误当成崩溃点，真正的 `Caused by:` 在其下 |
| axolotl | 日志不套 wrapper，Mixin 侧前缀为 `[FabricLoader/Mixin/WARN]` 或 `[mixin/WARN]`；崩溃报告里的 `No refMap loaded.` 与 `InvalidInjectionException` 会连成一段完整栈 | 直接看崩溃报告的栈顶，`No refMap loaded.` 出现在异常消息行末 |
| ZL2 | 前缀多为 `[mixin/FATAL]`、`[main/WARN]`，同样不套 wrapper；实测 `No refMap loaded` 与 `method_6092` 一类异命名空间名字的命中集中在 axolotl | 与 axolotl 同判，注意其日志里模组名、崩溃报告文件名（`crash-2026-xx-xx_xx.xx.xx-client.txt`）可直接对照 |

## 常见触发

### 触发 A：26.1 起官方取消混淆，classTweaker 里的 intermediary 声明与运行期 official 冲突

Mojang 在 26.1 中取消了对 Java 版 jar 的混淆，运行期命名空间随之从 intermediary 变为 official。为旧版本构建的模组，其 classTweaker 文件里仍写着 `namespace intermediary`，Fabric Loader 直接判定格式非法。

典型特征：`Failed to read classTweaker file from mod <模组ID>` 紧接 `Namespace (intermediary) does not match current runtime namespace (official)`；同一行的 `line 1` 说明出错位置在文件头；日志中的 `Loading Minecraft 26.1.2 with Fabric Loader 0.20.0` 一类版本行可用来确认运行期命名空间（26.1 及以后为 official）。

这类模组**只能整体升级到按 official 命名空间构建的版本**，改配置文件无效。

### 触发 B：模组产物缺 refmap，按构建期命名空间的名字逐字查找

模组的构建产物里没有 `.refmap.json`（发布时漏打包、用了开发期目录、被解压工具丢失），发布方与运行期命名空间不同，于是模组写下的名字在运行期查不到。

典型特征：`could not find any targets matching '<名字>'` 行末带 `No refMap loaded.`；`<名字>` 是 `method_6092` 这类 intermediary 名，或 `getHoverName`、`net/minecraft/network/packet/Packet` 这类 named 名。实测案例为 Forge 47.4.10 + MC 1.20.1 上 `guiyubuding` 的 `LivingEntityMixin` 直接以 `method_6092` 查找 `net.minecraft.world.entity.LivingEntity` 的成员。

### 触发 C：按 Fabric/intermediary 构建的混入运行在 Forge/NeoForge 的 SRG 运行期

Fabric 模组经 Sinytra Connector 运行在 Forge/NeoForge 上，或模组打包时混入了另一加载器构建的类，构建期名字（intermediary）与运行期名字（SRG）完全不同。

典型特征：日志中出现 Connector 的装载行，实测该案例为

```
Found mod file Connector-1.0.0-beta.49+1.20.1-mod.jar of type MOD with provider org.sinytra.connector.locator.ConnectorEarlyLocator@33956d1a
SpongePowered MIXIN Subsystem Version=0.8.5 Source=union:/.../mods/Connector-1.0.0-beta.49+1.20.1.jar!/ Service=ModLauncher Env=CLIENT
```

同时该份日志的 `Found 1 non-fabric mod:` 段落说明实例内混有另一加载器构建的 jar；报错里的目标名是 `method_\d+` 形态（intermediary），而栈帧前缀为 `LAYER PLUGIN/` 或 `TRANSFORMER/`。

### 触发 D：按 named（Yarn / Mojang 名）构建，运行期是 intermediary

模组在开发环境（Yarn/Mojang 名）下编译，发布产物又缺 refmap，部署到 1.21.x 的 Fabric 实例上。运行期是 intermediary，模组却按 named 名查找。

典型特征：目标名是可读的英文名（`getHoverName`、`onStatusEffectsRemoved`、`getGameInformation`），运行期版本为 1.21.x 及以前；同一份日志通常另有若干条 `Reference map ... could not be read`。

### 触发 E：refmap 存在但不参与翻译（26.1+ 噪音）

模组按 26.1 之前的版本构建并带了 refmap，26.1 起运行期已经是 official，refmap 不再需要，加载器只记一条 WARN。

典型特征：`Reference map '<文件>.refmap.json' for <配置>.mixins.json could not be read. If this is a development environment you can ignore this message`，行尾自带「可忽略」提示；同一份日志里成批出现、覆盖多个模组，**且不含 classTweaker 报错**。

## 修复步骤

**触发 A（classTweaker 命名空间冲突）**

1. 从 `Failed to read classTweaker file from mod <模组ID>` 直接读出模组 ID，不必从栈里推断。
2. 确认运行期命名空间：`Namespace (...)` 第二个括号内的值即运行期实际命名空间，通常为 `official`（26.1 及以后）。
3. 把该模组升级到适配当前 MC 版本的构建；这类模组在 26.1 上只有「已适配」与「不可用」两种状态。
4. 该模组是整合包必需项时，只能回到 26.1 之前的 MC 版本，或等作者适配。
5. 不要尝试手工编辑 jar 内的 classTweaker 文件——扩展内容本身也是按旧命名空间写的，改了头部只会把失败点后移。

**触发 B（refmap 缺失）**

1. 读出 `could not find any targets matching '<名字>'` 里的名字，判断它属于哪个命名空间（`method_\d+` / `class_\d+` / `f_\d+_` 是混淆名，可读英文名是 named 名）。
2. 用模组的正式发布构建替换当前 jar，不要用开发快照或自己编译的产物——refmap 缺失绝大多数源于打包不完整。
3. 手动解压过模组、或从压缩包里单独拖出过 class 文件时，删除后重新放回完整 jar。
4. 该报错只涉及某一个混入类时，仍属发布产物问题；逐个替换无法解决时按第 2 步整体重下该模组。

**触发 C（跨加载器）**

1. 先确认日志含 `SINYTRA CONNECTOR IS PRESENT!` 段落，再按 Connector 官方诊断流程排除 Connector 自身。
2. 把 Connector 与所有 Fabric 侧模组升级到同一批发布周期的版本，避免二者命名空间处理策略不同。
3. 升级后仍报 `method_\d+` 找不到时，移除该模组的 Fabric 兼容构建，改用其 Forge/NeoForge 原生构建。

**触发 D（构建期 named / 运行期 intermediary）**

1. 确认运行期 MC 版本（1.21.x 及以前为 intermediary）。
2. 把模组换成与其 MC 版本匹配的发布构建；同一模组同时提供 Yarn 构建与 official 构建时选后者。
3. 该模组只发布开发快照时，不要用——缺少 refmap 的快照在正式实例上必然失败。

**触发 E（refmap WARN）**

1. 不做任何处理。行尾已声明可忽略。
2. 需要核对它是否真的无害时，检查同一份日志有没有 `Failed to read classTweaker file from mod` 或带 `No refMap loaded.` 的失败行：没有即纯噪音。
3. 排查其它问题时，先用工具过滤掉 `Reference map ... could not be read` 再读日志——183/536 的占比意味着它会把真正的失败行淹没。

## 置信度线索

- **确定（属本类）**：日志含 `ClassTweakerFormatException: line N: Namespace (...) does not match current runtime namespace (...)` 或 `Failed to read classTweaker file from mod <模组ID>`
- **确定（属本类）**：报错行含 `No refMap loaded.`，且同一行的目标名是混淆名形态（`method_\d+`、`class_\d+`、`f_\d+_`）或 named 名形态（可读英文名、`net/minecraft/network/packet/...` 这类未混淆路径）
- **确定（模组归属）**：`Failed to read classTweaker file from mod <模组ID>` 与 `could not find any targets matching` 中 `from mod <模组ID>` 都直接给出模组 ID，无需推测
- **确定（运行期命名空间）**：`Namespace (A) does not match current runtime namespace (B)` 中的 B 即运行期命名空间；日志里的 `Loading Minecraft <版本> with Fabric Loader <版本>` 行可用于确认 MC 版本
- **非故障（高频噪音）**：`Reference map '<文件>.refmap.json' for <配置>.mixins.json could not be read`，行尾 `If this is a development environment you can ignore this message`，26.1 及以后属预期输出；不得据此判定崩溃原因
- **需区分（注入失败）**：只有 `(0/N) succeeded`、`Scanned N target(s)`、`Method overwrite conflict`、`@Redirect conflict` 而无 `No refMap loaded.` 时，属「Mixin 注入失败」（目标方法被改名/搬移），修复方向是版本配对
- **需区分（类缺失）**：`@Mixin target <类> was not found` 是类层面失败，归「Mixin 目标类缺失」；本类的目标类能被加载，失败发生在成员查找
- **易误判（`mapping:` 前缀）**：`InvalidAccessorException: No candidates were found matching mapping:Lnet/minecraft/client/KeyMapping;` 里的 `mapping:` **不是**映射记号，而是访问器方法名推导出的字段名——`ponderer$getMapping` 去掉前缀并将首字母转为小写后得到 `mapping`，后接类型描述符。它属成员名/类型不符，不能当作命名空间错配的证据
- **需区分（访问器名后无描述符）**：`No candidates were found matching <字段名>:<类型描述符>` 中的字段名若不是混淆名形态，多为目标模组内部重构所致，归版本错配
- **需追问**：日志未给出 Mod List 或 MC 与加载器版本时，向用户确认这两项；判断运行期命名空间必须有它们

## 背景：26.1 起 Java 版不再混淆

Mojang 于 2025 年 11 月宣布、并从 26.1（2026-03-24 发布）起实施：Java 版的客户端与服务端 jar **不再混淆**，`version.json` 中不再提供混淆映射，类的字段名、方法名与参数名以官方名字直接发布。

这项变更同时改写了前面那张命名空间表的含义：26.1 之前，运行期命名空间与构建期命名空间必然不同（Fabric 模组写 intermediary，Forge 模组写 SRG），refmap 与 classTweaker 的 `namespace` 声明是必需的翻译层；26.1 之后运行期即 official，翻译层对于按新版本构建的模组不再需要，但对于按旧版本构建的模组，翻译层里记录的旧命名空间反而成了**不匹配的证据**。classTweaker 是这一变化的直接受害者——它把命名空间声明在文件头且由加载器强校验，因此旧模组在 26.1 上会**启动即失败**，而不是像 refmap 那样退化成一条 WARN。

同一时期，Fabric 官方公告声明 26.1 起 **Intermediary 将不再存在**，Yarn 不再为新版本更新（Fabric 文档已将 Yarn 标记为不再支持，要求迁移到 Mojang 映射）；Quilt Mappings 亦声明不再为新版本维护映射。第三方映射生态整体向 official 收敛，这让「按哪个命名空间构建」成为模组可用性的硬性分水岭。
