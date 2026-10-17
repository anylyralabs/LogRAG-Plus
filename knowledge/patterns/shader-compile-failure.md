# 着色器编译失败（核心着色器管线编译不过导致渲染管线无法建立）

## 签名 (Signature)

**核心着色器（core shader）逐条编译失败（26.3 起的新渲染管线，实测最高频）**

```
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/terrain): 0:209: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
Error: Not enough space in buffer
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/clouds): 0:123: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/entity): 0:120: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/text): 0:118: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/item): 0:116: S0015: Outputs declared as arrays may only be indexed by a constant integral expression.
```

实测覆盖的管线名：`minecraft:core/terrain`、`clouds`、`entity`、`text`、`item`、`particle`、`position_color`、`block`、`rendertype_lines`、`rendertype_beacon_beam`、`rendertype_crumbling`、`rendertype_entity_shadow`。

**同一台设备上另一种编译失败（变量未声明 / 转译器输出破坏）**

```
[Render thread/ERROR]: Couldn't compile fragment shader for pipeline (minecraft:core/terrain): 0:224: L0002: Undeclared variable '_uniform'
0:226: L0002: Undeclared variable 'param'
0:228: L0002: Undeclared variable 'param_2'
0:230: L0001: Typename expected, found 'else'
```

**管线建立失败（上一类累积后的终止性异常，崩溃报告顶层）**

```
[Render thread/ERROR]: Unreported exception thrown!
java.util.concurrent.CompletionException: java.lang.RuntimeException: Failed to load required shader programs:
 - minecraft:pipeline/oit_transmittance_terrain_multidraw
 - minecraft:pipeline/cutout_terrain
 - minecraft:pipeline/oit_transmittance_terrain
 - minecraft:pipeline/translucent_terrain_multidraw
 - minecraft:pipeline/solid_terrain
 - minecraft:pipeline/oit_depth_bounds_terrain
Caused by: java.lang.RuntimeException: Failed to load required shader programs:
	at TRANSFORMER/minecraft@26.3/net.minecraft.client.renderer.ShaderManager.apply(ShaderManager.java:198)
	at TRANSFORMER/minecraft@26.3/net.minecraft.client.renderer.ShaderManager.lambda$reload$3(ShaderManager.java:86)
```

对应的崩溃报告为 `Description: Unexpected error`。

**转译层初始化期的探测失败（`Shader compile fails`，多数无害）**

```
Hardware vendor is HUAWEI
<GPU> [WARNING][T:42962] <VK>                                 #                               Shader compile fails

<GPU> [WARNING][T:42962] <VK>                                 #                               0:1: P0007: Language version '120' unknown, this compiler only supports up to version '320 es'
1:1: L0001: Typename expected, found 'layout'
1:2: L0001: Expected identifier, found '(',

3 error(s), 0 warning(s)
```

这是 gl4es / Krypton Wrapper 在初始化时**故意**用一段 GLSL 120 探针试编译以判定驱动能力，失败属预期。

**GL4ES 转译出的固定管线着色器编译失败**

```
[Client thread/ERROR]: Shader compilation failed. (Type=35633): 0:26: P0005: #version must be the first directive/statement in a program
0:26: P0007: Language version '460' unknown, this compiler only supports up to version '320 es'
0:5: L0002: Undeclared variable '_gl4es_ModelViewProjectionMatrix'
0:6: S0045: Input variable declared inside a function
```

**光影包的编译与链接失败（Iris / OptiFine 各自的形态）**

```
java.lang.RuntimeException: Shader compilation failed for compute <着色器名>!
	at net.irisshaders.iris.pipeline.IrisRenderingPipeline.createComputeProgram(IrisRenderingPipeline.java)
[Client thread/ERROR]: [Shaders] Error linking program: 85
[Client thread/ERROR]: [Shaders] [Shaders] Error: Invalid program "gbuffers_water"
ERROR: 3:53: '*' :  wrong operand types  no operation '*' exists that takes a left-hand operand of type '3-component vector of uint' and a right operand of type 'const float'
ERROR: 0:52: 'u_SectionTimeInfo' : undeclared identifier
ERROR: 11 compilation errors.  No code generated.
```

