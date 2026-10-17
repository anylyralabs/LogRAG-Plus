# OpenGL 帧缓冲创建失败（FBO 状态检查不通过）

## 签名 (Signature)

**创建带模板缓冲（stencil）的离屏帧缓冲后状态检查返回不完整（实测最高频）**

```
[Render thread/ERROR]: Unreported exception thrown!
java.lang.RuntimeException: GL_FRAMEBUFFER_UNSUPPORTED
	at com.mojang.blaze3d.pipeline.RenderTarget.m_83949_(RenderTarget.java:170)
	at com.mojang.blaze3d.pipeline.RenderTarget.m_83950_(RenderTarget.java:140)
	at com.mojang.blaze3d.pipeline.RenderTarget.m_83964_(RenderTarget.java:64)
	at com.mojang.blaze3d.pipeline.RenderTarget.m_83941_(RenderTarget.java:52)
	at com.mojang.blaze3d.pipeline.RenderTarget.enableStencil(RenderTarget.java:317)
	at net.createmod.catnip.platform.ForgeClientHooksHelper.enableStencilBuffer(ForgeClientHooksHelper.java:85)
	at net.createmod.catnip.gui.UIRenderHelper$CustomRenderTarget.create(UIRenderHelper.java:390)
	at net.createmod.catnip.gui.UIRenderHelper.lambda$init$0(UIRenderHelper.java:68)
```

**同一故障在 MC 1.21.1 上的栈形态（`createBuffers` / `_resize` / `checkStatus`）**

```
java.lang.RuntimeException: GL_FRAMEBUFFER_UNSUPPORTED
	at com.mojang.blaze3d.pipeline.RenderTarget.checkStatus(RenderTarget.java:167)
	at com.mojang.blaze3d.pipeline.RenderTarget.createBuffers(RenderTarget.java:131)
	at com.mojang.blaze3d.pipeline.RenderTarget._resize(RenderTarget.java:56)
	at com.mojang.blaze3d.pipeline.RenderTarget.resize(RenderTarget.java:45)
	at com.mojang.blaze3d.pipeline.RenderTarget.enableStencil(RenderTarget.java:284)
	at net.createmod.catnip.platform.NeoForgeClientHooksHelper.enableStencilBuffer(NeoForgeClientHooksHelper.java:86)
	at net.createmod.catnip.gui.UIRenderHelper$CustomRenderTarget.create(UIRenderHelper.java:388)
	at com.mojang.blaze3d.systems.RenderSystem.replayQueue(RenderSystem.java:153)
```

**同一故障在 MC 1.20.1 / 1.16.5 上的混淆名栈形态（`Framebuffer.checkFramebufferStatus` / `initFbo`）**

```
java.lang.RuntimeException: GL_FRAMEBUFFER_UNSUPPORTED
	at net.minecraft.client.gl.Framebuffer.checkFramebufferStatus(Framebuffer.java:176)
	at net.minecraft.client.gl.Framebuffer.initFbo(Framebuffer.java:147)
	at net.minecraft.client.gl.Framebuffer.resizeInternal(Framebuffer.java:70)
	at net.minecraft.client.gl.Framebuffer.resize(Framebuffer.java:59)
	at net.minecraft.client.gl.Framebuffer.enableStencil(Framebuffer.java:1105)
	at knot//net.createmod.catnip.platform.FabricClientHooksHelper.enableStencilBuffer(FabricClientHooksHelper.java:73)
	at knot//net.createmod.catnip.gui.UIRenderHelper$CustomRenderTarget.create(UIRenderHelper.java:390)
```

**另一个高频触发者（TACZ 第一人称持枪渲染）**

```
java.lang.RuntimeException: GL_FRAMEBUFFER_UNSUPPORTED
	at net.minecraft.client.gl.Framebuffer.checkFramebufferStatus(Framebuffer.java:176)
	at net.minecraft.client.gl.Framebuffer.initFbo(Framebuffer.java:147)
	at net.minecraft.client.gl.Framebuffer.resizeInternal(Framebuffer.java:70)
	at net.minecraft.client.gl.Framebuffer.resize(Framebuffer.java:59)
	at net.minecraft.client.gl.Framebuffer.tacz$enableStencil(Framebuffer.java:2551)
	at com.tacz.guns.util.RenderHelper.enableItemEntityStencilTest(RenderHelper.java:62)
	at com.tacz.guns.client.model.BedrockGunModel.lambda$render$28(BedrockGunModel.java:297)
```

