# GL 上下文缺失（No context is current 与相关致命/可捕获形态）

## 签名 (Signature)

**致命形态（原生层直接中止 JVM，桌面端与移动端都会出现）**

```
FATAL ERROR in native method: Thread[#3,Render thread,5,main]: No context is current or a function that is not available in the current context was called. The JVM will abort execution.
	at org.lwjgl.opengl.GL30C.nglGenFramebuffers(Native Method)
	at org.lwjgl.opengl.GL30C.glGenFramebuffers(GL30C.java:989)
	at yun.shan.musicplayer.render.GlFbo.<init>(GlFbo.java:62)
	at yun.shan.musicplayer.render.PostProcessing.warmup(PostProcessing.java:28)
	at yun.shan.musicplayer.Musicplayer.lambda$onInitializeClient$0(Musicplayer.java:29)
```

```
FATAL ERROR in native method: [LWJGL] Thread[#107,Render thread,5,main]: No context is current or a function that is not available in the current context was called. The JVM will abort execution.
	at org.lwjgl.opengl.GL30C.nglGenFramebuffers(Native Method)
	at com.mojang.renderpearl.backend.opengl.DirectStateAccess$Emulated.createFrameBufferObject(DirectStateAccess.java:213)
```

```
FATAL ERROR in native method: Thread[#3,Render thread,10,main]: No context is current or a function that is not available in the current context was called. The JVM will abort execution.
	at org.lwjgl.opengl.GL11C.glViewport(Native Method)
	at net.minecraft.client.Minecraft.handler$egd001$super_resolution$onRenderBegin(Minecraft.java:19230)
```

**移动端提示形态（同一根因，移动端启动器的 LWJGL 只打印提示、不中止 JVM）**

```
Thread[#3,Render thread,5,main]: No context is current or a function that is not available in the current context was called. Are you running essential and/or <1.13?
Thread[#42,fml-loadingscreen,5,fml-loadingscreen]: No context is current or a function that is not available in the current context was called. Are you running essential and/or <1.13?
Thread[#32,EarlyDisplay,5,main]: No context is current or a function that is not available in the current context was called. Are you running essential and/or <1.13?
```

**LWJGL 自检路径上的可捕获形态（抛 Java 异常而非中止 JVM）**

```
java.lang.IllegalStateException: No GLCapabilities instance set for the current thread. Possible solutions:
	a) Call GL.createCapabilities() after making a context current in the current thread.
	b) Call GL.setCapabilities() if a GLCapabilities instance already exists for the current context.
	at knot//org.lwjgl.opengl.GL.checkCapabilities(GL.java:288)
	at knot//org.lwjgl.opengl.GL.getCapabilities(GL.java:283)
```

```
java.lang.IllegalStateException: There is no OpenGL context current in the current thread.
	at org.lwjgl.opengl.GL.createCapabilities(GL.java:404)
	at net.minecraft.client.util.Window.<init>(Window.java:113)
```

**渲染后端创建失败（上下文从未建立，是上一类的上游原因）**

```
[Render thread/ERROR]: Failed to create backend OpenGL
com.mojang.renderpearl.api.device.BackendCreationException: glGetError mismatch
	at com.mojang.renderpearl.backend.opengl.GlBackend.loadLibrary(GlBackend.java:40)
	at net.minecraft.client.Minecraft.<init>(Minecraft.java:530)
```

```
[Render thread/ERROR]: Failed to create backend OpenGL: com.mojang.renderpearl.api.device.BackendCreationException: OpenGL is not supported
com.mojang.blaze3d.systems.BackendCreationException: VK_ERROR_INITIALIZATION_FAILED: Failed to get number of physical devices
	at com.mojang.blaze3d.vulkan.VulkanBackend.findPhysicalDevice(VulkanBackend.java:214)
```

## 含义

