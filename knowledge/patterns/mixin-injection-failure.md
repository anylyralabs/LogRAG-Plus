# Mixin 注入失败（全平台高频）

## 签名 (Signature)

**最外层异常（崩溃报告中可直接看到的类名）**

```
org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
org.spongepowered.asm.mixin.injection.throwables.InjectionError
org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException
org.spongepowered.asm.mixin.injection.throwables.InjectionValidationException
org.spongepowered.asm.mixin.throwables.MixinApplyError
org.spongepowered.asm.mixin.transformer.throwables.MixinTargetAlreadyLoadedException
```

**崩点日志行（FATAL 级，形如 `Mixin apply for mod <ID> failed`）**

```
[Mixin apply for mod <模组ID> failed <mixin配置文件名>:<混入类> from mod <模组ID> -> <目标类>: <异常类>]
[main/FATAL]: Mixin apply for mod ponderer failed ponderer.mixins.json:JeiGuiEventHandlerMixin from mod ponderer -> mezz.jei.gui.events.GuiEventHandler
```

**`MixinApplyError` 的固定句式**

```
Mixin [<mixin配置文件名>:<混入类> from mod <模组名>] from phase [<DEFAULT>] in config [<mixin配置文件名>] FAILED during <PREPARE | APPLY>
```

**目标类不存在（WARN 级，大量成对出现）**

```
@Mixin target <全限定类名> was not found <mixin配置文件名>:<混入类> from mod <模组ID>
Error loading class: <类路径> (java.lang.ClassNotFoundException: <全限定类名>)
@Mixin target com.gregtechceu.gtceu.api.recipe.ingredient.ToolIngredient was not found tconstruct.mixins.json:gtceu.ToolIngredientMixin from mod (unknown)
```

**目标类被过早加载**

```
MixinTargetAlreadyLoadedException: Critical problem: <mixin配置文件名>:<混入类> from mod <模组名> target <全限定类名> was loaded too early.
[main/FATAL]: Mixin prepare for mod (unknown) failed preparing GlobalMixin in emi.mixins.json:
    org.spongepowered.asm.mixin.transformer.throwables.MixinTargetAlreadyLoadedException Critical problem:
    emi.mixins.json:GlobalMixin from mod (unknown) target dev.emi.emi.api.EmiPlugin was loaded too early.
```

**回调组计数校验失败（`Critical injection failure`，本类故障最精确的一行）**

```
Critical injection failure: %s %s%s in %s failed injection check, (%d/%d) succeeded. Scanned %d target(s). %s%s
Critical injection failure: %s %s%s in %s failed injection check, %d succeeded of %d allowed.%s
Critical injection failure: %s could not find any targets matching %s in %s. %s%s
Critical injection failure: Callback group %s in %s failed injection check: %s
Critical injection failure: Callback group @Group(name=ponderer$skipEmbeddedMirrorJeiDraw, min=1, max=2147483647) in ponderer.mixins.json:JeiGuiEventHandlerMixin from mod ponderer failed injection check, (0/1) succeeded.
```

**回调组计数的底层消息（上一行的内部成因）**

```
expected %d invocation(s) but %s%d succeeded
maximum of %d invocation(s) allowed but %d succeeded
```

**注入点匹配失败（`@Redirect` / `@Inject` 找不到锚点）**

```
%s ctor invocation was not found in %s
%s, failed to select into child. %s%s was not found in the target class.
Super class '%s' of %s was not found in the hierarchy of target class '%s'
```

**两个 Mixin 争抢同一处（WARN 级，多为可容忍，非致命）**

```
Method overwrite conflict for <方法名> in <mixin配置文件名>:<混入类>, previously written by <先写入的类>. Skipping method.
Method overwrite conflict for @Final method <方法名> in <mixin配置文件名>:<混入类> declared by <先声明的类>. Skipping method.
@Redirect conflict. Skipping <mixin配置文件名>:<混入类> from mod <模组ID>->@Redirect::<方法名> with priority <n>, already redirected by <先重定向的类>
```

## 含义

Mixin 是**字节码层的代码注入框架**：模组不修改 MC 的源码，而是在类被加载时，把自定义代码按「注入点」（`@Inject` / `@Redirect` / `@ModifyArg` / `@ModifyVariable` / `@ModifyConstant` / `@Accessor` / `@Invoker`）插进目标类的方法里。