**资源包自带的核心着色器 JSON 损坏 / 采样器缺失 WARN（后者属噪音）**

```
net.minecraft.server.ChainedJsonException: Invalid shaders/core/meteor_trail.json: java.io.EOFException: End of input at line 1 column 1 path $
	at TRANSFORMER/minecraft@1.20.1/net.minecraft.server.ChainedJsonException.m_135906_(ChainedJsonException.java:48)
[Render thread/WARN]: Shader rendertype_entity_translucent_emissive could not find sampler named Sampler2 in the specified shader program.
```

## 含义

Minecraft 的渲染管线由两类着色器组成：

| 类型 | 位置 | 提供方 |
|---|---|---|
| **核心着色器（core shader）** | 资源包 `assets/<命名空间>/shaders/core/*.json` + `.vsh` / `.fsh` | MC 本体，可被资源包替换 |
| **后处理着色器（post shader）** | 资源包 `assets/<命名空间>/shaders/post/*.json` | MC 本体，可被资源包替换 |
| **光影包着色器** | `shaderpacks/<包名>/shaders/**` | 光影包，由 Iris / OptiFine / Oculus 编译 |

启动或资源重载时，MC 逐条编译核心着色器并把它们串成**渲染管线（render pipeline）**。任何一条编译失败，就少一条可用管线；失败累积到关键管线（`solid_terrain`、`cutout_terrain`、`translucent_terrain`、`oit_*`）时，`ShaderManager.apply()` 抛 `Failed to load required shader programs`，游戏在初始化渲染资源阶段终止。

**移动端的真正特殊性在于「GLSL 版本协商」**：PC 的 OpenGL 驱动直接支持 GLSL 330/460，而移动端只有 OpenGL ES（GLSL ES 3.0/3.1/3.2 上限为 `#version 320 es`）。渲染器（gl4es、Krypton Wrapper、MobileGlues、ANGLE、Zink、VirGLRenderer）负责把桌面 GLSL **转译**成 GLSL ES。转译层的覆盖率决定了哪些着色器能过：

| 失败信息中的关键片段 | 实质 |
|---|---|
| `Language version '460'/'120' unknown, this compiler only supports up to version '320 es'` | 转译层把桌面版本号原样透传给了 GLES 编译器，版本协商失败 |
| `#version must be the first directive/statement in a program` | 转译层在 `#version` 之前插入了自己的声明 |
| `Undeclared variable '_gl4es_ModelViewProjectionMatrix'` / `_uniform` / `param` | 转译层生成的辅助变量声明丢失或被截断 |
| `Outputs declared as arrays may only be indexed by a constant integral expression` | GLSL ES 3.x **比桌面 GLSL 更严格**：片元输出数组只允许常量下标。MC 26.3 的核心着色器使用了非常量下标的写法，桌面驱动容忍，GLES 编译器直接拒绝 |
| `Error: Not enough space in buffer` | 转译层的中间缓冲不足以承载 MC 的着色器规模 |

最后一行解释了为什么该故障**集中在 26.3**：26.3 引入了新的渲染管线（`minecraft:pipeline/*`），核心着色器规模与写法都变了，转译层的语法覆盖面跟不上。

**桌面端与移动端的分界**：桌面端出现 `Failed to load required shader programs` 时，原因通常是**资源包自带的核心着色器版本过旧**（1.21.2 起核心着色器路径与命名发生变动，旧资源包未更新）或**资源包着色器 JSON 损坏**；移动端出现同类错误时，原因通常是**转译层不支持该 GLSL 写法**，与资源包无关。

## 常见触发

### 触发 A：转译层（gl4es / Krypton / MobileGlues）不支持 26.3 核心着色器语法

MC 26.3 的核心着色器在片元输出数组上使用了非常量下标，GLSL ES 规范禁止该写法（见「含义」表第 4 行），转译层直接透传后被 GLES 编译器拒绝。