OpenGL 的「当前上下文」是**线程局部状态**：一个线程必须先把自己的 GL 上下文设为 current，才能调用任何 GL 函数。LWJGL 的绑定层在调用前不做检查，直接把调用转发到原生函数表——当前线程没有 current 上下文时，这个非法调用被原生层捕获，打印 `FATAL ERROR in native method` 并**直接中止 JVM**。这个中止**不是 Java 异常**，`try/catch` 抓不到，也不会生成带堆栈的 `/crash-reports/` 条目，只留下 `hs_err_pid<数字>.log` 或标准输出里的几行。

因此本类故障的三种形态的区别只是「谁在检查」：

| 形态 | 检查者 | 结果 |
|---|---|---|
| `FATAL ERROR … The JVM will abort execution.` | 原生 GL 函数表 | JVM 立刻中止（退出码 134/1） |
| `… Are you running essential and/or <1.13?` | 移动端启动器打补丁后的 LWJGL | 只打印提示，不中止 JVM（但上下文确实不可用，启动仍会以别的形态失败） |
| `IllegalStateException: No GLCapabilities instance set…` / `There is no OpenGL context current…` | LWJGL 的 Java 层自检 | 抛 Java 异常，可被捕获，堆栈完整 |

提示文案里的 `essential` 与 `<1.13` 是在指认两类已知的乱调 GL 来源：闭源的 Essential 模组，以及 1.13 之前 Mojang 尚未把 GL 调用集中到渲染线程时期的代码风格。**这是线索，不是限定条件**——实测在 26.x 上触发的日志同样打出这句提示。

本类故障在 **MC 26.2 之后**变得显著：26.2 把渲染后端抽象为可插拔实现（`com.mojang.renderpearl` 体系，含 Vulkan 后端），Fabric 与 Mojang 都要求模组把裸 GL 调用迁移到新的后端 API。没有迁移的模组在 Vulkan 后端下继续调用 `GlStateManager` 或 LWJGL 的 `GL11C` / `GL30C`，调用的目标后端里根本没有 GL 上下文，于是直接踩中止路径。

## 常见触发

### 触发 A：Vulkan 后端下模组仍调用 OpenGL 接口

MC 26.2 起可以选择图形后端。选到 Vulkan 后，任何仍走 OpenGL 状态管理的模组都会在本类故障的致命形态上中止。

典型特征：日志里有明确的后端选择行（`Using graphics backend Vulkan`）或 `com.mojang.renderpearl.backend.vulkan.*` 日志前缀，随后是 `FATAL ERROR in native method` + `GL11C.glEnable` / `GL11C.glGetError` 一类原生帧。实测触发方为 `magiclib` 封装下的 `com.plusls.ommc` 与 Essential，退出的位置都在 `Render thread`。

### 触发 B：非渲染线程调用 GL

GL 上下文只在渲染线程 current，其它线程（`Server thread`、`Client thread`、`pool-N-thread-M`、`Thread-#N` 池线程）调用 GL 必然命中。

典型特征：中止行的线程名不是 `Render thread`。实测案例是 Wakes 模组在 **Server thread** 里创建动态纹理（`com.goby56.wakes.render.BetterDynamicTexture.createTexture` → `GL11C.glGetError`），以及老版本代码在 Client thread 上调用。

### 触发 C：渲染后端创建失败后，后续代码仍无条件调用 GL

这是触发 A 的上游：后端本身没建起来，之后任何 GL 调用都无上下文。

典型特征：先出现 `[Render thread/ERROR]: Failed to create backend OpenGL` 与 `BackendCreationException: glGetError mismatch`（RenderPearl 的 OpenGL 后端在 `GlBackend.loadLibrary` 阶段检测到 GL 错误）或 `BackendCreationException: VK_ERROR_INITIALIZATION_FAILED: Failed to get number of physical devices`（Vulkan 后端枚举不到设备），**随后**才出现 `No context is current`。实测在这种日志里，最后踩中止的是 Iris 的初始化（`net.irisshaders.iris.gl.sampler.SamplerLimits` → `GL11C.nglGetIntegerv` → `Iris.duringRenderSystemInit`）或光影/超分模组。

