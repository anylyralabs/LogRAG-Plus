# Mixin refmap 缺失（`Reference map ... could not be read` / `No refMap loaded`）

## 签名 (Signature)

下列频次的分母是 2026-10-17 抽取的 499 份真实日志全文（FCL 369 / axolotl 77 / ZL2 51 / Web 上传 2），括号内为命中份数。

**refmap 文件读不到（WARN 级，本类主签名）**

（136/499，27.3%；全文合计 2560 行。logger 前缀有三代写法，含义相同。）

```
[11:00:57] [main/WARN]: Reference map 'balm.refmap.json' for balm.mixins.json could not be read. If this is a development environment you can ignore this message
[10:56:52] [main] [mixin/WARN]: Reference map 'entityculling.refmap.mixins.json' for entityculling.mixins.json could not be read. If this is a development environment you can ignore this message
[11:01:55] [main] [FabricLoader/Mixin/WARN]: Reference map 'yet_another_config_lib_v3.refmap.json' for yacl.mixins.json could not be read. If this is a development environment you can ignore this message
```

**refmap 名为空串（配置里有 `refmap` 字段，但值是空字符串）**

（34/499，6.8%；全文合计 51 行。）

```
[10:56:01] [main/WARN]: Reference map '' for adapter.init.mixins.json could not be read. If this is a development environment you can ignore this message
Reference map '' for chat_heads.forge.mixins.json could not be read. If this is a development environment you can ignore this message
Reference map '' for krypton_fnp.mixins.json could not be read. If this is a development environment you can ignore this message
Reference map '' for mcreator_mem_fix.mixins.json could not be read. If this is a development environment you can ignore this message
Reference map '' for mixins.vintagefix.init.json could not be read. If this is a development environment you can ignore this message
```

`''` 中的名字来自配置文件的 `refmap` 字段，**不是** Mixin 推断出来的，因此空串证明该字段被写成了空值。

**refmap 缺失导致注入点解析失败（致命，本类唯一的硬失败形态）**

（1/499，5 行；行尾的 `No refMap loaded.` 是本形态与「Mixin 注入失败」的唯一区分标记。）

```
[main/ERROR]: Mixin apply for mod yes_steve_model failed yes_steve_model.mixins.json:LivingEntityMixin from mod yes_steve_model -> net.minecraft.entity.LivingEntity: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @Inject annotation on OO0ooo0OooOoO0OoO0ooOO0o could not find any targets matching 'onStatusEffectsRemoved(Lnet/minecraft/entity/effect/StatusEffectInstance;)V' in net/minecraft/entity/LivingEntity. No refMap loaded. [INJECT_PREPARE Applicator Phase -> yes_steve_model.mixins.json:LivingEntityMixin from mod yes_steve_model ...
```

该行在 `No refMap loaded.` 之后还有 `[INJECT_PREPARE Applicator Phase -> ...]` 段落，上例按可读性截断。

该行中 `@Inject annotation on` 后面是**模组自己的方法名（已被混淆为 `OO0ooo0OooOoO0OoO0ooOO0o`）**，`matching '...'` 里面是**构建期写下的目标名**，`in <目标类>` 是运行期目标类。三者同时出现即说明：模组是混淆构建，而翻译表丢了。

## 含义

`refmap`（Reference Map）是 Mixin 在**构建期**生成的名字翻译表，文件名为 `<配置名>.refmap.json`，由混入配置里的 `refmap` 字段指名引用。它的作用是：模组源码里写的是开发环境的名字（Fabric 的 named / intermediary，Forge 的 SRG），运行期的 MC 本体用的是另一套名字，Mixin 靠这张表把前者翻译成后者。

读不到这张表时，Mixin **不报错、不中止**，而是跳过翻译、直接拿构建期写下的字面名去运行期目标类里查找。因此后果完全取决于被查找的是谁：

| 被查找的目标 | 翻译是否必要 | 后果 |
|---|---|---|
| 模组自己的类、另一个模组类的可读名（非混淆） | 不需要，字面名就是运行期名 | **无害**，只留一条 WARN |
| MC 本体的类/成员（混淆版本上运行期名与构建期名不同） | 需要 | 查找失败 → `could not find any targets matching` + `No refMap loaded.` |
| 目标是 MC 本体类，但模组按**不混淆**的新版本构建 | 不需要 | 无害（26.1 及以后的预期形态） |

`Reference map ... could not be read` 与 `No refMap loaded.` 是同一件事的两个断面：前者是"表读不到"的**记录**，后者是"表读不到"造成的**失败**。实测两者的比例极不对称——136 份日志有前者，只有 1 份出现后者，因为绝大多数混入的目标不是运行期会改名的东西。