**状态码被原样上报为十进制数字的形态**

```
java.lang.RuntimeException: glCheckFramebufferStatus returned unknown status:36061
	at net.minecraft.client.shader.Framebuffer.func_147611_b(Framebuffer.java:172)
	at net.minecraft.client.shader.Framebuffer.func_216492_b(Framebuffer.java:143)
	at net.minecraft.client.shader.Framebuffer.enableStencil(Framebuffer.java:307)
	at com.simibubi.create.foundation.gui.UIRenderHelper.createFramebuffer(UIRenderHelper.java:48)
	at com.simibubi.create.foundation.gui.UIRenderHelper.lambda$init$0(UIRenderHelper.java:40)
	at com.mojang.blaze3d.systems.RenderSystem.replayQueue(SourceFile:116)
```

`36061` = `0x8CDD` = `GL_FRAMEBUFFER_UNSUPPORTED`，与上一类是同一种失败，只是调用方把枚举名换成了数字（1.16.5 的 Create 用 `glCheckFramebufferStatus` 原值上报）。

**同一故障的另外两个枚举形态（实测较少，且主要出现在 1.21.2 以后的新渲染管线与第三方 FBO 封装里）**

```
java.lang.RuntimeException: GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT
java.lang.IllegalStateException: Advanced FBO status did not return GL_FRAMEBUFFER_COMPLETE. GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT
```

**渲染器自陈的 FBO 挂钩清单（出现频率高，但单独出现不代表故障）**

```
LTW: Overridden glBindFramebuffer
LTW: Overridden glDeleteFramebuffers
LTW: Overridden glGenFramebuffers
LTW: Overridden glCheckFramebufferStatus
LTW: Overridden glFramebufferTexture2D
LTW: Overridden glFramebufferRenderbuffer
```

## 含义

Minecraft 的 `Framebuffer` / `RenderTarget` 在创建离屏帧缓冲时，先挂上颜色附件、深度附件与可选的模板（stencil）附件，然后用 `glCheckFramebufferStatus` 检查这一组附件是否**完整可用**。只要返回值不等于 `GL_FRAMEBUFFER_COMPLETE`（`0x8CD5`），构造流程就抛 `RuntimeException`，且这是**构造期的致命异常**：帧缓冲拿不到，后续每一帧渲染都会再次进入同一条失败路径，游戏无法继续。

各状态码的语义（Khronos `glCheckFramebufferStatus` 定义）：

| 状态码 | 十进制 | 含义 |
|---|---|---|
| `GL_FRAMEBUFFER_UNSUPPORTED` | 36061 | 当前 GL 实现**不支持**这组附件格式的组合 |
| `GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT` | 36054 | 某个附件点没有绑定完整（尺寸为 0、格式无效等） |
| `GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT` | 36055 | 完全没有绑定任何图像 |
| `GL_FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER` | 36059 | 绘制缓冲未绑定 |
| `GL_FRAMEBUFFER_UNDEFINED` | 33107 | 默认帧缓冲未定义 |

本类故障在移动端的**根因位置与 PC 不同**：

- **PC**：驱动直接实现 OpenGL，`GL_DEPTH24_STENCIL8` 与 `GL_DEPTH_STENCIL_ATTACHMENT` 组合几乎总是可用，出现 `GL_FRAMEBUFFER_UNSUPPORTED` 说明这是一台受限设备或驱动过旧。
- **移动端**：Android 只有 OpenGL ES，模板缓冲要由转译层（Krypton Wrapper / gl4es 系 / MobileGlues / ANGLE 等）从桌面 GL 语义**映射**到 GLES 的附件组合上。GLES 2.0 的 `GL_DEPTH_STENCIL_OES` 与 GLES 3.x 的 `GL_DEPTH24_STENCIL8` 支持面不同，转译层映射不出来就返回 `GL_FRAMEBUFFER_UNSUPPORTED`。**此时报错的模组没有问题，问题在渲染器的 FBO 特性覆盖面上。**

实测的渲染器与设备分布（800 篇抽样日志中命中 `GL_FRAMEBUFFER_UNSUPPORTED` 的 13 篇）：

| 维度 | 实测结果 |
|---|---|
| 渲染器 | `Krypton Wrapper` 13/13（100%） |
| GPU 厂商 | 全部为 ARM Mali |
| 具体型号 | Mali-G57 MC2 / MC3、Mali-G77 MC9、Mali-G610、Mali-G720 MC7、Mali-G925-Immortalis MC12 |
| MC 版本 | 1.20.1（多数）、1.21.1 |
| 触发方 | Create / Ponder 界面渲染器、TACZ 持枪渲染 |

