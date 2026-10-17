# 移动端渲染器兼容性

## 签名 (Signature)

```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGSEGV (0xb) at pc=0x...
# Problematic frame:
# C  [libmobileglues.so+0x593060]  glBindTextureUnit+0x54

# C  [libGLES_mali.so+...]
# C  [libGLESv2_adreno.so+...]  glDrawArraysInstanced
# C  [libmobileglues.so+...]  glGetString  （栈中可见 __strlen_aarch64）

java.lang.RuntimeException: ... glCheckFramebufferStatus ... GL_FRAMEBUFFER_UNSUPPORTED
着色器编译失败 / minecraft:core/terrain 编译错误 / 方块透明
```

## 含义

Android 没有桌面 OpenGL，而 Minecraft Java 版需要它。渲染器负责 **GL → GLES/Vulkan 转译**。

渲染器不是「画质选项」，而是**能否启动的前提**。渲染器与设备 GPU 驱动不匹配时，游戏会在窗口创建阶段直接崩溃，且**往往没有 Java 异常**（只有 `hs_err_pid*.log`）。

## 常见触发

### 触发 A：Mali GPU 上 `glGetString` 返回空指针

MobileGlues 的 `glGetString` 返回 null，Minecraft 对返回值调 `strlen` → 立即段错误。

触发条件：Mali GPU（含 Mali-G57 等）+ MC 26.3 + MobileGlues + `customGLVersion` 设为高版本（如 4.6）。

### 触发 B：DSA（扩展直接状态访问）段错误

MobileGlues 开启 `enableExtDirectStateAccess` 后，其 `glBindTextureUnit` 原生实现在部分 GPU（如 Mali-G720）上段错误。Iris 检测到 DSA 可用后走该路径（`IrisRenderSystem$DSAARB.bindTextureToUnit`），主菜单首次 blit 纹理时触发。

### 触发 C：Adreno 设备着色器编译失败

MC 26.3 的 RenderPearl 新渲染管线对驱动要求极高。Adreno 640 等设备加载 Fabric API 后 `minecraft:core/terrain` 等着色器编译失败 → 方块完全不渲染（透明）；加载 Sodium 后关闭 ANGLE 时触发 `libGLESv2_adreno.so` 崩溃。

### 触发 D：框架特性缺失

转译层未实现某些 GL 特性时，模组调用即崩溃。典型：`glCheckFramebufferStatus` 返回 `GL_FRAMEBUFFER_UNSUPPORTED`（如 Krypton Wrapper 下 Create 模组调用 `RenderTarget.enableStencil()` 附加模板缓冲）。

### 触发 E：启动器与渲染器配合问题

同设备、同渲染器、同配置，在某启动器崩溃而在另一启动器正常。典型线索：日志出现 `No environment variable VULKAN_PTR! Will load libvulkan.` 之类警告；或启动器强制注入的 JVM 参数影响驱动（如 `-XX:ActiveProcessorCount=8` 对 Mali 多线程的影响）。

## 修复步骤

**通用顺序**

1. **换渲染器**（最直接）：ANGLE → MobileGlues → Krypton Wrapper → LTW 依次尝试
2. **调整渲染器设置**：
   - 降低 `customGLVersion`（如 4.6 → 3.2）
   - 关闭 `enableExtDirectStateAccess`（DSA 相关崩溃）
   - 切换 `enableAngle`
3. **降级渲染器版本**到稳定版
4. **降级游戏版本**（26.3 的 RenderPearl 对驱动要求最高）
5. 仍不行 → 换启动器验证（确认是配合问题还是设备问题）

**按触发的针对性处理**

| 触发 | 首选措施 |
|---|---|
| A（Mali glGetString） | 降低 `customGLVersion`，或换 ANGLE |
| B（DSA 段错误） | 关闭 `enableExtDirectStateAccess` |
| C（Adreno 着色器） | 切换 ANGLE 开关；降级 MC 版本 |
| D（框架特性缺失） | 换渲染器，或移除触发该特性的模组 |
| E（启动器配合） | 换渲染器；换启动器验证 |

## 主流渲染器对照

| 渲染器 | 类型 | 适配场景 | 已知限制 |
|---|---|---|---|
| MobileGlues (MG) | GL→GLES 转译 | 兼容性最好，多数设备可用 | 新版 MC 需等适配；部分 SoC 有专属问题 |
| ANGLE | GL→GLES（Google 官方） | 兼容性稳定 | 性能一般；部分设备方块透明 |
| Krypton Wrapper | GL 包装 | 特定设备 | FBO 特性支持不全 |
| LTW (Less Than Wrapper) | 轻量包装 | 低端设备 | 功能受限 |
| GL4ES | GL→GLES 转译 | 老设备 | 已较少维护 |
| Zink + Turnip | GL→Vulkan（Mesa） | 骁龙设备（Turnip 驱动） | 需专用驱动插件；其他 SoC 不支持 |
| VirGL / Mesa | 虚拟 GL | 实验性 | 兼容性差 |

## 置信度线索

- **确定**：`Problematic frame` 明确指向 `libmobileglues.so` / `libGLES_*.so` 等转译层，且栈中有 GL 调用
- **较确定**：崩溃在窗口创建阶段 + 无 Java 异常 + 有 `hs_err_pid*.log`
- **需追问**：日志未标明渲染器名称与版本时，向用户确认（启动器界面里可见）
