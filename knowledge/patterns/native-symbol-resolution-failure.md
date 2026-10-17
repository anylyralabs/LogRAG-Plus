# 原生库符号解析失败（undefined symbol / cannot locate symbol / linker namespace 拒绝）

## 签名 (Signature)

**依赖 glibc 世界的 soname（Bionic 上根本没有这些文件名）**

```
java.lang.UnsatisfiedLinkError: /data/data/<包名>/cache/fclauncher/libzstd-jni_dh-1.5.7-<数字>.so: dlopen failed: library "libpthread.so.0" not found: needed by /data/data/<包名>/cache/fclauncher/libzstd-jni_dh-1.5.7-<数字>.so in namespace classloader-namespace
java.lang.UnsatisfiedLinkError: /data/…/liblwjgl_nanovg.so: dlopen failed: library "libm.so.6" not found
java.lang.UnsatisfiedLinkError: /data/…/libopus4j.so: dlopen failed: library "libgcc_s.so.1" not found
java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6(error = dlopen failed: library "libc.so.6" not found)
```

**符号查不到（库文件本身加载成功，但动态链接器绑定不了符号）**

```
java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6(error = undefined symbol: Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror)
	at knot//org.lwjgl.system.linux.LinuxLibrary.loadLibrary(LinuxLibrary.java:34)
	at knot//org.lwjgl.system.linux.LinuxLibrary.<init>(LinuxLibrary.java:21)
	at knot//org.lwjgl.system.APIUtil.apiCreateLibrary(APIUtil.java:128)
```

```
Suppressed: java.lang.UnsatisfiedLinkError: /data/data/<包名>/cache/fclauncher/libtmp<数字>libjunixsocket-native-2.6.2.so: dlopen failed: cannot locate symbol "accept4" referenced by "/data/…/libjunixsocket-native-2.6.2.so"...
```

```
AdrenoSupp: Failed to load Turnip!
dlopen failed: cannot locate symbol "atrace_get_enabled_tags" referenced by "/data/app/<包名>/lib/arm64/libvulkan_freedreno.so"...
```

```
dlopen failed: cannot locate symbol "JVM_GetClassName" referenced by libjava.so
dlopen failed: cannot locate symbol "JVM_SetSockOpt" referenced by libnet.so
```

```
Failed to get OpenGL function glGenBuffersARB: undefined symbol: glGenBuffersARB
Failed to get OpenGL function glDeleteBuffersARB: undefined symbol: glDeleteBuffersARB
Error[OSM Loader]: 'OSMesaGetProcAddress' could not find symbol 'OSMesaFlushFrontbuffer'.
Error[Load Symbol]: Failed to load symbol 'OSMesaFlushFrontbuffer': undefined symbol: OSMesaFlushFrontbuffer
undefined symbol: glBufferStorageEXT
```

**linker namespace 拒绝（库在 sdcard / 版本目录下，不在受信路径内）**

```
WARNING: linker: library "/storage/emulated/0/…/controllable_natives/SDL/2.30.12/libSDL2.so" ("/storage/emulated/0/…/libSDL2.so") needed or dlopened by "/data/data/<包名>/app_runtime/java/jre17/lib/server/libjvm.so" is not accessible for the namespace: [name="clns-9", ld_library_paths="", default_library_paths="/data/app/…/lib/arm64:/data/app/…/base.apk!/lib/arm64-v8a", permitted_paths="/data:/mnt/expand:/data/data/<包名>"]
java.lang.UnsatisfiedLinkError: /storage/emulated/0/…/libSDL2.so: dlopen failed: library "/storage/emulated/0/…/libSDL2.so" needed or dlopened by "…/libjvm.so" is not accessible for the namespace "clns-9"
```

