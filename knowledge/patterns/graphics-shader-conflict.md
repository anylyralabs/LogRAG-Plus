# 光影与渲染模组冲突（PC 与移动端通用）

## 签名 (Signature)

```
java.lang.RuntimeException: Shader compilation failed for compute <着色器名>!
	at net.irisshaders.iris.pipeline.IrisRenderingPipeline.createComputeProgram(IrisRenderingPipeline.java)
java.lang.RuntimeException: Shader compilation failed for setup compute <着色器名>!

[main/WARN]: Reference map 'iris.refmap.json' for mixins.iris.json could not be read.
    If this is a development environment you can ignore this message

net.irisshaders.iris.vertices.sodium.terrain.XHFPTerrainVertex.write(JI[Lnet/caffeinemc/mods/
    sodium/client/render/chunk/vertex/format/ChunkVertexEncoder$Vertex;I)J
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005)
#  Problematic frame:
# J 37182 c2 net.irisshaders.iris.vertices.sodium.terrain.XHFPTerrainVertex.write(JI[L...;I)J

org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered
	at ...MixinProcessor.applyMixins(MixinProcessor.java:381)

java.lang.NoClassDefFoundError: net/caffeinemc/mods/sodium/client/render/chunk/vertex/format/ChunkVertexEncoder
java.lang.NoSuchMethodError: 'void net.caffeinemc.mods.sodium.client.render.chunk.compile.ChunkBuildContext.<init>(...)'
java.lang.IncompatibleClassChangeError: Found interface ... but class was expected (Sodium / Iris)

"iris.sodium.failure.reason.notFound": "Iris requires Sodium for good performance, but Sodium is not installed."
"iris.sodium.failure.reason.incompatible": "Iris requires Sodium for good performance, but an incompatible version was found."
"iris.load.failure.shader": "The shaderpack failed to load! Please report the error to the shader developer."
"iris.unsupported.pack": "Shaderpack incompatible!"
"iris.shaders.ssbofailure": "The shader requested a specific feature (SSBO) that is not supported by your GPU"
"options.iris.shaderPackSelection.failedAddSingle": "\"%s\" is not a valid Shader Pack"

未找到 <模组> 的核心着色器 / 资源包自定义核心着色器失效
方块完全透明 / 水面渲染为平面镜面 / z-fighting 条纹
```

## 含义

光影（shaderpack）本身不是模组，它是一组 GLSL 程序，需要一个**光影加载器**把它接入 Minecraft 的渲染管线；而现代渲染优化模组又重写了同一条管线，两者必须成对匹配。

| 组件 | 角色 | 对应关系 |
|---|---|---|
| Iris | 光影加载器（Fabric / NeoForge） | 依赖 Sodium，且版本强绑定 |
| Oculus | 光影加载器（Forge 1.16.5–1.20.1） | 依赖 Embeddium（Sodium 的 Forge 移植） |
| OptiFine | 光影加载器 + 渲染优化（一体） | **与 Sodium / Embeddium 互斥** |
| Sodium | 渲染优化（区块渲染重写） | Iris 的必需前置 |
| Embeddium | Sodium 的 Forge / NeoForge 移植 | Oculus 的必需前置 |
| Rubidium | Embeddium 的前身（1.16.5–1.19.2） | Oculus 的旧版前置 |
| OptiFabric | 让 OptiFine 跑在 Fabric 上 | 与 Sodium / Iris 互斥 |

核心矛盾：**Sodium 重写了区块渲染的顶点格式与编译流程，Iris 直接 hook 了 Sodium 的内部类**（如 `ChunkVertexEncoder$Vertex`）。因此 Iris 与 Sodium 的版本是成对发布的，二者版本错位会产生 `NoSuchMethodError` / `NoClassDefFoundError`，甚至 JIT 编译后的段错误（`EXCEPTION_ACCESS_VIOLATION`）。

## 常见触发

### 触发 A：Sodium / Embeddium 版本与光影加载器错位

Iris 的构建产物按 Sodium 版本编译，Sodium 内部类签名变动后旧版 Iris 立即失效。

典型表现：加载世界时 `NoSuchMethodError` 指向 `net.caffeinemc.mods.sodium.*`；或 `EXCEPTION_ACCESS_VIOLATION` 且 `Problematic frame` 里出现 `iris.vertices.sodium.terrain.*`（Iris 的顶点写入方法被 JIT 编译后越界）。

已知实例：Iris 1.11.4 + Sodium 0.9.2（MC 26.2）组合下 `XHFPTerrainVertex.write` 触发 `EXCEPTION_ACCESS_VIOLATION`。

### 触发 B：缺少 Sodium 或装了不兼容版本

Iris 强制要求 Sodium，缺失或不匹配时游戏在启动阶段直接弹出 Iris 自己的错误屏，而非崩溃报告：

- 缺失：`iris.sodium.failure.reason.notFound`
- 版本不匹配：`iris.sodium.failure.reason.incompatible`

Forge 侧同理：Oculus 要求 Embeddium（1.20.1）或 Rubidium（1.16.5–1.19.2）。

### 触发 C：OptiFine 与 Sodium / Iris 并存

OptiFine 自己实现了区块渲染与光影，与 Sodium 修改同一批类。二者同时存在时启动即 Mixin 冲突：

```
Mixin apply failed for optifine.* -> net.minecraft.client.renderer.*
org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError
```

Fabric 上通过 OptiFabric 加载 OptiFine 时矛盾更尖锐——OptiFabric 与 Sodium 直接互斥。

### 触发 D：着色器包编译失败

着色器源码与目标 GPU / 驱动不兼容。Iris 抛 `Shader compilation failed for compute <名称>!` 或 `for setup compute <名称>!`，日志中在此之前有 GLSL 编译器的具体错误行。

