# ARM64 设备上的原生库与 ABI 不匹配

## 签名 (Signature)

```
java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6 (error = null)
java.lang.UnsatisfiedLinkError: dlopen failed: library "libxxx.so" not found
java.lang.UnsatisfiedLinkError: Failed to locate library: liblwjgl.so
[LWJGL] Failed to load a library. Possible solutions:
    a) Add the directory that contains the shared library to -Djava.library.path or -Dorg.lwjgl.librarypath.
    b) Add the JAR that contains the shared library to the classpath.
[LWJGL] Platform/architecture mismatch detected for module: org.lwjgl.
        JVM platform: Linux aarch64, platform available on classpath: linux/x64
java.lang.NoClassDefFoundError: Could not initialize class org.lwjgl.system.Library
java.lang.NoClassDefFoundError: Could not initialize class org.lwjgl.glfw.GLFW
dlopen failed: cannot locate symbol "JVM_InitClassName" referenced by libjava.so
ELFCLASS32 / ELFCLASS64 不匹配；EM_X86_64 vs EM_AARCH64
dlopen failed: ... is not accessible for the namespace "classloader-namespace"
relocation ... cannot be used with symbol / undefined symbol: _ZN...
```

## 含义

模组或启动器组件依赖的**原生库（.so）**在 Android 上无法加载。这不是 Java 逻辑错误，而是二进制层面不兼容。

移动端比 PC 更容易踩这个坑，因为四个层面都不同：

| 层面 | PC | Android |
|---|---|---|
| CPU 架构 | 几乎只有 x86_64 | arm64-v8a / armeabi-v7a / x86_64 并存 |
| C 库 | glibc | **Bionic**（无 glibc 的部分文件名与符号） |
| 图形 API | OpenGL 4.x | GLES + 转译层（无桌面 GL） |
| 动态链接器 | ld.so | linker64 + **namespace 限制**（Android 7+） |

模组作者若只发 x86_64 原生库、或直接链接 glibc，在 arm64 手机上必然崩溃。

## 常见触发

### 触发 A：模组缺少 Android 原生依赖

模组自身带 `.so`（如 FFI 绑定、压缩库、物理引擎），但只提供了桌面平台构建。

典型日志特征：`UnsatisfiedLinkError` + 路径在 `/data/user/0/<包名>/cache/` 下的某个 `lib*.so`。

已知实例：Flashback 模组的 `imgui-java`、SDM 商店模组的 `imgui-java 1.89.0`、Distant Horizons 的 `zstd`。

### 触发 B：启动器注入的 LWJGL 原生库不匹配

启动器需为游戏注入 LWJGL（Java 的 OpenGL 绑定），但组件可能：架构不匹配、下载不完整、版本与游戏需求不符（如游戏要 3.4.1 而组件是 3.3.3）。

典型日志特征：`Platform/architecture mismatch`、`Failed to locate library: liblwjgl.so`、`Could not initialize class org.lwjgl.*`。

### 触发 C：C 库不匹配（Bionic vs glibc）

模组按 Linux 桌面构建，直接链接 glibc 的 `libc.so.6`。Android 用 Bionic，**根本没有这个文件名**。

典型日志特征：`Failed to dynamically load library: libc.so.6`，且栈中可见 `org.lwjgl.system.linux.LinuxLibrary.loadLibrary`。

已知实例：Voxy 模组（经 LWJGL 的 Linux 加载器加载 glibc）。

### 触发 D：32 位 / 64 位混装

老启动器/JRE 组合只有 `armeabi-v7a`，而模组只发 `arm64-v8a`（或反之）。

典型日志特征：`ELFCLASS32` vs `ELFCLASS64`、`is 64-bit instead of 32-bit`。

### 触发 E：Android namespace 限制

Android 7.0+ 限制 App 随意 `dlopen` 系统私有库。

典型日志特征：`is not accessible for the namespace "classloader-namespace"`。

## 修复步骤

**触发 A（模组缺原生依赖）**

1. 查该模组发布页是否提供 Android / aarch64 构建
2. 有 → 下载 ARM64 版替换
3. 没有 → 该模组在手机上无法使用，移除或找替代品
4. 若依赖的是通用原生库（如 zstd），查启动器的**原生库插件**机制是否有对应实现

**触发 B（LWJGL 组件问题）**

1. 在启动器的「组件 / 运行时管理」里**重装 LWJGL 组件**（首选）
2. 若无重装入口：用启动器自带的「清除数据 / 重装组件」功能，或卸载重装启动器
   （组件目录在应用私有空间，普通用户无法直接访问，不要试图用文件管理器删除）
3. 确认安装的是 **arm64-v8a** 版本的启动器
4. 仍失败：在 Java 参数加 `-Dorg.lwjgl.util.Debug=true -Dorg.lwjgl.util.DebugLoader=true`，重跑后看日志里具体缺哪个 `.so`

**触发 C（Bionic vs glibc）**

1. 该模组**没有做 Android 适配**，无法通过配置解决
2. 移除该模组，或等作者发布 Android 兼容版
3. **不要尝试手动放一个 `libc.so.6` 进去**——Bionic 与 glibc 不兼容，会引发更严重的崩溃

**触发 D（32/64 位混装）**

1. 优先使用**全 64 位技术栈**（现代 ZalithLauncher2 / FCL 默认如此）
2. 确需 32 位时，所有组件（启动器、JRE、模组原生库）必须统一为 32 位

**触发 E（namespace 限制）**

1. 库文件必须放进启动器能注入到 `LD_LIBRARY_PATH` 的目录
2. 手动塞 `/data/local/tmp` 或 sdcard 根目录通常**无效**
3. 正确做法是打包成插件 APK，让启动器注入其 `nativeLibraryDir`

## 置信度线索

- **确定**：日志原文含上述任一签名 + 明确的 `.so` 路径
- **较确定**：只有 `NoClassDefFoundError: Could not initialize class org.lwjgl.*`（静态初始化失败通常源于原生库问题）
- **需追问**：日志未给出设备架构（arm64 / armv7 / x86）或启动器安装包架构时，应向用户确认手机型号与安装包来源