```
java.lang.UnsatisfiedLinkError: /storage/emulated/0/…/sable_rapier_aarch64_linux.so: dlopen failed: library "…/sable_rapier_aarch64_linux.so" needed or dlopened by "/data/data/<包名>/app_runtime/java/jre21/lib/server/libjvm.so" is not accessible for the namespace "clns-10"
java.lang.UnsatisfiedLinkError: /storage/emulated/0/…/.pg-native/libpowergridNative5.so: dlopen failed: library "…/libpowergridNative5.so" needed or dlopened by "…/libjvm.so" is not accessible for the namespace "clns-9" (Possible cause: can't load AMD 64 .so on a AARCH64 platform)
```

**JRE 自身组件的符号/入口点缺失（表现为原生崩溃而非异常）**

```
#  SIGSEGV (0xb) at pc=0x<地址>, pid=<数字>, tid=<数字>
# JRE version: OpenJDK Runtime Environment (17.0.10) (build 17.0.10-internal+0-adhoc.runner.openjdk)
# Problematic frame:
# C  [libinstrument.so+0x7318]
Native frames: (J=compiled Java code, j=interpreted, Vv=VM code, C=native code)
C  [libinstrument.so+0x7318]
C  [libinstrument.so+0x184c]
C  [libinstrument.so+0x5984]
j  sun.instrument.InstrumentationImpl.appendToClassLoaderSearch0(JLjava/lang/String;Z)V+0 java.instrument@17.0.10-internal
j  sun.instrument.InstrumentationImpl.appendToBootstrapClassLoaderSearch(Ljava/util/jar/JarFile;)V+10 java.instrument@17.0.10-internal
j  settingdust.lazyyyyy.forge.core.ClassLoaderInjector.injectBootstrap()V+117 lazyyyyy.lexforge.core@0.14.19
j  settingdust.lazyyyyy.forge.core.LazyyyyyHacksInjector.<init>()V+14 lazyyyyy.lexforge.core@0.14.19
```

**JVM 正常启动时会打印的同名行（噪音，务必不要误判）**

```
DLOPEN: loading /data/user/0/<包名>/app_runtime/java/jre21/lib/libinstrument.so
DLOPEN: loading /data/user/0/<包名>/app_runtime/java/jre21/lib/libjava.so
DLOPEN: loading /data/user/0/<包名>/app_runtime/java/jre21/lib/libj2pkcs11.so
```

## 含义

本类故障的共性是：**`.so` 文件被找到了、架构与位数也对，但动态链接器无法完成符号绑定**。这与「原生库与 ABI 不匹配」是两件事——后者是文件本身就不该在这台设备上（`EM_X86_64` vs `EM_AARCH64`、`ELFCLASS32` vs `ELFCLASS64`、直接 `not found`），本类则是**当前运行环境不提供这个库要的东西**。区分依据只看一条：报错里出现的是「找不到依赖的库名」「找不到符号名」「namespace 拒绝」，而不是「架构不对」。

三类根因：

**一、glibc 的 soname 在 Android 上不存在。** Android 用 Bionic，只提供 `libc.so` / `libm.so` / `libdl.so` / `liblog.so` 这类无版本后缀的名字。按 Linux 桌面构建的原生库把 `DT_NEEDED` 写成 `libc.so.6`、`libm.so.6`、`libpthread.so.0`、`libgcc_s.so.1`、`libdbus-1.so.3`，Android 的 linker 按名字找不到就直接拒绝加载整库。注意 26.x 上 `libpthread` 与 `libdl` 已并入 Bionic 的 `libc.so`，但**文件名的查找规则不变**——写死 `libpthread.so.0` 的库照样加载不了。

**二、符号导出面不匹配。** JNI 入口符号（`Java_<类名>_<方法名>`）与 JVM 内部符号（`JVM_*`、`NET_*`）必须由**同一个**原生库导出：

