# 实战案例：渲染器与光影（MC 26.3 的 SDL3 迁移为重点）

本条汇集 logshare.cn 生产 AI 分析记录中**已核实**的渲染器 / 光影故障。渲染器问题在移动端
是**能否启动的前提**，且常常没有 Java 异常（只有原生崩溃）。抽象规则见
`ecosystem/sdl3-transition.md`、`ecosystem/renderer-compat.md`、`patterns/graphics-shader-conflict.md`、
`patterns/shader-compile-failure.md`，本条只给真实形态。

## 签名 (Signature)

**案例 1：MC 26.3 的 SDL3 类缺失（logId: DXfMZ59，ZalithLauncher 2.4.11 + Krypton Wrapper/GL4ES）**

```
▷ Launcher version: 2.4.11 (200034)
▷ Architecture: arm64
▷ Device model: Xiaomi, 25091RP04C
▷ Renderer: Krypton Wrapper
▷ Minecraft Info: 26.3
▷ ZALITH_VERSION_CODE = 200034
▷ -Dglfwstub.windowWidth=3200
▷ -Dglfwstub.windowHeight=2136
▷ -Dglfwstub.initEgl=false
WARNING: sun.misc.Unsafe::objectFieldOffset has been called by org.lwjgl.system.MemoryUtil
    (file:/.../components/lwjgl3/lwjgl-glfw-classes.jar)
[main/WARN]: Failed to get system info for SDL Platform
java.lang.NoClassDefFoundError: org/lwjgl/sdl/SDLPlatform
Caused by: java.lang.ClassNotFoundException: org.lwjgl.sdl.SDLPlatform
Description: Loading library SDL
java.lang.NoClassDefFoundError: org/lwjgl/sdl/SDL
Caused by: java.lang.ClassNotFoundException: org.lwjgl.sdl.SDL
	Loading order: freetype,SDL,spvc,vma,STB,OpenAL,shaderc,OpenGL
	Backend library: LWJGL version 3.3.6-snapshot
	SDL Platform: ~~ERROR~~ NoClassDefFoundError: org/lwjgl/sdl/SDLPlatform
```

**案例 2：MC 26.3 的 SDL3 原生库缺失（logId: 6dVOYpi，FCL 1329 + Krypton Wrapper）**

```
Renderer: Krypton Wrapper
Device: Honor MTN-AN00 MTN-AN00
Architecture: arm64
Env: FCL_VERSION_CODE=1329
Env: POJAV_RENDERER=opengles3
Java argument: -Dorg.lwjgl.librarypath=/data/user/0/com.tungsten.fcl/app_runtime/lwjgl/3.4.1/natives/arm64-v8a
Java argument: -Dglfwstub.initEgl=false
[main/WARN]: Failed to get system info for SDL Platform
java.lang.NoClassDefFoundError: Could not initialize class org.lwjgl.sdl.SDL
	at org.lwjgl.sdl.SDLPlatform$Functions.<clinit>(SDLPlatform.java:25)
	at com.mojang.blaze3d.platform.Window.getPlatform(Window.java:142)
Caused by: java.lang.ExceptionInInitializerError: Exception java.lang.UnsatisfiedLinkError:
    Failed to locate library: libSDL3.so [in thread "main"]
	at org.lwjgl.system.Library.loadNative(Library.java:362)
	at org.lwjgl.sdl.SDL.<clinit>(SDL.java:12)
	at com.mojang.blaze3d.platform.NativeLibrariesBootstrap.loadSdl(NativeLibrariesBootstrap.java:283)
Description: Loading library SDL
java.lang.UnsatisfiedLinkError: Failed to locate library: libSDL3.so
	Loading order: SDL,STB,OpenGL,freetype,spvc,shaderc,OpenAL,vma
	Loading index: 0
	SDL Platform: ~~ERROR~~ NoClassDefFoundError: Could not initialize class org.lwjgl.sdl.SDL
	Graphics Device: <none>
```

**案例 3：MobileGlues 2.0.0 不兼容 26.3 的 ShaderC/OIT 管线（logId: TWa5zoi）**

```
Renderer: MobileGlues
Device: Vivo PD2156 V2156A
[MobileGlues] Setting: customGLVersion = 4.0.0
OpenGL ES Version: OpenGL ES 3.2 (320)
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/position_color):
    0:103: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/terrain):
    0:374: L0002: Undeclared variable '_uniform'
    0:376: L0002: Undeclared variable 'param'
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/entity):
    0:119: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
java.util.concurrent.CompletionException: java.lang.RuntimeException: Failed to load required shader programs:
 - minecraft:pipeline/oit_transmittance_terrain_multidraw
 - minecraft:pipeline/cutout_terrain
	at TRANSFORMER/minecraft@26.3/net.minecraft.client.renderer.ShaderManager.apply(ShaderManager.java:198)
Description: Unexpected error
	Graphics Device: Mali-G57 MC2 | OpenGL ES 3.2
	DeviceFeatures[wireframeFillMode=true, shaderDrawParameters=false, multiDrawDirectInterleaved=false,
	    multiDrawDirectSeparate=true, multiDrawIndirect=false, drawIndirect=false, nonZeroFirstInstance=false,
	    persistentMapping=true]
	Backend failure message: Device missing capabilities
	Backend failure reason: vulkan_device_version_too_low
```