典型特征：`Couldn't compile fragment shader for pipeline (minecraft:core/...)` 成片出现，覆盖 terrain / entity / text / item / particle / clouds 等十余条管线，随后抛 `Failed to load required shader programs`。

实测：全部出现在 MC 26.3 上，渲染器为 Krypton Wrapper（占绝大多数）与 MobileGlues。

### 触发 B：转译层生成的辅助变量丢失

转译层在改写着色器源码时破坏了声明与使用的对应关系。

典型特征：`Undeclared variable '_gl4es_ModelViewProjectionMatrix'`、`Undeclared variable '_uniform'`、`Undeclared variable 'param'`，或 `#version must be the first directive/statement in a program`。

### 触发 C：资源包自带的核心着色器与当前 MC 版本不符

资源包复刻了核心着色器以实现视觉改动。MC 1.21.2 起核心着色器路径与命名有变动（Iris 官方与 ItemsAdder 都发布了迁移说明，要求把 `vertex` / `fragment` 路径补上 `core/` 前缀），旧资源包不改就在新版本上加载失败。

典型特征：失败列表集中在少数几条管线而非全部；用原版资源包启动即正常。资源包打包不完整导致 `shaders/core/*.json` 被截断时，报 `ChainedJsonException: Invalid shaders/core/<名>.json: java.io.EOFException: End of input at line 1 column 1 path $`。

### 触发 D：光影包使用了 GPU 不支持的 GL 特性，或与 MC 版本不符

移动端 GLES 对 SSBO、计算着色器、`imageLoad`、`texelFetch` 覆盖不全；光影包内部的 GLSL 写法也可能对应旧版 MC 的 uniform 与 sampler 约定。

典型特征：`Shader compilation failed for compute <名>!`、`iris.shaders.ssbofailure`（SSBO 特性缺失）、`Invalid program "gbuffers_water"`、`Error linking program: <数字>`、`wrong operand types`、`undeclared identifier 'u_<名>'`。

### 触发 E：转译层初始化探针失败（无害）

gl4es / Krypton Wrapper 在初始化时主动编译一段 GLSL 120 探针来判断驱动能力，失败是预期结果，紧接着会打印 `GLSL 300 es supported` / `GLSL 310 es supported` / `GLSL 320 es supported` 的能力清单。

典型特征：`<GPU> ...[T:<tid>] <VK> # Shader compile fails`，且**不伴随** `Failed to load required shader programs` 或崩溃报告。实测该签名出现的日志中崩溃报告数为 0。

### 触发 F：采样器缺失（噪音，非本类故障）

某条透明发光实体着色器程序里没有名为 `Sampler2` 的采样器，MC 记一条 WARN 后继续。

典型特征：`Shader rendertype_entity_translucent_emissive could not find sampler named Sampler2 in the specified shader program.`。这是 Mojang 已修复并归档的问题（MC-249414，1.21.2 起不再出现），出现该行的日志中崩溃比例与总体相当，**不能作为根因**。

## 修复步骤

**触发 A（26.3 + 转译层）**

1. 换渲染器逐一验证：Krypton Wrapper → MobileGlues → Holy-GL4ES → Zink。实测同一 MC 版本下不同渲染器的核心着色器覆盖面不同。
2. 更新该渲染器到最新发布（核心着色器适配由渲染器侧修复，更新 MC 或换资源包无效）。
3. 全部渲染器都失败时，只能把 MC 降到 26.2 或更低版本——这是渲染器尚未适配 26.3 新渲染管线的表现。
4. 不要试图通过更换资源包或光影包解决——本类失败由引擎侧引发，与包的版本无关。

**触发 B（辅助变量丢失）**

1. 同触发 A，优先换渲染器验证。
2. 该渲染器有开关（如 `glGetError` 抑制、着色器缓存、扩展开关）时，先关闭着色器缓存再启动一次，排除缓存陈旧。
3. Krypton Wrapper 的 Target 版本可调时，把目标 GL 版本调整后再试。

**触发 C（资源包核心着色器过旧或 JSON 损坏）**