| 缺失符号 | 期望的导出方 | 实际原因 |
|---|---|---|
| `Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror` | 启动器提供的 LWJGL 原生库 | LWJGL 的 Linux 桌面加载器去 `dlopen("libc.so.6")` 里查这个符号，而启动器的 LWJGL 构建没导出它 |
| `JVM_GetClassName` / `JVM_SetSockOpt` / `NET_AllocSockaddr` | JRE 的 `libjvm.so` | JRE 组件不完整或与 Java 侧 jar 版本不匹配，`libjava.so` / `libnet.so` / `libnio.so` 全部加载失败 |
| `atrace_get_enabled_tags` | Android 系统的 `libcutils` / `libnativehelper` | 属平台私有符号，Android 从 7.0 起不向应用导出，于是 Turnip 驱动加载失败 |
| `accept4` | Bionic（API 21+ 才有） | 原生库按更高 API level 构建，运行时缺少该符号（junixsocket 会自动回退到 Java 实现，无害） |
| `glGenBuffersARB` / `glBufferStorageEXT` / `OSMesaFlushFrontbuffer` | 转译层的 GL 函数表 | 渲染器未实现该扩展入口点，查表返回空符号 |

**三、Android linker namespace 限制。** Android 7.0 起每个进程按 namespace 划分可加载路径；应用私有数据目录与 `nativeLibraryDir` 在 `permitted_paths` 内，而 `/storage/emulated/0/…`（sdcard 共享存储）不在。报错里的 `clns-<数字>` 是启动器为 JVM 创建的 classloader namespace，`default_library_paths` 与 `permitted_paths` 会原样打印在警告行里，可直接读出哪些路径被允许。

本类故障在移动端高频（800 篇抽样日志中 57 篇含 `dlopen failed`，占 7.1%），在桌面端也存在同类现象（LWJGL 加载器路径、JRE 组件不完整），但桌面端的 glibc soname 一定存在，不会踩第一条。

## 常见触发

### 触发 A：模组自带按 glibc 构建的原生库

模组打包时用了 PC 端的原生库产物，`DT_NEEDED` 里写着 glibc 的 soname。

典型特征：报错指向 `/data/data/<包名>/cache/fclauncher/` 或启动器的原生库缓存目录（说明是模组从 jar 里解出来的），依赖名为 `libpthread.so.0` / `libm.so.6` / `libgcc_s.so.1` / `libc.so.6`。

实测实例：Distant Horizons 的 `libzstd-jni_dh-1.5.7-6.so` 依赖 `libpthread.so.0`（并额外打出 `Unsupported OS/arch, cannot find /linux/aarch64/libzstd-jni_dh-1.5.7-6.so or load zstd-jni_dh-1.5.7-6 from system libraries`）；Simple Voice Chat 的 `libopus4j.so` / `librnnoise4j.so` 依赖 `libm.so.6`；`liblwjgl_nanovg.so` 依赖 `libm.so.6`；Physics Mod 的 `libPhysXJniBindings_64.so` 同时命中架构不匹配与依赖缺失。

### 触发 B：模组走 LWJGL 的 Linux 桌面加载器

模组调用 `org.lwjgl.system.linux.LinuxLibrary`（LWJGL 为 Linux 桌面提供的库加载器），它按桌面惯例去 `dlopen` 一个「基础库」再从中查 JNI 符号。Android 上这个路径必然失败。

典型特征：`Failed to dynamically load library: <库名>(error = undefined symbol: Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror)`，栈里一定有 `org.lwjgl.system.linux.LinuxLibrary.loadLibrary` → `APIUtil.apiCreateLibrary`。

实测实例：Voxy 模组（`me.cortex.voxy.common.util.ThreadUtils.<clinit>` → `LinuxLibrary.loadLibrary`，报错为 `libc.so.6`）；RSLS 模组（`com.ishland.fabric.rsls.RSLSInjectorLWJGL.<clinit>`）；另有 `libdbus-1.so.3` 版本（目标是加载 dbus）；`sbw` 音效模组在设置 `ALSOFT_CONF` 时命中该路径，但用 `try/catch` 吞掉了，只留一条 `Failed to set ALSOFT_CONF, sound limit may not increase`。