**案例 4：显存不足（logId: VyKPFsd，MC 26.3，NVIDIA GTX 1050 Ti）**

```
[Render thread] [GlDebug/INFO]: OpenGL debug message: id=1285, source=API, type=ERROR, severity=HIGH,
    message='GL_OUT_OF_MEMORY error generated. Failed to allocate memory for buffer data.'
[Render thread] [Minecraft/FATAL]: Reported exception thrown!
Caused by: com.mojang.renderpearl.api.device.GpuOutOfMemoryException:
    Could not allocate buffer of 1835008 for net.minecraft.client.renderer.StagedVertexBuffer$$Lambda/...@ec48c9c
	at knot//com.mojang.renderpearl.backend.opengl.GlDevice.createBuffer(GlDevice.java:259)
	at knot//com.mojang.renderpearl.frontend.FrontendGpuDevice.createBuffer(FrontendGpuDevice.java:149)
Description: Render Frame
[Render thread] [Sodium-GlSurface/INFO]: OpenGL Renderer: NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2
```

同一形态的另一实例：切换高负载光影后 `ArenaAggregator` 申请约 345 MB 缓冲区失败（logId: A4Ji20S、K6v4yjM）

```
Caused by: com.mojang.renderpearl.api.device.GpuOutOfMemoryException:
    Could not allocate buffer of 361819584 for net.caffeinemc.mods.sodium.client.gpu.arena.ArenaAggregator$$Lambda/...
Description: Render Frame
```

**案例 5：Iris + Sodium 版本错配（logId: kcAIC7E，MC 1.21.x）**

```
java.lang.NoClassDefFoundError: net/caffeinemc/mods/sodium/client/gl/shader/uniform/GlUniformFloat2v
	at knot//net.irisshaders.iris.pipeline.programs.SodiumShader.<init>(SodiumShader.java:69)
	at knot//net.irisshaders.iris.pipeline.programs.SodiumPrograms.lambda$buildProgram$2(SodiumPrograms.java:178)
Caused by: java.lang.ClassNotFoundException: net.caffeinemc.mods.sodium.client.gl.shader.uniform.GlUniformFloat2v
```

## 含义

**案例 1 与案例 2 是同一个 MC 问题**：MC **26.3 起把窗口/输入后端从 GLFW 换成 SDL3**。

| MC 版本 | 窗口/输入后端 | LWJGL 需要 |
|---|---|---|
| ≤ 26.2 | GLFW | `org.lwjgl.glfw.*` |
| **≥ 26.3** | **SDL3** | `org.lwjgl.sdl.*` + `libSDL3.so` |

**两个案例的报错层次不同，但根因相同**：

| logId | 启动器 | 缺什么 | 异常 |
|---|---|---|---|
| DXfMZ59 | ZalithLauncher 2.4.11 | **Java 类**（`lwjgl-glfw-classes.jar` 里没有 `org.lwjgl.sdl.*`） | `ClassNotFoundException` → `NoClassDefFoundError` |
| 6dVOYpi | FCL 1329 | **原生库**（`libSDL3.so`） | `ExceptionInInitializerError` → `UnsatisfiedLinkError` |

**各启动器的表现差异**（同一问题的不同表现，不是不同问题）：

| 启动器版本 | 表现 | logId |
|---|---|---|
| ZalithLauncher 2.4.11（Krypton Wrapper） | `ClassNotFoundException: org.lwjgl.sdl.SDLPlatform`，`Backend library: LWJGL version 3.3.6-snapshot` | DXfMZ59 |
| FCL 1329（Krypton Wrapper/OpenGL ES 3） | `UnsatisfiedLinkError: Failed to locate library: libSDL3.so` | 6dVOYpi |
| FCL 1315 / 1318 / 1297（Krypton Wrapper） | `NoClassDefFoundError: org/lwjgl/sdl/SDLPlatform`，`Graphics Device: <none>` | cBUFJkv、NNTaidY、6Jomzpa |

共同判据：**崩溃发生在窗口创建阶段**，日志中可见 `Failed to get system info for SDL Platform`、
`Loading order: ...,SDL,...`、`Graphics Device: <none>`；JVM 参数含 `-Dglfwstub.*` 但**无** `-Dorg.lwjgl.sdl.libname`。