Mixin 框架在注入前会做一次**计数校验**：模组用 `@Inject(require = N)` 或 `@Group(min = ..., max = ...)` 声明「这个注入点至少/至多必须命中几次」。校验失败即抛 `InjectionValidationException`，并被包装成 `InvalidInjectionException` 与 `MixinApplyError`。

因此本类故障的实质只有三种：

| 实质 | 触发原因 | 判据 |
|---|---|---|
| **目标类/方法在运行期与编译期不一致** | 模组是为**另一个版本的 MC 或另一个版本的被注入模组**编译的 | `was not found`、`could not find any targets matching`、`(0/N) succeeded` |
| **两个 Mixin 争夺同一注入点** | 两个模组改写同一方法的同一处，优先级与 `@Final` 决定了谁生效 | `Method overwrite conflict`、`@Redirect conflict` |
| **加载时序违规** | 目标类在 Mixin 注册前就被其他代码加载 | `target ... was loaded too early` |

**两类源头的区分是整个故障类的核心**（后续修复方向完全不同）：

- **模组版本错配**：签名集中在 `was not found` / `ClassNotFoundException` / `(0/N) succeeded`，且**目标类属于另一个模组或 MC 本体**，说明被注入方变了而注入方没跟上
- **两个 Mixin 冲突**：签名集中在 `conflict` / `previously written by` / `already redirected by`，出现**两个模组名同时指向同一个目标类或方法**

崩溃发生的阶段也需区分：`FAILED during PREPARE` 表示在**准备阶段**（读取 `@Mixin` 目标声明时）就失败，通常指向目标类不存在或过早加载；`FAILED during APPLY` 表示准备通过、**实际注入时**失败，通常指向注入点计数不符或两个 Mixin 冲突。

## 常见触发

### 触发 A：模组版本与被注入方错配（版本错配导致）

模组为特定版本的 MC 或被注入模组编译，运行期目标类已改名、改签名或改结构。

典型签名：`@Mixin target ... was not found`（伴随 `ClassNotFoundException`）、`Critical injection failure: ... could not find any targets matching ...`、`(0/1) succeeded`。

已实测案例：`fcl-latest6215063907665127896.log` 中多条 `@Mixin target <类> was not found` 成对出现（`Error loading class` + `@Mixin target ... was not found`），说明这些模组各自为不同版本编译。

### 触发 B：两个模组改写同一处（Mixin 冲突）

两个模组给同一个方法注入、重定向同一处调用，或覆写同一个方法。

典型签名：`Method overwrite conflict for ... previously written by ...`、`@Redirect conflict. Skipping ... already redirected by ...`。

这类 WARN **多数可被框架容忍**（跳过后继续运行），只有在配了 `require` / `@Group` 的模组上才会升级为 FATAL。

已实测案例：`latest (1).log` 中 `ponderer` 模组的 `@Group(name=ponderer$skipEmbeddedMirrorJeiDraw, min=1, max=2147483647)` 校验 `(0/1) succeeded` 失败，目标类是 **JEI 的** `mezz.jei.gui.events.GuiEventHandler` —— 即 `ponderer` 为另一个版本的 JEI 编译，JEI 内部结构变动后注入点消失。

### 触发 C：目标类被过早加载

目标类在 Mixin 配置注册前已被其他代码触发了类加载，字节码已成型，无法再注入。

典型签名：`MixinTargetAlreadyLoadedException: Critical problem: ... target <类> was loaded too early.`。

已实测案例：`fcl-latest6215063907665127896.log` 中 `emi.mixins.json:GlobalMixin` 的目标 `dev.emi.emi.api.EmiPlugin` 被过早加载，报告为 `FAILED during PREPARE`。

### 触发 D：注入点签名不符（`@Redirect` / `@ModifyArg` 锚点失效）

方法名或描述符对不上，符号引用无法解析。

典型签名：`<注解名> ctor invocation was not found in <目标类>`、`... failed to select into child ... was not found in the target class.`、`Super class '...' of ... was not found in the hierarchy of target class '...'`。

### 触发 E：Forge 环境下的 coremod 补丁冲突

非 Mixin 体系的老式 coremod（`IFMLLoadingPlugin`）与模组 Mixin 同时改动同一类时，报 `Failed to apply patch` 或 `Cannot apply transform`。

这类问题出现在 Forge 1.12.2 及更早版本，模组列表中以 `LoadingPlugin` / `*Core` 形式出现（崩溃报告的 `WARNING: coremods are present:` 段落会列出它们）。