注意：只有 `LinuxLibrary` 出现在栈里时才是本触发；若栈里没有任何 LWJGL 类，说明是纯依赖缺失（触发 A）。

### 触发 C：原生库放在 sdcard / 版本目录下，被 linker namespace 拒绝

模组把 `.so` 解包到游戏目录（`/storage/emulated/0/…`，即 sdcard）再从那里 `dlopen`，即使依赖齐全也会被 namespace 拒绝。

典型特征：`WARNING: linker: library "…" needed or dlopened by "…/libjvm.so" is not accessible for the namespace: [name="clns-<数字>", …]`，方括号里直接列出 `default_library_paths` 与 `permitted_paths`。同一日志里通常有两条——一条 `WARNING: linker:`（框架打印）加一条 `java.lang.UnsatisfiedLinkError`（Java 层抛出的异常）。

实测实例：Sable 的 `sable_rapier_aarch64_linux.so`（放 `.sable/natives`，`clns-10`）；PowerGrid 的 `libpowergridNative5.so` / `libpowergridNative7.so`（放 `.pg-native`，`clns-9` / `clns-10`）；Controllable 手柄模组的 `controllable_natives/SDL/<版本>/libSDL2.so`（`clns-9`，同时依赖 `libm.so.6`）。

注意 `Possible cause: can't load AMD 64 .so on a AARCH64 platform` 这句后缀是**框架的固定建议文案**，出现在 namespace 拒绝的报错里并不代表真的架构不对——本触发里库就是 arm64 的。

命名空间编号（`clns-9` / `clns-10`）随启动器版本与启动次数变化，不能作为识别依据。

### 触发 D：设备未导出平台私有符号，导致驱动/加速库加载失败

启动器内置的第三方驱动依赖 Android 私有符号，而这些符号自 Android 7.0 起不再导出给应用。

典型特征：`AdrenoSupp: Failed to load Turnip!` 紧跟 `dlopen failed: cannot locate symbol "atrace_get_enabled_tags" referenced by "…/libvulkan_freedreno.so"`，同一日志内通常重复两次，随后打印 `Device [Adreno (TM) <型号>] does not support Vulkan 1.2` 与一串缺失的 Vulkan 扩展。

实测：在留存了完整正文的 411 篇抽样日志中，命中 `AdrenoSupp: Failed to load Turnip!` 的只有 2 篇，而 `AdrenoSupp: Loaded Turnip` 有 33 篇——说明 Turnip 在多数设备上能正常加载，本触发是特定设备/系统版本上的少数情况。

### 触发 E：JRE 组件缺 JNI/JVM 入口符号，或 java agent 路径在 Android 上不可用

启动器分发的 JRE 与 Java 侧的 jar 版本不一致，或 JRE 构建时裁掉了部分组件。

典型特征分两种：

1. 纯符号缺失：`dlopen failed: cannot locate symbol "JVM_GetClassName" referenced by libjava.so`，同一日志里 `libjava.so` / `libnet.so` / `libnio.so` / `libzip.so` / `libsctp.so` 会成片报错（缺 `JVM_GetClassName` / `JVM_SetSockOpt` / `NET_AllocSockaddr` 等），游戏无法启动。
2. 原生崩溃：模组调用 `Instrumentation.appendToBootstrapClassLoaderSearch`（java agent 机制）时在 `libinstrument.so` 内部段错误，表现形式是 `# SIGSEGV (0xb) at pc=…` + `# Problematic frame: C [libinstrument.so+0x7318]`，`OpenJDK exited with code : 6`。

实测实例：`lazyyyyy` 模组（`settingdust.lazyyyyy.forge.core.ClassLoaderInjector.injectBootstrap`，日志里紧邻模组自己的 `[main/INFO]: Injecting bootstrap` 行，且命令行含 `-javaagent:…/MioLibPatcher.jar`）；10 篇抽样日志命中 `appendToBootstrapClassLoaderSearch`，全部来自移动端启动器，JRE 均为 `17.0.10-internal`。