判断要点：`BackendCreationException` 出现的行号一定在 `No context is current` 之前。**根因是后端创建失败，不是调 GL 的那个模组。**

### 触发 D：启动初始化时序——上下文尚未建立就建 FBO / 查询能力

模组在客户端的早期生命周期钩子里（`onClientStarted`、`ClientLifecycleEvents`、`RenderSystem.duringRenderSystemInit`）创建帧缓冲或查询 GL 能力，此时渲染线程还没有 current 上下文。

典型特征：`Description:` 为空（不是崩溃报告，是 JVM 中止），栈顶是模组自己的类，且调用方是 `lambda$onInitializeClient$0` / `handler$<随机标记>$<模组名>$onRenderBegin` 这类 Mixin 注入点。实测案例：`yun.shan.musicplayer` 在 `onClientStarted` 里建 FBO；OptiCores 在 Sodium 后端下调用 `glFenceSync`；mobius 的 `SeedGenGpu` 在 tick 里调 `glGetString`。

### 触发 E：移动端渲染器未建立有效上下文（打印提示而非中止，但启动仍然失败）

移动端转译层在加载屏阶段还没把 GLES 上下文接管好时，FML 的加载屏与早期显示线程会重复打印提示行，JVM 不中止，紧接着以另一种形态失败。

典型特征：提示行成片重复（实测同一日志内 2～10 行），线程名为 `fml-loadingscreen` / `EarlyDisplay` / `Render thread`，紧邻的 `GL info:` 行显示渲染器为 `Krypton Wrapper Release 0.4.5` 或 `gl4es wrapper 1.1.5`，GPU 为 Mali-G57 MC2。

实测 5 篇命中该后缀的日志（全部来自移动端启动器，渲染器 Krypton Wrapper 4 篇 / Holy-GL4ES 1 篇）**全部在提示之后启动失败**，只是失败形态分成两类：

| 后续形态 | 日志特征 | 退出码 | 篇数 |
|---|---|---|---|
| 加载屏着色器初始化失败 | `[main/ERROR]: Missing uniform 'tex' in shader 'gui'` | 1 | 2 |
| Iris 能力探测被可捕获异常打断 | `ExceptionInInitializerError` ← `IllegalStateException: No GLCapabilities instance set for the current thread` ← `GL.checkCapabilities` ← `IrisRenderSystem.supportsSSBO` ← `Iris.duringRenderSystemInit` | -1 | 2 |
| 缓冲映射失败 | `java.lang.IllegalStateException: Can't map buffer, opengl error 0` ← `com.mojang.blaze3d.opengl.BufferStorage$Mutable.mapBuffer` | -1 | 1 |

也就是说：**带后缀的提示行本身不中止 JVM，但它意味着上下文确实没有建立，后续必然以某种形态失败**；把这类日志判成「启动正常、只是有警告」是错的。

## 修复步骤

**触发 A（Vulkan 后端 vs 未迁移模组）**

1. 把图形后端切回 OpenGL：MC 26.2+ 的 `--graphicsBackend` 启动参数或启动器的「图形后端」选项里选 OpenGL。
2. 无法切回时（设备只支持 Vulkan 路径），逐个禁用模组定位：优先怀疑仍在用 `GlStateManager` 的老模组与闭源的 Essential。
3. 该模组未经迁移就无解，只能等作者适配或换替代品；**不要试图用 JVM 参数解决**。

**触发 B（非渲染线程调 GL）**

1. 这是模组的线程模型缺陷，没有配置性修复：更新该模组到已修复的版本，或移除。
2. 定位方法是从中止行的线程名读出「谁是错误的调用者」，再看栈顶属于哪个模组。

**触发 C（后端创建失败）**