## 修复步骤

**触发 A（模组版本错配）**

1. 读出 `-> ` 右侧的**目标类全限定名**，判断它属于谁：
   - `net.minecraft.*` / 混淆名 `class_*` / `method_*` → MC 本体，说明该模组不是为当前 MC 版本构建的
   - 其他模组包名（如 `mezz.jei.*`、`dev.emi.emi.*`、`net.caffeinemc.*`）→ 说明目标模组版本变了
2. 把**注入方模组**换成与当前 MC 版本匹配的构建
3. 若目标类属于另一个模组（如上面 JEI 的例子），需让两者版本配对：升级注入方到支持当前目标模组版本的构建，或把目标模组降到注入方编译时的版本
4. 大批量 `@Mixin target ... was not found` 同时出现（超过十条）说明是**整体版本错配**，应检查 MC 版本与所有模组的支持范围，而不是逐个修补
5. 不要试图通过加 `-Dmixin.debug` 一类调试参数「修好」它——那只是让日志更详细地记录同一次失败

**触发 B（两个 Mixin 冲突）**

1. 读出 `previously written by <类名>` 或 `already redirected by <类名>` 中的**另一个模组**是谁
2. 二选一：两个模组功能重叠时移除其中一个
3. 两者都是必需模组时，改为寻找其中一个的兼容版本，或查找功能替代品
4. 检查是否有多个**同类优化模组**共存导致大量 `Method overwrite conflict`，这类组合通常应只保留一套
5. 只有 `Method overwrite conflict` 的 WARN 而无 FATAL 时，不必立即处理——框架已跳过并继续运行

**触发 C（目标类过早加载）**

1. 读出 `target <全限定类名> was loaded too early` 中的目标类
2. 该目标类属于哪个模组，就把**该模组**更新到修复过加载时序的版本
3. 若目标类属于 MC 本体，更新加载器（Fabric Loader / Forge / NeoForge）到最新版
4. 调整模组加载顺序通常无效——这是类加载触发时机问题，不是排序问题

**触发 D（注入点签名不符）**

1. 读出 `ctr invocation was not found in <目标类>` 中的目标类与方法描述符
2. 确认注入方模组的支持版本与当前 MC / 目标模组版本一致
3. 该目标方法在此版本已被重构（合并、改名、搬移）时，只能等模组作者适配

**触发 E（coremod 冲突）**

1. 读取崩溃报告 `WARNING: coremods are present:` 段落中列出的 coremod
2. 逐个停用这些 coremod 模组，验证崩溃是否消失
3. `FoamFix` 的 coremod 在报告中会附带 `Do not report to Forge!` 字样，这意味着该 coremod 已知会干扰其他模组的诊断，排查时应先行停用
4. 停用 coremod 后问题消失，说明它与其他模组的补丁冲突，需更新或替换该 coremod

## 置信度线索

- **确定（属于本类）**：日志或崩溃报告含 `MixinTransformerError` / `MixinApplyError` / `Critical injection failure` / `MixinTargetAlreadyLoadedException` 之一
- **确定（版本错配）**：出现 `@Mixin target ... was not found` 或 `Critical injection failure ... (0/N) succeeded`，且 `-> ` 右侧目标类属于 MC 本体或其他模组。这是**最简单可靠的判据**：目标类存在但注入失败 = 签名不符 = 版本错配
- **确定（两个 Mixin 冲突）**：同一行或相邻行内出现**两个不同模组名**争夺同一个类或方法（`previously written by` / `already redirected by` / `Skipping`)
- **较确定**：只有 `Method overwrite conflict` WARN 而无 FATAL 终止——框架已容忍跳过一个，属良性冲突，但仍说明存在同类模组叠加
- **较确定（时序问题）**：`loaded too early` 字样，与版本错配是两回事，修复方向是更新目标类所属模组而非调换版本
- **注意（常见误导）**：`@Mixin target ... was not found` 在正常启动中也会少量出现（模组对可选前置做了条件注入）。判断严重性看它**是否伴随 FATAL 终止**，以及数量是否是**大批量成对出现**
- **需追问**：日志未标明 MC 版本、加载器类型与版本、模组列表时，向用户确认（同一份日志里 `Loading Minecraft X with Fabric Loader Y` 或崩溃报告的 `Mod List` 段落可提供该信息）