案例 3 是**新渲染管线的连带变化**：26.3 同时把着色器编译统一为 ShaderC 并引入 OIT 管线，
新增 `minecraft:pipeline/oit_transmittance_terrain_multidraw` 等必需管线。转译层（MobileGlues）
若未适配，编译错误信息通常不是「语法错」而是**转译器输出被破坏**后的假象
（`Undeclared variable '_uniform'`、`Undeclared variable 'param'` 是典型的临时变量命名残留）。

案例 4 与 Java 堆无关：`GpuOutOfMemoryException` 来自 `com.mojang.renderpearl`（26.x 的渲染抽象层），
是**显存/GPU 缓冲区**分配失败。案例 4 的 `1835008` 字节（约 1.75 MB）与 A4Ji20S 的 `361819584`
字节（约 345 MB）都出现在同一条代码路径上——小请求失败说明显存已彻底耗尽。

案例 5 的类是 Sodium 的**内部实现类**（`GlUniformFloat2v`），Iris 硬编码引用它。
Sodium 重构会移除/改名这类内部类，Iris 必须同步更新——两者是**成对发布**的关系。

## 常见触发

### 触发 A：MC 升到 26.3+ 而启动器组件未适配 SDL3

最直接的触发路径是：**游戏版本升级，启动器未升级**。已核实五个案例，覆盖两个启动器家族的五个版本号。
另一种触发是**启动器的 LWJGL 组件下载不完整**（缺 `lwjgl-sdl.jar` 或 ARM64 的 `libSDL3.so`），
此时即使启动器版本较新也会失败。

手动替换 `components/lwjgl*` 目录同样会触发——版本混杂后既可能缺类也可能缺库。

### 触发 B：26.3 新增 ShaderC / OIT 管线不被转译层支持

26.3 引入的变化中，**这些会连带影响渲染器与光影**：

- 着色器编译统一为 ShaderC（案例 3 的 `minecraft:core/*` 编译失败）
- 新增 OIT 渲染管线（`oit_transmittance_terrain_multidraw`）
- `DeviceFeatures` 中出现 `multiDrawIndirect=false` 等能力探测

已核实的失败渲染器为 **MobileGlues 2.0.0**（Mali-G57 MC2，GLES 3.2）。
`customGLVersion = 4.0.0` 的设定无法弥补转译层对新管线的支持缺失。

另有 SDL3 事件后端相关的**原生堆破坏**案例（logId: KcEW7zP）：机上同时存在两套版本不一致的原生 SDL3
（Controlify 自带 3.4.12 与 sdl-api 绑定 3.4.14）叠加快照版 LWJGL 3.4.3，
长时间运行后破坏原生堆，在事件轮询线程中 `EXCEPTION_ACCESS_VIOLATION` 硬崩。

### 触发 C：显存不足（与 Java 堆无关）

已核实三个案例均为 `GpuOutOfMemoryException`：

- `VyKPFsd`：NVIDIA GTX 1050 Ti（4GB 级），`Could not allocate buffer of 1835008`，`Description: Render Frame`
- `A4Ji20S`：切换高负载光影（Photon-GAMS / Derivative Main）后，Oculus(Iris) 阴影渲染调用 Embeddium
  批量绘制时申请 345 MB 失败，伴生 `EXCEPTION_ACCESS_VIOLATION`
- `K6v4yjM`：系统提交内存（虚拟内存）耗尽（28541/28647 MiB）叠加 2021 年旧版 NVIDIA 驱动

**关键区分**：日志中同时出现 `Sodium-GraphicsAdapterProbe` 找到的显卡型号（如 `GTX 1050 Ti`），
且**没有** `java.lang.OutOfMemoryError: Java heap space`。这是显存问题，调 `-Xmx` 无效。

### 触发 D：光影模组与优化模组版本互斥

Iris 与 Sodium 是**成对发布**的，任一版本错配都会触发。已核实的三种形态：

| 形态 | 表现 | logId |
|---|---|---|
| 依赖求解阶段拦截 | `HARD_DEP_NO_CANDIDATE iris 1.8.8 {depends sodium @ [0.6.x]}` + `NEG_HARD_DEP sodium 0.8.13 {breaks iris @ [<1.8.13]}` | kM7P543 |
| 运行期类缺失 | `NoClassDefFoundError: ...sodium...GlUniformFloat2v` | kcAIC7E |
| 运行期 Mixin 注入失败 | `MixinPreProcessorException ... mixins.iris.compat.sodium.json:MixinRenderSectionManager` | zAtL082、t1SZL6i、Z5CFEkc |

