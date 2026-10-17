# SDL3 迁移（Minecraft 26.3+）与启动器适配

## 签名 (Signature)

```
java.lang.NoClassDefFoundError: org/lwjgl/sdl/SDL
Caused by: java.lang.ClassNotFoundException: org.lwjgl.sdl.SDL
SDL Platform: ~~ERROR~~ NoClassDefFoundError: org/lwjgl/sdl/SDLPlatform
Libraries loaded Loading order: vma,SDL,OpenAL,... Loading index: 1
    at ...NativeLibrariesBootstrap.loadSdl(...)
```

辅助特征（崩溃报告 `System Details` 段）：

```
Backend library: LWJGL version 3.3.x-snapshot
Is Modded: Probably not
Window size: <not initialized>
GFLW Platform: null
```

JVM 参数特征：含 `-Dglfwstub.windowWidth` / `-Dglfwstub.initEgl`（GLFW stub），但**无** `-Dorg.lwjgl.sdl.libname`。

## 含义

Minecraft **26.3 起把窗口/输入后端从 GLFW 换成了 SDL3**。这是自 LWJGL 迁移以来最底层的一次变动。

| MC 版本 | 窗口/输入后端 | LWJGL 需求 |
|---|---|---|
| ≤ 26.2 | GLFW | `org.lwjgl.glfw.*` |
| **≥ 26.3** | **SDL3** | `org.lwjgl.sdl.*` + `libSDL3.so` |

若启动器注入的 LWJGL 组件仍只提供 GLFW 相关类（如只含 `lwjgl-glfw-classes.jar`），游戏在初始化 SDL 时会 `ClassNotFoundException` → `NoClassDefFoundError` 崩溃。

**连带变化**（26.3 同时引入）：键位绑定改为物理按键扫描码；原生支持 Wayland；无边框全屏默认开启；着色器编译统一为 ShaderC；新增 OIT 渲染管线。这些变化也会连带影响输入法、手柄模组与渲染器。

## 常见触发

1. **启动器版本旧**，其内置 LWJGL 组件未适配 SDL3（最常见）
2. 启动器的 LWJGL 组件下载不完整，缺 `lwjgl-sdl.jar` 或 ARM64 的 `libSDL3.so`
3. 手动替换过 `components/lwjgl*` 目录，导致版本混杂
4. 游戏升到 26.3+，但启动器仍按 26.2 的方式注入 GLFW stub

## 修复步骤

**第一步：升级启动器（正解）**

问题本质是启动器版本旧，不是配置能解决的。

| 启动器 | 状态（截至 2026-10） |
|---|---|
| ZalithLauncher2 | PR #1721 已合并（2026-08-28），含 SDL3 支持；升级到 2.5.x 之后含此 PR 的版本 |
| Amethyst-Android | 已有 SDL3 实现（Zalith 的实现即参考它） |
| MojoLauncher | 见其仓库 SDL3 相关 PR |
| FCL | 查其仓库最新版本说明 |

操作：在启动器设置里检查更新，或到官方仓库下载最新版（务必选 **arm64-v8a** 包）。

**第二步：暂时降级游戏版本（绕开）**

若启动器暂无可用更新：**降到 26.2 或更早版本**（仍是 GLFW 后端），验证设备能正常启动。这是「先能玩」的最快路径。

**第三步：不要手动替换 LWJGL 组件**

手动往组件目录塞 `lwjgl-sdl.jar` 成功率极低，因为还缺 ARM64 的 `libSDL3.so`、窗口/输入桥接适配、启动器的加载路径配置。改坏后可能导致启动器完全无法启动。

## 置信度线索

- **确定**：日志含 `org/lwjgl/sdl/SDL` 的 `NoClassDefFoundError` + MC ≥ 26.3
- **较确定**：MC ≥ 26.3 + 启动器版本较旧 + 崩溃发生在窗口创建阶段
- **需追问**：日志未标 MC 版本或启动器版本时，向用户确认这两项