**判据是 MC 版本，不是这条 WARN 的次数**：26.1（2026-03）起运行期本体不再混淆（详见「Mixin / ClassTweaker 命名空间错配」的背景段），此时旧模组声明的 refmap 已无翻译对象，加载器只能记一条 WARN；1.21.x 及以前（运行期仍是 intermediary / SRG 的版本）上同一条 WARN 则说明模组的翻译表真的丢了，需要追究。

本抽样中该 WARN 的版本分布（命中/该版本总份数）为：1.21.11 12/37、26.3 11/24、26.2 15/21、1.20.1 7/14、1.21.1 7/13、26.1 1/3、26.1.1 2/2。**它并非 26.1 之后才出现的现象**——在不混淆的 26.x 上它是旧模组不可避免的余留（26.2、26.3 的命中率反而更高），在仍混淆的 1.21.x 上它才是真的丢了翻译表。两个版本段的同一条 WARN 含义相反，按版本分开读。

另有 371/499 份日志的正文里没有 `Loading Minecraft <版本>` 行（启动器只上传了包装层日志、或日志被截断），因此上表的版本分母远小于 499——这本身就是「必须向用户追问 MC 版本」的原因。

## 常见触发

### 触发 A：混入配置声明了 refmap，但发布产物里没有这个文件

模组作者在 `mixins.json` 里写了 `"refmap": "<模组ID>.refmap.json"`，打包/上传/解压环节把该文件弄丢了。实测 `balm.refmap.json`、`entityculling.refmap.mixins.json`、`xaerominimap.refmap.json`、`shouldersurfing.refmap.json`、`kaleidoscope_cookery.refmap.json` 都属此类。

同一份日志里同一个模组出现**多条**该 WARN 时，说明它把同一个 refmap 名声明在了多个混入配置里（实测 `iris.refmap.json` 被 8 个 iris 子配置引用、`shouldersurfing.refmap.json` 被 5 个引用）——这是一个文件服务于多个配置的正常写法，条目数多不代表问题多。

### 触发 B：配置里的 refmap 字段是空串（打包脚本占位符未替换）

`Reference map '' for <配置>.mixins.json could not be read`。这类配置通常由构建脚本 / Gradle 插件从模板生成，模板里的占位符没被替换成真实文件名即留下空串。实测 `adapter.init.mixins.json`、`chat_heads.forge.mixins.json`、`krypton_fnp.mixins.json`、`mcreator_mem_fix.mixins.json`、`mixins.vintagefix.init.json` 都属此类。

空串与"文件名写了但文件没有"在日志上无法区分，两者都是同一条 WARN；判别方式是取模组 jar 解压后看 `<配置>.mixins.json` 的 `refmap` 字段值与同目录下的 `.json` 文件。

### 触发 C：目标为 MC 本体，refmap 缺失升级为致命

即签名小节的第三种形态。特征三件套同时出现：

1. 模组自己的方法名在日志里是混淆形态（如 `OO0ooo0OooOoO0OoO0ooOO0o`）
2. 查找的目标名是构建期名字（可读英文名 `onStatusEffectsRemoved` 或混淆名 `method_NNNN`）
3. 目标类是 `net.minecraft.*` / `net/minecraft/...`

满足 1+2+3 时，模组按混淆构建、翻译表丢失、目标是 MC 本体，三件事同时成立，因此必然失败。

实测案例：`FCL` 启动器、`yes_steve_model` 模组的 `yes_steve_model.mixins.json:LivingEntityMixin` 在 `net.minecraft.entity.LivingEntity` 上以 `onStatusEffectsRemoved` 查找失败，行末带 `No refMap loaded.`。

### 触发 D：26.1 及以后运行期不再混淆，旧声明的 refmap 成为空转

模组按 26.1 之前的版本构建、带着 refmap 进入 26.1+ 的运行期。此时翻译层对两边都不再需要，加载器读不到或读到都不影响，只留 WARN。

区分它与触发 A 的方法只有 MC 版本：日志里 `Loading Minecraft <版本>` 或崩溃报告 `Minecraft Version:` 为 26.1 及以上即属本触发。

## 修复步骤

**先分级，再决定是否动手**——本类 136/499 的命中里只有 1 份构成失败，直接按 WARN 逐条处理是错的方向。

**只有 WARN、没有 `No refMap loaded.`（绝大多数）**