1. 用原版资源包启动验证：正常则确定是资源包问题。
2. 更新该资源包到支持当前 MC 版本的发布版；资源包未更新时移除它（若只做视觉改动），或手工把其中 `shaders/core/` 下的 JSON 路径改为新格式。
3. `Invalid shaders/core/<名>.json` 指向单个文件时，重新下载该资源包（下载中断是常见成因），解压验证 zip 是否可打开。
4. 逐一启用以二分定位：先禁用一半资源包，按报错是否复现缩小范围。

**触发 D（光影包特性不支持 / 版本不符）**

1. 换用更轻量的光影包验证是包的问题还是环境问题。
2. 在光影包设置中关闭计算着色器、SSBO、阴影等高级选项。
3. 从 `Invalid program "<程序名>"` 读出失败的程序名，换一个明确标注支持当前 MC 版本的光影包版本。
4. 确认光影包已完整解压（`shaderpacks/<包名>/shaders/` 必须存在）；更新 GPU 驱动。

**触发 E / F（初始化探针与采样器 WARN）**

1. 两者都不做任何处理。探针失败后紧跟的 `GLSL 3xx es supported` 行说明它已正确完成判定任务；采样器 WARN 在真实日志中出现比例超过 10%，属稳定噪音。
2. 只有在探针失败**伴随** `Failed to load required shader programs` 时，才按触发 A 处理。

**按环境的处置优先级**

| 环境 | 首选动作 |
|---|---|
| 移动端（gl4es / Krypton / MobileGlues / ANGLE） | 换渲染器 → 更新渲染器 → 降 MC 版本 |
| 移动端（Zink / VirGLRenderer / Freedreno） | 确认驱动支持的计算着色器特性，关光影高级选项 |
| PC（Iris / OptiFine 光影） | 换光影包版本 → 关阴影与计算着色器 → 更新显卡驱动 |
| PC（资源包核心着色器） | 用原版资源包二分定位 → 更新或移除资源包 |

## 置信度线索

- **确定（本类故障）**：日志含 `Failed to load required shader programs` / `Couldn't compile (fragment|vertex) shader for pipeline` / `Shader compilation failed` / `Shader compilation failed for compute` 之一。
- **确定（引擎侧 / 转译层）**：失败覆盖**十余条** `minecraft:core/*` 管线且错误信息统一为 `Outputs declared as arrays may only be indexed by a constant integral expression` 或 `Undeclared variable '...'` —— 这是转译层语法覆盖面不足，**不是资源包问题**，换资源包无效。
- **确定（资源包侧）**：失败只集中在少数几条管线，或伴随 `ChainedJsonException: Invalid shaders/core/<名>.json`。此类换渲染器无效。
- **确定（光影包侧）**：失败信息出自 Iris / OptiFine 的日志前缀（`[Shaders] Error:`、`IrisRenderingPipeline.createComputeProgram`），管线名形如 `gbuffers_*`，且与 `minecraft:core/*` 无关。
- **确定（无害）**：`<GPU> ...[T:<数字>] <VK> # Shader compile fails` 后紧跟 `GLSL 3xx es supported`，且无 `Failed to load required shader programs`。
- **确定（噪音）**：`Shader rendertype_entity_translucent_emissive could not find sampler named Sampler2 in the specified shader program.` 单独出现时**不构成故障**（实测出现该行的日志中，崩溃与不崩溃各半）。
- **注意（版本定位）**：`Couldn't compile fragment shader for pipeline` 与 `Failed to load required shader programs` 实测**全部出现在 MC 26.3**（含 26.3-Forge、26.3-Fabric）；26.3 引入了 `minecraft:pipeline/*` 形式的新渲染管线。判断版本影响面时以该事实为准。
- **注意（渲染器分布）**：同一故障在 Krypton Wrapper 上约占四分之三，在 MobileGlues 上约占四分之一。修复建议必须落到具体渲染器，不能笼统说「换渲染器」。
- **需追问**：日志未给出渲染器名称（日志开头的 `Renderer: <名>` 行）与 MC 版本时，应先向用户确认这两项——它们决定了是转译层问题还是包的问题。