### 触发 F：转译层未实现 GL 扩展入口点

渲染器的 GL 函数表里没有该扩展，`wglGetProcAddress` 一类查表返回空符号。

典型特征：`Failed to get OpenGL function <函数名>: undefined symbol: <函数名>`（MobileGlues）、`Error[Load Symbol]: Failed to load symbol '…': undefined symbol: …`（OSMesa 加载器）、`undefined symbol: glBufferStorageEXT`（Krypton / LTW）。

实测：`Failed to get OpenGL function glGenBuffersARB` / `glDeleteBuffersARB` / `glIsBufferARB` 在 MobileGlues 日志里成串出现但**多数无害**（ARB 版本的缓冲函数有 core 版本替代，MC 不依赖）；`OSMesaFlushFrontbuffer` 缺失会直接伴随 `# A fatal error has been detected by the Java Runtime Environment:` 与 `Error[Load Symbol]` 终止（OSMesa 渲染器不可用）。

## 修复步骤

**触发 A（glibc 构建的原生库）**

1. 查该模组发布页是否提供 Android / aarch64 构建，有则替换。
2. 没有则移除该模组——**不要试图手动放一个 `libc.so.6` 或 `libpthread.so.0` 到设备里**：Bionic 与 glibc 不兼容，名称欺骗只会把失败点推到更深处。
3. 依赖的是通用原生库（zstd、opus、SDL）时，先确认启动器的「原生库插件」机制是否已内置对应实现；若内置版本与模组要求的版本号不符，仍会走模组自带的那份。

**触发 B（LWJGL 桌面加载器）**

1. 该模组的原生部分没有做 Android 适配，配置层面无解：更新模组到已适配版本，或移除。
2. 判断依据是栈里有没有 `org.lwjgl.system.linux.LinuxLibrary`；有就属本触发，不要按「JRE 组件损坏」去重装 JRE。
3. 模组用 `try/catch` 吞掉它时（如 `Failed to set ALSOFT_CONF, sound limit may not increase`），功能降级但游戏不会崩——向用户说明这不构成崩溃原因。

**触发 C（namespace 拒绝）**

1. 库文件必须放进启动器能注入到 `LD_LIBRARY_PATH` / `nativeLibraryDir` 的位置：启动器应用私有目录，或打包成插件 APK 由启动器注入 `nativeLibraryDir`。
2. 手动放到 sdcard 根目录、游戏版本目录、`.minecraft` 下通常无效——`permitted_paths` 是 `/data:/mnt/expand:/data/data/<包名>`，sdcard 不在其中。
3. 模组自身把 `.so` 解到游戏目录的（Sable、PowerGrid、Controllable 这类），只能等作者改成使用启动器的原生库机制，或由启动器侧把游戏目录加入允许路径；用户侧无配置性修复。

**触发 D（平台私有符号）**

1. 停用该第三方驱动（启动器设置里的 Turnip / 驱动插件开关），改用系统自带驱动。
2. 换渲染器：Turnip 不可用时用 MobileGlues / Krypton Wrapper / Holy-GL4ES。
3. 升级系统版本可能恢复部分符号导出，但这不取决于启动器，不要据此承诺可修复。

**触发 E（JRE 组件）**

1. 成片 `libjava.so` / `libnet.so` / `libnio.so` 报 `cannot locate symbol` 时，重装 JRE 组件（启动器的「运行时 / 组件管理」），或换一个 JRE 大版本（17 → 21）。
2. `libinstrument.so` 段错误时移除使用 java agent 机制的模组（`appendToBootstrapClassLoaderSearch` 属 agent API，Android 版 JRE 未完整支持）。**不要试图删除 `libinstrument.so`**：JRE 启动时会加载它，删除会让 JVM 自身起不来。
3. 换 JRE 后仍复现，说明该模组与 Android 版 JRE 不兼容，只能移除。

**触发 F（转译层扩展缺失）**