常见原因：

- 着色器使用了 GPU 不支持的 GL 特性（SSBO、计算着色器、`imageLoad`），日志伴随 `iris.shaders.ssbofailure`
- 着色器包要求的 GLSL 版本高于驱动支持
- 着色器包本身就是坏的（未通过 `is not a valid Shader Pack` 校验，或解压后缺少 `shaders/` 目录）
- macOS / Metal 后端驱动支持面窄，`iris.unsupported.pack` 明确提示 `macOS is known to have issues with many shader packs.`

### 触发 E：模组自定义核心着色器与光影包冲突

资源包或模组通过核心着色器（Core Shader）修改渲染，与光影包注入的程序争抢同一渲染阶段。Iris 官方列为**不可修复**的已知不兼容：

| 模组 | 冲突点 |
|---|---|
| Botania | 自定义着色器与光影包提供的着色器冲突 |
| ComputerCraft | 基于 TBO 的显示器渲染 |
| Colored Lights (Gegy) | 与 Sodium 不兼容，而 Iris 依赖 Sodium |
| Immersive Portals | 水面下的传送门镜像无法渲染（渲染时机在透明面之后） |
| Tweakeroo | Freecam 功能与 Iris 冲突 |

资源包层面的自定义核心着色器（含服务器下发的盔甲着色器）Iris 亦不支持。

### 触发 F：无实质影响的启动期警告

以下警告**不影响渲染，不是崩溃原因**，排查时不应作为根因：

```
Reference map 'iris.refmap.json' for mixins.iris.json could not be read.
    If this is a development environment you can ignore this message
```

26.1 起 Mojang 不再混淆，Iris 的 refmap 文件因此不再被读取，多条 `Reference map ... could not be read` 属预期输出。

## 主流渲染器对照

| 组件 | 生态 | 依赖 | 不兼容对象 |
|---|---|---|---|
| Iris | Fabric / NeoForge | Sodium（强制，版本强绑定） | OptiFine、OptiFabric、Colored Lights |
| Oculus | Forge 1.16.5–1.20.1 | Embeddium 或 Rubidium | OptiFine（1.20.1 前另有 OptiFine 共存方案已失效） |
| OptiFine | 原版加载器 / Forge / Fabric(OptiFabric) | 无 | Sodium、Embeddium、Rubidium、Iris、Oculus |
| Sodium | Fabric | 无 | OptiFine、OptiFabric、Iris 版本错位 |
| Embeddium | Forge / NeoForge | 无 | OptiFine |
| Distant Horizons | 全平台 | Iris（启用光影时） | 水面渲染异常、部分光影包 |

## 修复步骤

**触发 A（版本错位）**

1. 到 Iris 发布页查该构建对应的 **Sodium 版本号**，把 Sodium 换成完全一致的那个版本
2. 反向也成立：更新 Sodium 时必须同步更新 Iris
3. 不要混用不同 MC 版本的构建（如 `iris-fabric-1.11.4+mc26.2` 配 `sodium-fabric-0.9.2+mc26.3`）
4. `NoClassDefFoundError` / `NoSuchMethodError` 指向 `net.caffeinemc.mods.sodium.*` 时，一律按版本错位处理

**触发 B（Sodium 缺失）**

1. 下载与 Iris 匹配的 Sodium 放进 `mods/`
2. Forge 1.20.1 用 Embeddium，1.16.5–1.19.2 用 Rubidium
3. 安装后确认 `mods/` 中只有一个 Sodium 系模组（Embeddium、Rubidium、Sodium 三者不可共存）

**触发 C（OptiFine 冲突）**

1. 在 `mods/` 中移除 OptiFine 与 OptiFabric
2. 用 Iris + Sodium 组合替代 OptiFine 的光影功能
3. 必须保留 OptiFine 的场合（如依赖其特定选项的资源包），则移除 Sodium / Embeddium 与 Iris / Oculus，二者只能选一套

**触发 D（着色器编译失败）**

1. 换一个更轻量的着色器包（如 Complementary Reimagined 的 Lite 档、Sildur's Enhanced Default）验证是包的问题还是环境问题
2. 降低着色器包的画质档位，关闭其中的计算着色器与阴影选项
3. 更新显卡驱动；Intel 核显与 Apple Metal 后端需选明确标注支持的包
4. 确认着色器包完整解压——`shaderpacks/<包名>/shaders/` 目录必须存在，直接放 `.zip` 也可以但不要解压到一半
5. 移动端还需降低渲染器宣称的 GL 版本（如 `customGLVersion` 4.6 → 3.2）

**触发 E（模组核心着色器冲突）**

1. 按上表确认是否命中已知不可修复项；命中时移除其中一个模组
2. 服务器下发的自定义盔甲着色器资源包需在光影关闭时使用
3. Botania 的冲突需等待模组侧移除自定义着色器，Iris 无法修复

**触发 F（refmap 警告）**

1. 无需处理，继续排查其他日志
2. 仅当它是唯一输出且游戏确实无法启动时，才考虑更新 Iris 到适配当前 MC 版本

## 置信度线索

- **确定**：`Problematic frame` 或 `NoSuchMethodError` 明确指向 `net.irisshaders.iris.*` / `net.caffeinemc.mods.sodium.*`；或日志出现 `iris.sodium.failure.reason.incompatible`
- **较确定**：`Mixin apply failed` 的目标类属渲染管线（`net.minecraft.client.renderer.*`、`com.mojang.blaze3d.*`）且安装了 OptiFine
- **较确定**：`Shader compilation failed` 属着色器包或驱动问题，与模组版本无关
- **需追问**：日志未标明 Iris / Sodium / Oculus / Embeddium 版本与 MC 版本时，应向用户确认这四项（Iris 错误屏与 `mods/` 文件名中可见）