1. 读出 MC 版本。为 26.1 及以上 → 不做任何处理，属预期输出。
2. 为 1.21.x 及以下（运行期仍混淆）→ 确认该模组是否真的需要翻译：日志里同一条 WARN 之后若只有这一条、且全篇无 `No refMap loaded.` / `MixinApplyError` / `MixinTransformerError`，说明被翻译的目标都不是运行期会改名的东西，同样无需处理。
3. 需要处理时只做一件事：重新下载该模组的**正式发布构建**，覆盖当前 jar。不要用开发快照、自己编译的产物，也不要手工解压后单独放回 class 文件——refmap 缺失几乎都源于打包不完整，重下即可。
4. 不要用 `-Dmixin.debug` 一类调试参数"修复"它，那只会让同一次失败记录得更详细。
5. 排查其它问题时，先把 `Reference map .* could not be read` 过滤掉再读日志：它占三成日志、单份可命中数十行，会把真正的失败行淹没。

**出现 `No refMap loaded.`（致命）**

1. 读 `matching '<名字>'` 与 `in <目标类>` 两处，确认目标属于谁：
   - `net.minecraft.*` / `net/minecraft/...` / 混淆名 `method_NNNN`、`class_NNNN` → 目标是 MC 本体
   - 其他模组包名 → 目标是另一个模组
2. 目标是 MC 本体 → 该模组按混淆构建而翻译表丢失，重新下载该模组的正式发布构建。
3. 例子中模组自己的方法名也是混淆形态（`OO0ooo0OooOoO0OoO0ooOO0o`）时，进一步印证是构建产物问题，不是配置文件问题。
4. 目标是**另一个模组**且名字可读（如 `getHoverName`）时，翻译表通常不是主因，而是该模组的构建期命名空间与运行期不符 —— 转「Mixin / ClassTweaker 命名空间错配」按命名空间判读处理。
5. 从头到尾不要改模组 jar 内部的 `.refmap.json`：翻译表的内容必须与构建产物逐字对应，手工补写的表只会让失败点后移。

**构建侧（仅当自己是模组作者）**

新式 Loom 构造已改为就地重映射并关闭注解处理器，不再生成 refmap。若把旧工程迁到新 Loom 却仍在 `mixins.json` 里留 `refmap` 字段，就会得到触发 B 的空串形态；迁移时应把该字段一并移除，而不是手工维护一张已经没人读的表。

## 置信度线索

- **确定（属本类）**：日志含 `Reference map '<文件名>' for <配置>.mixins.json could not be read` 或行尾带 `. No refMap loaded.` 的 `could not find any targets matching`
- **确定（硬失败）**：`No refMap loaded.` 出现在 `Critical injection failure` / `InvalidMixinException` / `InvalidInjectionException` 的同一行行末——该后缀是 Mixin 对"翻译为什么没发生"的显式说明，不必推断
- **较确定（无害）**：只有 WARN，且同一份日志无 `No refMap loaded.`、无 `MixinApplyError` / `MixinTransformerError` / `Critical injection failure`。0.2%（1/499）的日志才会把这条 WARN 变成失败，因此"看到就报"是典型误判
- **较确定（无害，26.1+）**：日志含 `Loading Minecraft 26.1` 及以上版本行，或崩溃报告 `Minecraft Version:` 为 26.1+。此时 refmap 层已无翻译对象
- **较确定（无害的另一种形态）**：同一个 refmap 文件名被同一模组的多个混入配置引用（实测 `iris.refmap.json` 8 个、`shouldersurfing.refmap.json` 5 个），条目数正比于配置数而非问题数
- **易误判（相关性 ≠ 因果）**：含该 WARN 的日志里 71%（97/136）同时含崩溃报告，但它们是体积更大的整合包（装得多、崩得也多），本抽样无法据此建立因果；**根因必须由崩溃报告的栈顶帧或 FATAL 行确定**
- **易误判（与命名空间错配混淆）**：`No refMap loaded.` 本身只说明"翻译表缺失"，不能说明"命名空间错配"。当查找的名字是 `method_NNNN`、`class_NNNN`、`f_NNNN_` 等**异命名空间形态**时，成因更可能是"按旧命名空间构建 + 运行期换了命名空间"，此时应转「Mixin / ClassTweaker 命名空间错配」
- **需区分（不是本类）**：`Reference map ... could not be read` 的**伴随现象**（类层面的 `@Mixin target ... was not found`、`Error loading class:  (java.lang.StringIndexOutOfBoundsException: begin 0, end -1, length 0)`）归「Mixin 目标类缺失」；本类的失败一律发生在**成员查找**层面
- **需追问**：日志未给出 MC 版本时向用户确认。本类的"无害/致命"分界完全建立在 MC 版本上（26.1 是分水岭），缺这一项无法定性
