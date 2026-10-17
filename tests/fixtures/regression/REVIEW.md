# 回归样本人工复核清单

> 对每条样本填写 `expect` 字段后，测试才能用于守门。
> **关键区分**：低分是「真缺陷」还是「评分误判」？

## 低分样本（找缺陷）（6 条）

### `KEkhNjV` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["ignoreError", "java.lang.ClassNotFoundException", "org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException", "java.lang.RuntimeException", "com.google.gson.stream.MalformedJsonException", "com.google.gson.JsonSyntaxException", "com.google.gson.stream.JsonReader.syntaxError"], "invalid_mod": ["is missing mods.toml"], "json": ["MalformedJsonException", "JsonSyntaxException"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `1lnn8rT` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["ignoreError", "java.lang.ClassNotFoundException", "NO_ERROR", "java.io.UncheckedIOException", "java.nio.file.AccessDeniedException", "net.minecraft.SystemReport.ignoreError", "sun.nio.fs.UnixException.translateToIOException", "UnixException"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `gtNpaS6` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["java.lang.reflect.InvocationTargetException", "java.lang.RuntimeException", "java.lang.NoClassDefFoundError", "java.lang.ClassNotFoundException"], "dep": ["Missing or unsupported mandatory dependencies"], "invalid_mod": ["is missing mods.toml"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `lPvo516` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["datapackloaderror", "LIBGL_NOERROR", "glGetError", "GL_NOERROR", "java.lang.reflect.InvocationTargetException", "java.lang.NoClassDefFoundError", "java.lang.ClassNotFoundException"], "dep": ["Missing or unsupported mandatory dependencies"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `eSqogAe` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["LIBGL_NOERROR", "glGetError", "GL_NOERROR", "java.lang.ClassNotFoundException", "java.lang.RuntimeException", "net.fabricmc.loader.impl.util.ExceptionUtil.gatherException", "java.lang.NoClassDefFoundError"], "mixin_target": ["io.vram.frex.base.renderer.context.render.EntityBlockRenderContext"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `EWsoyiy` — overall 56

- 维度：工具 100 / 证据 20 / 清晰 70
- 过程：1 轮 / 0 次工具调用 / 模式 deep
- 既有根因判断：
- 日志信号：`{"exception": ["ignoreError", "noexception", "NO_ERROR", "java.lang.ClassNotFoundException", "java.lang.IllegalStateException", "com.mojang.blaze3d.systems.RenderSystem.constructThreadException", "java.lang.RuntimeException", "org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError"], "mixin_target": ["xfacthd.framedblocks.common.blockentity.doubled.slab.FramedAdjustableDoubleBlockEntity", "net.irisshaders.iris.pipeline.PipelineManager", "net.minecraft.client.gui.screens.controls.KeyBindsList$KeyEntry", "com.kipti.bnb.content.kinetics.cogwheel_chain.graph.CogwheelChain", "com.kipti.bnb.content.kinetics.cogwheel_chain.graph.PlacingCogwheelChain", "com.kipti.bnb.network.packets.from_client.PlaceCogwheelChainPacket", "com.kipti.bnb.content.kinetics.cogwheel_chain.behaviour.CogwheelChainBehaviour", "com.kipti.bnb.content.kinetics.cogwheel_chain.graph.CogwheelChainCandidate"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

## 高分样本（防回退）（6 条）

### `DT6nkRD` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：4 轮 / 3 次工具调用 / 模式 deep
- 既有根因判断：整合包'月亮工厂MCF'内置的 Fabric Loader 0.14.22 / Fabric API 0.76.1 / Porting Lib 2.1.1096 版本过旧，无法满足 Sophisticated Backpacks 3.20.2.22 与 Sophisticated Core 0.6.4.30 声明的硬依赖（fabricloader>=0.15.7、fabric-api>=0.77.
- 日志信号：`{"exception": ["LIBGL_NOERROR", "glGetError", "GL_NOERROR", "net.fabricmc.loader.impl.FormattedException", "FormattedException", "net.fabricmc.loader.impl.gui.FabricGuiEntry.displayError"], "dep": ["HARD_DEP_NO_CANDIDATE", "HARD_DEP", "Mod resolution failed"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `9BBGhCT` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：4 轮 / 3 次工具调用 / 模式 deep
- 既有根因判断：游戏进程以退出码 1（Java 层面异常）结束，但 launcher_log.txt 仅含启动器外壳信息，缺少 Minecraft 本体日志与异常栈，具体根因无法定位
- 日志信号：`{}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `kAkopdW` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：4 轮 / 3 次工具调用 / 模式 deep
- 既有根因判断：Fabric 模组依赖解析失败：donutmaparts 0.4.0+1.21.11 要求 fabricloader >= 0.19.0（实际 0.18.6），且 c2me-opts-natives-math 要求 Java >= 22（实际 Java 21），两条硬依赖均不满足导致启动被拦截。
- 日志信号：`{"exception": ["net.fabricmc.loader.impl.FormattedException", "FormattedException"], "dep": ["HARD_DEP_NO_CANDIDATE", "HARD_DEP", "Mod resolution failed"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `A0PHdjV` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：4 轮 / 5 次工具调用 / 模式 deep
- 既有根因判断：存档中 (-559,66,102) 处 torcherino:double_compressed_lantern 方块上残留了 swinginglanterns 的 SwingingLanternBlockEntity，Torcherino tick 逻辑无条件强转该实体为 TorcherinoBlockEntity 触发 ClassCastException，属方块与方块实体错位导致的存档级崩溃
- 日志信号：`{"exception": ["java.lang.ClassCastException"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `cpD4znH` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：4 轮 / 3 次工具调用 / 模式 deep
- 既有根因判断：Fabric 强制依赖缺失：Inventory Profiles Next 2.2.6 需要的 libipn(6.6.3~6.7) 与 fabric-language-kotlin(>=1.13.10+kotlin.2.3.20) 均未安装，导致模组解析在启动前失败。
- 日志信号：`{"exception": ["ignoreError", "net.fabricmc.loader.impl.FormattedException", "FormattedException", "net.fabricmc.loader.impl.gui.FabricGuiEntry.displayError"], "dep": ["HARD_DEP_NO_CANDIDATE", "HARD_DEP", "Mod resolution failed"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

### `t6AgQZf` — overall 98

- 维度：工具 100 / 证据 95 / 清晰 100
- 过程：3 轮 / 3 次工具调用 / 模式 deep
- 既有根因判断：wurst_i18n_plus_plugin（Wurst 汉化插件）在未安装 Wurst Client 本体的环境下被加载，其 client 入口类构造时引用 net.wurstclient.hack.Hack 类失败（NoClassDefFoundError），导致游戏启动阶段崩溃
- 日志信号：`{"exception": ["com_google_errorprone_error", "java.lang.ClassNotFoundException", "java.lang.IllegalStateException", "java.lang.RuntimeException", "net.fabricmc.loader.impl.util.ExceptionUtil.gatherException", "net.fabricmc.loader.api.EntrypointException", "net.fabricmc.loader.api.LanguageAdapterException", "java.lang.reflect.InvocationTargetException"], "mixin_target": ["baritone.command.defaults.ComeCommand", "net.wurstclient.hack.Hack", "net.wurstclient.WurstTranslator", "net.wurstclient.settings.Setting"]}`

**复核项**：
- [ ] 根因判断是否正确？
- [ ] 若不正确 → 真缺陷，填写 `expect.keywords`（应出现）与 `must_not_contain`（不应出现）
- [ ] 若正确但分数低 → 评分误判，在 `notes` 说明
- [ ] 填写 `expect.category`（问题分类）