对应的 `Renderer: Krypton Wrapper` 行与 `GL info: Mali-…` 行在崩溃日志里都可直接读到，所以渲染器归因在日志里是可判定的。

本类故障与另一类「原生库符号解析失败」无关，也不会出现在 `hs_err_pid*.log` 里——它是**正常的 Java 异常**，堆栈完整、退出码非 134/139。

## 常见触发

### 触发 A：Create / Ponder 的界面渲染器申请模板缓冲

Create 与它的前置库 Ponder 共用的 `net.createmod.catnip.gui.UIRenderHelper` 在初始化一个自定义渲染目标时，调用 `enableStencilBuffer` 给离屏 FBO 加上模板附件，用于给物品栏与蓝图界面做遮挡裁剪。

典型特征：栈里出现 `net.createmod.catnip.gui.UIRenderHelper$CustomRenderTarget.create` → `ForgeClientHooksHelper.enableStencilBuffer` / `FabricClientHooksHelper.enableStencilBuffer` / `NeoForgeClientHooksHelper.enableStencilBuffer` → `RenderTarget.enableStencil`，最后落在 `glCheckFramebufferStatus`。触发时机是**主界面加载或打开某个界面后第一次 `flipFrame`**，所以崩溃报告里的 `Description:` 多为 `Unexpected error` 或 `Initializing game`。

实测：触发方是 Create / Ponder 时，崩溃报告时间戳紧跟 `Reloading ResourceManager: … mod/create, mod/ponder …` 之后，崩溃报告的 `//` 注释行随日志美学随机（`// But it works on my machine.`、`// Surprise! Haha. Well, this is awkward.`、`// Would you like a cupcake?` 都在同一故障的不同日志里出现过，不能据它判断故障类型）。

### 触发 B：TACZ 第一人称持枪渲染申请模板缓冲

TACZ（Timeless and Classics Zero Guns）给枪械模型做描边与镜筒透视时，通过 Fabric/Mixin 注入的 `Framebuffer.tacz$enableStencil` 调用 `enableStencil`，再走 `RenderHelper.enableItemEntityStencilTest`。

典型特征：栈顶是 `com.tacz.guns.util.RenderHelper.enableItemEntityStencilTest` → `BedrockGunModel` / `BedrockAttachmentModel`，`Description:` 多为 `Rendering entity in world`——即**只有渲染到手部物品时才崩**，主界面可以正常进。

实测：TACZ 的扩建包（如 `TACZ-Refabricated`、`tacz-1.20.1-1.1.8-hotfix2`）与 Create 同时安装时，两者都能独立触发本故障，日志里先出现哪一个取决于资源加载与渲染的先后顺序。

### 触发 C：其它模组的离屏 FBO（新渲染管线与第三方 FBO 封装）

1.21.2 起 MC 把帧缓冲抽象为 `com.mojang.blaze3d.pipeline.RenderTarget`，异常文案也扩展到了 `GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`：第三方 FBO 封装（如 Veil 的 Advanced FBO、ModularUI / Immersive Engineering 的离屏缓冲）在 gl4es 一类的低版本转译层下会返回 `Advanced FBO status did not return GL_FRAMEBUFFER_COMPLETE. GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`。

典型特征：异常类为 `java.lang.IllegalStateException`（不是 `RuntimeException`），消息里带 `Advanced FBO status did not return GL_FRAMEBUFFER_COMPLETE`。这类形态在随机抽样的 800 篇日志中未直接出现（0/800），只在历史分析记录中出现，属**同一故障的低频形态**；判断依据与触发 A/B 相同——看渲染器与请求模板缓冲的调用方。

### 触发 D：状态码以十进制数字上报

1.16.5 的 Create 用 `glCheckFramebufferStatus` 的原始返回值拼接异常消息，所以只出现 `glCheckFramebufferStatus returned unknown status:36061`，看不到枚举名。

典型特征：消息里只有一个整数。**必须自己把数字查回枚举名再判断**：`36061` = `GL_FRAMEBUFFER_UNSUPPORTED`、`36054` = `GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`、`36053` = `GL_FRAMEBUFFER_COMPLETE`（后者若被当成失败上报，说明调用方的后续判断写错了）。实测该形态伴随 `mixins.oculus.json:MixinRenderTarget` 出现在栈的 `pl:mixin` 列表中，即 Oculus 光影前置也在改这个类。