1. 先判断是否有害：`Failed to get OpenGL function gl*ARB` 这类**只在缺少具体功能时才致命**（ARB 缓冲函数有 core 版替代，可忽略）；`Failed to load symbol 'OSMesaFlushFrontbuffer'` 伴随 `# A fatal error` 则说明该渲染器整体不可用。
2. 有害时换渲染器（Krypton Wrapper → MobileGlues → Holy-GL4ES → ANGLE）或更新渲染器版本——扩展入口点由渲染器提供，更新 MC 或模组无效。
3. 需要 Zink / Turnip 一类需要 Vulkan 扩展的渲染器时，先确认设备是否支持所需的 Vulkan 版本与扩展（日志里会打印 `does not support required extensions, missing: […]`）。

## 置信度线索

- **确定（本类故障）**：日志含 `dlopen failed: library "<名字>.so.<数字>" not found`、`dlopen failed: cannot locate symbol "<符号>" referenced by`、`(error = undefined symbol: <符号>)`、`undefined symbol: <符号>` 或 `is not accessible for the namespace` 之一。
- **确定（符号层，不是架构层）**：报错内容为「找不到依赖库名 / 找不到符号名 / namespace 拒绝」。若报错是 `is for EM_X86_64 (62) instead of EM_AARCH64 (183)`、`ELFCLASS32`、或直接 `library "lib<名>.so" not found`（无 `.so.<数字>` 后缀、无 `needed by` 子句），属「原生库与 ABI 不匹配」，不能按本类归因。
- **确定（触发方）**：栈或报错里出现 `org.lwjgl.system.linux.LinuxLibrary` ⇒ 触发 B（模组走桌面加载器）；出现 `/storage/emulated/0/…` 路径 + `needed or dlopened by "…/libjvm.so"` ⇒ 触发 C（namespace）；出现 `JVM_*` / `NET_*` 符号名 ⇒ 触发 E（JRE 组件）。
- **确定（渲染器侧）**：`Failed to get OpenGL function …: undefined symbol: …` 与 `Error[Load Symbol]: Failed to load symbol …` 只在渲染器日志前缀（`MobileGlues` / `OSMesa` / `LTW`）下出现，属渲染器扩展覆盖面问题。
- **注意（最大误判源）**：`libinstrument.so` 在 800 篇抽样日志中出现 394 篇（95.9%），但其中绝大多数是 JVM 启动时自己打印的 `DLOPEN: loading …/lib/libinstrument.so` 清单行与 `/proc/self/maps` 内存映射转储，**不是故障**。只有当它与 `# Problematic frame:` / `C  [libinstrument.so+0x…]` / `appendToClassLoaderSearch0` 同行或同栈出现时，才构成触发 E 的证据。
- **注意（关键词频率）**：800 篇抽样日志中 `dlopen failed` 57 篇（7.1%）、`libc.so.6` 27 篇、`Failed to dynamically load library` 23 篇、`libm.so.6` 22 篇、`undefined symbol` 20 篇、`DynamicLinkLoader` 16 篇、`is not accessible for the namespace` 14 篇、`cannot locate symbol` 7 篇、`libpthread.so.0` 6 篇。移动端占比远高于桌面端。
- **注意（无害情形）**：`cannot locate symbol "accept4" … libjunixsocket-native-2.6.2.so` 由 junixsocket 自动回退到 Java 实现，游戏继续运行；`Failed to get OpenGL function gl*ARB: undefined symbol` 有 core 版替代，同样无害。两者出现在日志里不应作为根因。
- **注意（命名空间编号）**：`clns-9` / `clns-10` 随启动器版本与启动次数变化，同一条 `permitted_paths` 才是稳定信息（它决定了哪些路径被允许加载原生库）。
- **需追问**：日志未给出设备架构（arm64 / armeabi-v7a / x86_64）、JRE 大版本与启动器名称时，应先向用户确认——这三项决定了是「模组无 Android 构建」「JRE 组件损坏」还是「namespace 路径不放行」。