1. 先把 `BackendCreationException` 解决掉：`glGetError mismatch` 是 OpenGL 后端初始化时检测到 GL 错误，换渲染器（Krypton Wrapper → MobileGlues → Holy-GL4ES → ANGLE）或更新渲染器版本后重试；`VK_ERROR_INITIALIZATION_FAILED: Failed to get number of physical devices` 是 Vulkan 层枚举不到可用设备，改用 OpenGL 后端。
2. 后端建起来之后，紧随其后的 `No context is current` 与 Iris/光影相关的中止会自动消失——**不要先去改 Iris 或光影包**。
3. 混合显卡桌面环境（NVIDIA 独显 + AMD/Intel 核显、Wayland 回退 XWayland）也会导致 OpenGL 后端创建失败，此时改用 Vulkan 后端或显式指定使用哪块 GPU。

**触发 D（初始化时序）**

1. 更新该模组；确认该模组是否有「延迟初始化 / 关闭预热」一类开关，打开后重试。
2. 无开关则移除该模组——在上下文建立前建 FBO 属于硬编码时序错误。

**触发 E（移动端提示形态）**

1. 不要按「警告可忽略」处理：命中该后缀的实测日志全部随后启动失败。按图形故障处理——换渲染器（Krypton Wrapper → MobileGlues / Holy-GL4ES / ANGLE）、更新渲染器版本。
2. 若后续失败是 `Missing uniform 'tex' in shader 'gui'`，说明加载屏着色器在无可用上下文下初始化失败；若后续失败是 Iris 的 `No GLCapabilities instance set for the current thread`，根因同样是上下文没建立，**不要去删 Iris 或光影包**。
3. MC 1.21.9 起要求 OpenGL 3.3，而 Krypton Wrapper 一类包装层只上报 OpenGL 3.1；在这种组合下换到能上报 3.3+ 的渲染器，或把 MC 降到渲染器能力覆盖范围内的版本。

## 置信度线索

- **确定（致命形态）**：日志含 `FATAL ERROR in native method:` + `No context is current or a function that is not available in the current context was called. The JVM will abort execution.`。该形态**没有 Java 堆栈**，只有原生帧（`at org.lwjgl.opengl.GLxxC.ngl<函数名>(Native Method)`），退出码为 134 或 1。
- **确定（移动端提示形态）**：同一句话带 `Are you running essential and/or <1.13?` 后缀。该后缀只出现在移动端启动器（PojavLauncher 系）的日志里，因为它们的 LWJGL 构建把中止改成了打印提示；根因与致命形态完全相同，实测 5/5 篇随后仍以 `Missing uniform 'tex' in shader 'gui'`、`No GLCapabilities instance set for the current thread` 或 `Can't map buffer, opengl error 0` 失败，**不能当成可忽略的警告**。
- **确定（后端缺失为上游）**：`[Render thread/ERROR]: Failed to create backend OpenGL` / `BackendCreationException` 的行号早于 `No context is current`。此时根因写后端创建失败，不要写「Iris 崩溃」或「光影崩溃」。
- **确定（初始化时序）**：中止行的线程名是 `Render thread`，但栈顶是模组的客户端初始化回调（`onInitializeClient` / `onClientStarted` / `onRenderBegin`），且 `Description:` 段缺失。
- **注意（频率）**：800 篇抽样日志中 8 篇（1.0%）含 `No context is current`（5 篇移动端、3 篇桌面端）；6484 条历史分析记录中 32 条，其中 `The JVM will abort execution` 3 条。它属于**低频但一旦出现即中断启动/游戏**的故障，优先级高。
- **注意（易混淆项）**：`com.mojang.renderpearl.api.device.GpuDeviceLossException: VK_ERROR_DEVICE_LOST: Failed to wait for semaphore` 是 Vulkan 设备（驱动）掉线，属另一类故障，与本类无关；不要因为都含 "device" 就并为一体。
- **注意（易混淆项）**：`No GLCapabilities instance set for the current thread` 与 `There is no OpenGL context current in the current thread` 是同一根因的**可捕获**版本，会出现在 `/crash-reports/` 里（因为它们是 Java 异常）。看到它们时同样先查上游的渲染后端创建是否成功。
- **需追问**：日志未给出图形后端（Vulkan / OpenGL）与模组列表时，应先向用户确认这两项——后端决定是否为「未迁移模组」问题，模组列表决定是哪一个调用者。