## 修复步骤

**触发的共同前提：模板缓冲是渲染器提供的，不是模组提供的。** 所以第一动作永远是换渲染器，而不是删模组。

1. **换渲染器**（首选，实测唯一在多数设备上有效的动作）：从 Krypton Wrapper 换到 MobileGlues、Holy-GL4ES、ANGLE 或 Zink/Turnip 中的另一个，再启动一次。同一 MC 版本、同一模组组合下，不同渲染器对 `GL_DEPTH_STENCIL_ATTACHMENT` 的映射覆盖面不同。
2. **更新该渲染器到最新发布**：FBO/模板附件映射属渲染器侧能力，修复只会随渲染器版本发布，更新 MC 或更新模组都无效。
3. **降级渲染器的目标 GL 版本**：渲染器设置里存在 `customGLVersion` 一类开关时，把它从 4.x 降到 3.2 再试；模板缓冲在 GLES 3.x 路径上的实现通常比 GLES 2.0 模拟路径完整。
4. **移除或降级申请模板缓冲的模组**：只装 Create/Ponder 时装回原版资源包启动（触发 A）；只装 TACZ 时把枪械放到副手或换一个不含描边渲染的版本（触发 B）。这是渲染器无解时的兜底，代价是丢掉对应功能。
5. **降到渲染器已验证的 MC 版本**：全部渲染器都返回 `GL_FRAMEBUFFER_UNSUPPORTED` 时，说明该 MC 版本的渲染管线要求超出设备能力，只能降版本。

**不要做的事**

- 不要加内存、改 JVM 参数、换 Java 版本：异常发生在 GL 状态检查，与堆大小和 JVM 无关。
- 不要换资源包或光影包：本故障的附件组合由渲染器决定，与包内容无关（唯一例外是 Oculus 光影前置参与改 `RenderTarget` 时，关光影可以作为二次验证）。
- 不要照抄崩溃报告里的 `//` 注释行或 `UUID` 作为线索，它们在该故障中是随机文本。

## 置信度线索

- **确定（本类故障）**：日志含 `java.lang.RuntimeException: GL_FRAMEBUFFER_UNSUPPORTED`、`glCheckFramebufferStatus returned unknown status:<十进制>`（把数字换算成枚举名后属 `GL_FRAMEBUFFER_*`）、或 `Advanced FBO status did not return GL_FRAMEBUFFER_COMPLETE` 之一。
- **确定（渲染器侧，非模组侧）**：同一异常堆栈中 `enableStencil` / `enableStencilBuffer` 的上一层是 `glCheckFramebufferStatus`，且日志开头 `Renderer:` 行为转译层名称（实测 13/13 为 Krypton Wrapper）。此时**不要**把根因写成「Create / TACZ 模组损坏」。
- **确定（触发方）**：栈中出现 `net.createmod.catnip.gui.UIRenderHelper` ⇒ Create/Ponder；出现 `com.tacz.guns.util.RenderHelper` 或 `tacz$enableStencil` ⇒ TACZ。
- **确定（设备分布）**：实测命中该签名的日志 GPU 全部为 ARM Mali（Mali-G57 / G77 / G610 / G720 / G925-Immortalis）。Mali 设备上该故障的基数最大。
- **注意（频率）**：在 800 篇抽样日志中出现 13 篇（约 1.6%），在 6484 条历史分析记录中出现 170 条；它属于**常见但非最高频**的移动端图形故障，与「着色器编译失败」并列出现时需分别归因（前者是编译，后者是附件组合）。
- **注意（易混淆项）**：`LTW: Overridden glCheckFramebufferStatus` 是 LTW 渲染器启动时打印的挂钩清单（它一次打印十余行 `LTW: Overridden gl<函数名>`），**单独出现不构成故障**；只有同一日志里另有 `GL_FRAMEBUFFER_*` 异常时才算命中。
- **注意（枚举差异）**：`GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT`（36054）与 `GL_FRAMEBUFFER_UNSUPPORTED`（36061）都归入本类，但它们指向不同细节——前者是附件没绑好（尺寸/格式无效），后者是组合不被支持。修复动作相同（换渲染器），但如果是模组自己创建的 FBO 尺寸为 0，换渲染器无效。
- **需追问**：日志未给出 `Renderer:` 行与 MC 版本时，应先向用户确认这两项——它们决定了是「渲染器 FBO 覆盖面」还是「模组自建 FBO 参数」问题。