**快照版（snapshot）风险更高**：`t1SZL6i`（`1.8.12-snapshot+mc1.21.1-local`）、
`zAtL082`、`Z5CFEkc`、`pCBwgQ7` 都涉及 snapshot 构建，引用了当前 Sodium 中已重构掉的内部类
（`SodiumGameOptions$PerformanceSettings`）。

## 修复步骤

**触发 A（SDL3 未适配）**

1. 确认 MC 版本 ≥ 26.3（日志中 `Minecraft Info: 26.3` 或 `Loading Minecraft 26.3`）
2. **升级启动器**（正解）：ZalithLauncher2 的 SDL3 支持已在其 PR 中合入，升级到含该 PR 的版本；
   FCL / MojoLauncher 查各自仓库的最新版本说明
3. 无法升级时**降 MC 版本到 26.2 或更早**（仍是 GLFW 后端），这是「先能玩」的最快路径
4. **不要手动往组件目录塞 `lwjgl-sdl.jar`**——还缺 ARM64 的 `libSDL3.so`、窗口/输入桥接适配与
   启动器的加载路径配置，改坏可能导致启动器完全无法启动
5. 确认下载的启动器包是 **arm64-v8a**

**触发 B（新着色器管线不被支持）**

1. 更新渲染器（MobileGlues）到声明支持 26.3 的版本
2. 渲染器暂无适配版本时，换用其他渲染器（如适配较快的 Krypton / GL4ES 组合）或降 MC 版本
3. 看到 `Undeclared variable 'param'` 这类**转译器残留命名**的编译错误时，不要尝试改光影设置——
   问题在转译层，不在着色器
4. 机上存在多套原生 SDL3（模组自带 + 启动器）时，移除冲突模组或统一版本，不要叠加快照版 LWJGL

**触发 C（显存不足）**

1. 先降画质：渲染距离、模拟距离、体积云、抗锯齿、阴影分辨率、光影包档次
2. 换用资源占用更低的光影包（Photon-GAMS / Derivative Main 属高负载档）
3. 更新显卡驱动（案例 K6v4yjM 的驱动为 2021 年版本）
4. **不要调 `-Xmx`**——这是显存问题，改 Java 堆无效，反而可能挤占系统提交内存
5. 检查系统提交内存/页面文件是否耗尽（Windows 上 `虚拟内存` 设置过小会连锁触发 GPU 分配失败）

**触发 D（Iris 与 Sodium 版本错配）**

1. 两个模组**同时**更新到各自的兼容版本，不要只升一个
2. **避免使用 snapshot / local 构建**——已核实的四例中三例涉及快照版
3. 依赖求解阶段被拦（`NEG_HARD_DEP`）时，按 `Fix` 行的降级方案把 Sodium 降到被允许的版本
4. 运行期 `NoClassDefFoundError` 指向 Sodium 内部类时，说明两者版本线不在同一代，需整体对齐

## 置信度线索

- **确定（SDL3 迁移）**：日志含 `org/lwjgl/sdl/SDL` 或 `SDLPlatform` 的 `NoClassDefFoundError` /
  `ClassNotFoundException` / `libSDL3.so` 的 `UnsatisfiedLinkError`，且 MC ≥ 26.3
- **确定（SDL3，崩溃阶段）**：`Failed to get system info for SDL Platform` + `Description: Loading library SDL`
  + `Graphics Device: <none>`，三者同时出现
- **较确定（SDL3）**：MC ≥ 26.3 + 崩溃在窗口创建阶段 + JVM 参数含 `-Dglfwstub.*` 而无 `-Dorg.lwjgl.sdl.libname`
- **确定（显存不足）**：`GL_OUT_OF_MEMORY` 与 `GpuOutOfMemoryException: Could not allocate buffer of <字节数>`
  同时出现，`Description` 为 `Render Frame`
- **明确排除（显存 ≠ 堆）**：无 `java.lang.OutOfMemoryError: Java heap space`，且 `-Xmx` 未接近物理内存上限
- **确定（转译层不兼容 26.3 管线）**：`Failed to load required shader programs:` 后列出 `minecraft:pipeline/*`；
  编译错误含 `Undeclared variable 'param'` / `'_uniform'` 等转译器临时变量名
- **确定（Iris ↔ Sodium 错配）**：`NEG_HARD_DEP ... {breaks iris @ [<...]}`，或缺失类属
  `net.caffeinemc.mods.sodium.*`
- **需追问**：日志未标 MC 版本与启动器版本时向用户确认。同一份日志中
  `Minecraft Info: 26.3`（ZL2）、`Minecraft argument: --version`（FCL）、
  `Loading Minecraft X with Fabric Loader Y` 均可提供依据
- **需区分**：案例 1/2 的报错**没有 `crash-reports/`**（发生在窗口初始化阶段），
  而案例 3/4/5 有崩溃报告——找不到崩溃报告不代表没崩溃
