# 实战案例：原生库与 Java 运行时（libc/libm 依赖、ABI 不符、JPMS 告警、hs_err 硬崩）

本条汇集 logshare.cn 生产 AI 分析记录中**已核实**的原生库 / Java 运行时故障。抽象规则见
`patterns/native-lib-abi-mismatch.md`、`patterns/native-symbol-resolution-failure.md`、
`patterns/java-runtime-mobile.md`、`format/hs-err.md`，本条只给**真实形态**。

这一类故障的共同特征：**报错文本由 Android 链接器（`dlopen`）或 JVM 自己给出，不是 Minecraft 的
Java 异常**。因此 `Caused by:` 链里的类名往往指向模组，而真正的失败点在 `.so` 文件本身。

## 签名 (Signature)

**案例 1：库自己在运行期 `dlopen("libc.so.6")`（MC 1.21.11 / FCL，logId: 245JyZa）**

```
Caused by: java.lang.ExceptionInInitializerError: Exception java.lang.RuntimeException: java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6(error = undefined symbol: Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror) [in thread "Render thread"]
	at knot//com.ishland.fabric.rsls.RSLSInjectorLWJGL.<clinit>(RSLSInjectorLWJGL.java:63)
	at knot//com.ishland.fabric.rsls.common.SourcesLimitProber.probeSourcesLimit(SourcesLimitProber.java:13)
	at knot//com.ishland.fabric.rsls.common.RSLSConfig.<clinit>(RSLSConfig.java:22)
	at knot//com.ishland.fabric.rsls.RSLSMod.onInitializeClient(RSLSMod.java:45)
```

同一根因、链接器给出不同错误文本的两种写法：

```
Caused by: java.lang.ExceptionInInitializerError: Exception java.lang.RuntimeException: java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6(error = dlopen failed: library "libc.so.6" not found) [in thread "Render thread"]
	at knot//com.ishland.fabric.rsls.RSLSInjectorLWJGL.<clinit>(RSLSInjectorLWJGL.java:63)
	at knot//com.ishland.fabric.rsls.common.SourcesLimitProber.probeSourcesLimit(SourcesLimitProber.java:13)
	at knot//com.ishland.fabric.rsls.common.RSLSConfig.<clinit>(RSLSConfig.java:22)
```
（logId: WhnUZlA，模组 `rsls` = Raise Sound Limit Simplified 1.1.15）

```
java.lang.UnsatisfiedLinkError: Failed to dynamically load library: libc.so.6(error = null)
	at knot//org.lwjgl.system.linux.LinuxLibrary.loadLibrary(LinuxLibrary.java:34)
	at knot//org.lwjgl.system.linux.LinuxLibrary.<init>(LinuxLibrary.java:21)
	at knot//org.lwjgl.system.APIUtil.apiCreateLibrary(APIUtil.java:128)
	at knot//me.cortex.voxy.common.util.ThreadUtils.<clinit>(ThreadUtils.java:30)
	at net.minecraft.client.MinecraftClient.handler$fal000$voxy$injectInitWindow(MinecraftClient.java:15633)
```
（logId: J4MvE5d，ZalithLauncher 2.5.3，模组 `voxy`；`error = null` 表示链接器没有给出任何文本）

**案例 2：模组自带 .so 依赖桌面 glibc 的 soname（logId: 7BODkhZ）**

```
Caused by: java.lang.UnsatisfiedLinkError: /<P>/libopus4j-<...>/libopus4j.so: dlopen failed: library "libm.so.6" not found: needed by /<P>/libopus4j-<...>/libopus4j.so in namespace classloader-namespace
	at jdk.internal.loader.NativeLibraries.load(Native Method) ~[?:?]
	at jdk.internal.loader.NativeLibraries$NativeLibraryImpl.open(Unknown Source) ~[?:?]
	at jdk.internal.loader.NativeLibraries.loadLibrary(Unknown Source) ~[?:?]
```

同一份日志里紧接着是同一组的另外三个库（同一模组的语音链路）：

```
Caused by: java.lang.UnsatisfiedLinkError: /<P>/librnnoise4j-<...>/librnnoise4j.so: dlopen failed: library "libm.so.6" not found: needed by /<P>/librnnoise4j-<...>/librnnoise4j.so in namespace classloader-namespace
Caused by: java.lang.UnsatisfiedLinkError: /<P>/libspeex4j-<...>/libspeex4j.so: dlopen failed: library "libm.so.6" not found: needed by /<P>/libspeex4j-<...>/libspeex4j.so in namespace classloader-namespace
Caused by: java.lang.UnsatisfiedLinkError: /<P>/liblame4j-<...>/liblame4j.so: dlopen failed: library "libm.so.6" not found: needed by /<P>/liblame4j-<...>/liblame4j.so in namespace classloader-namespace
```

同样形态还命中过 `libgcc_s.so.1`（logId: KLSPwvN、VrrK8OU，库同为 `libopus4j.so`）、
`libc.so.6`（logId: SndZ96C、gMMlzXn、i2z1T4i，库为 `jn<...>.tmp` 与 `libjunixsocket-native-2.6.2.so`）、
`libudev.so.1`（logId: Dca84KT，`org.hid4java.HidException: Hidapi did not initialise: dlopen failed: library "libudev.so.1" not found`）。

**案例 3：Distant Horizons 的 zstd 原生依赖（MC 1.20.1 / Fabric Loader 0.20.0 / FCL，logId: MX3XehR）**

```
java.lang.UnsatisfiedLinkError: /<P>/libzstd-jni_dh-1.5.7-<H>.so: dlopen failed: library "libpthread.so.0" not found: needed by /<P>/libzstd-jni_dh-1.5.7-<H>.so in namespace clns-9
no zstd-jni_dh-1.5.7-12 in java.library.path: /<P>/lib:/<P>/jli:/<P>/server:/system/lib64:/vendor/lib64:/<P>/hw:/system_ext/lib64:/<P>/jna:/<P>/app_runtime_mod:/<P>/arm64
Unsupported OS/arch, cannot find /<P>/libzstd-jni_dh-1.5.7-12.so or load zstd-jni_dh-1.5.7-12 from system libraries. Please try building from source the jar or providing libzstd-jni_dh-1.5.7-12 in your system.
```

该模组把这层失败包装成了自己的提示语：

```
Description: Distant Horizons critical setup error: One or more libraries are either in-accessible, corrupted, or overwritten by another mod. Error: [/<P>/libzstd-jni_dh-1.5.7-<H>.so: dlopen failed: library "libpthread.so.0" not found: needed by /<P>/libzstd-jni_dh-1.5.7-<H>.so in namespace clns-9
```

**案例 4：下载到了错误 CPU 架构的 .so（logId: 7HWhiCO、0nS1edZ）**

```
java.lang.UnsatisfiedLinkError: /<P>/libimgui-java64.so: dlopen failed: "/<P>/libimgui-java64.so" is for EM_X86_64 (62) instead of EM_AARCH64 (183) (Possible cause: can't load AMD 64 .so on a AARCH64 platform)
	at java.base/jdk.internal.loader.NativeLibraries.load(Native Method) ~[?:?] {}
```

```
Caused by: java.lang.UnsatisfiedLinkError: /<P>/libPhysXJniBindings_64.so: dlopen failed: "/<P>/libPhysXJniBindings_64.so" is for EM_X86_64 (62) instead of EM_AARCH64 (183) (Possible cause: can't load AMD 64 .so on a AARCH64 platform)
	at jdk.internal.loader.NativeLibraries.load(Native Method) ~[?:?]
```

同一形态另有 logId VTMq5AI、XS2PCbY、RyA0tIV、SYaRNJT、fDtTF54、wmnTA4N。

**案例 5：linker namespace 拒绝跨目录加载（logId: 7HWhiCO、ZhSDbRH）**

```
java.lang.UnsatisfiedLinkError: /<P>/机械动力/<P>/sable_rapier_aarch64_linux.so: dlopen failed: library "/<P>/机械动力/<P>/sable_rapier_aarch64_linux.so" needed or dlopened by "/<P>/libjvm.so" is not accessible for the namespace "clns-10"
```

```
dlopen failed: library "/<P>/libx11cocoainput.so" needed or dlopened by "/<P>/libjnidispatch.so" is not accessible for the namespace "clns-9"
```

**案例 6：符号缺失（不是文件缺失）**

```
Suppressed: java.lang.UnsatisfiedLinkError: /<P>/libtmp<H>libjunixsocket-native-2.6.2.so: dlopen failed: cannot locate symbol "accept4" referenced by "/<P>/libtmp<H>libjunixsocket-native-2.6.2.so"...
```
（logId: gMMlzXn、i2z1T4i，经 Essential 模组加载 `junixsocket-native-2.6.2`）

```
dlopen failed: cannot locate symbol "atrace_get_enabled_tags" referenced by "/<P>/libvulkan_freedreno.so"...
AdrenoSupp: Failed to load Turnip!
```
（logId: udTKz4y，MC 1.20.1 / FCL 1340 / Android SDK 29 / Adreno (TM) 512，Turnip 驱动加载失败）

**案例 7：JRE 自身在启动期硬崩（hs_err，logId: 43Ryqcw，FCL）**

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGILL (0x4) at pc=0x0000006629d309d4, pid=44821, tid=55290
#
# JRE version:  (17.0.10) (build )
# Java VM: OpenJDK 64-Bit Server VM (17.0.10-internal+0-adhoc.runner.openjdk, mixed mode, tiered, compressed oops, compressed class ptrs, g1 gc, linux-aarch64)
# Problematic frame:
# j  java.lang.System.registerNatives()V+0 java.base
#
# The crash happened outside the Java Virtual Machine in native code.
```

**案例 8：class file version 高于当前 JRE（logId: dPMfdoi、KkrVRjq、DIOki4Y）**

```
java.lang.UnsupportedClassVersionError: me/<P>/ForgeSparkMod has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0
	at LAYER PLUGIN/javafmllanguage@1.20.1-47.4.26/net.minecraftforge.fml.javafmlmod.FMLModContainer.<init>(FMLModContainer.java:57)
	at java.base/jdk.internal.reflect.DirectConstructorHandleAccessor.newInstance(DirectConstructorHandleAccessor.java:62)
```

```
java.lang.UnsupportedClassVersionError: net/<P>/ForgeBootstrap has been compiled by a more recent version of the Java Runtime (class file version 60.0), this version of the Java Runtime only recognizes class file versions up to 52.0
	at java.lang.ClassLoader.defineClass1(Native Method)
```
（logId: DIOki4Y）

同类还有模组工具链自己报的：`java.lang.IllegalArgumentException: Unsupported class file major version 69`，
出现在 `Error loading class: java/lang/invoke/MethodHandles$Lookup` 之后（logId: QhrLYts、Y3LJxbg，
启动头为 `▷ Java Runtime: Internal-25`，而游戏是 `Loading Minecraft 1.20.1 with Fabric Loader 0.15.11`
配 `sponge-mixin-0.13.3+mixin.0.8.5.jar`）。

## 含义

**第一层：谁在报错。** 案例 2、3、4、5、6 的错误文本全部由 **Android 链接器（`dlopen`）** 产出，Java 侧
只是把它包成 `java.lang.UnsatisfiedLinkError`，栈顶固定是 `jdk.internal.loader.NativeLibraries.load`。
这一层与 Minecraft 无关——把游戏换版本、把模组换版本都不会改变链接器的结论。

**第二层：`dlopen` 的四种拒绝理由，修法完全不同。**

| 错误文本片段 | 含义 | 缺失的东西 |
|---|---|---|
| `library "X" not found: needed by Y` | Y 的 ELF 头里写了依赖 X，但 X 不在查找路径 | X 这个文件（或它的 soname 别名） |
| `cannot locate symbol "S" referenced by Y` | X 找到了，但 X 不导出 Y 需要的符号 S | 版本对不上的 X |
| `is for EM_X86_64 (62) instead of EM_AARCH64 (183)` | 文件本身是 x86_64 机器码 | 正确架构的 Y |
| `is not accessible for the namespace "clns-N"` | 文件存在，但被 linker namespace 隔离挡在外 | 把 Y 放进可见目录，或换实现 |

**第三层：`library "libm.so.6" not found` 真正说明什么。** Android 的 bionic 提供的是 `libm.so`，
glibc 才叫 `libm.so.6`；`libc.so.6`、`libpthread.so.0`、`libgcc_s.so.1`、`libudev.so.1` 同理。
所以凡是报 `libX.so.N ... not found` 的库，都是**按桌面 Linux 编译并链接了 glibc soname** 的产物。
实测被点名的库是成组的：语音链路 `libopus4j` / `libspeex4j` / `librnnoise4j` / `liblame4j`、
压缩 `libzstd-jni_dh`、Socket `libjunixsocket-native`、输入 `jn<...>.tmp`（HID）。
`in namespace classloader-namespace` 与 `in namespace clns-9` 是同一件事的两种打印形式，前者由
`NativeLibraries` 走 classloader namespace，后者是编号后的同名 namespace。

**第四层：案例 1 与案例 2 是同一件事的两个阶段。** 案例 1 里 LWJGL 主动
`System.loadLibrary("libc.so.6")`（glibc 写法），移动端实际拿到的是**启动器放在
`app_runtime_mod/`（FCL）或 `MOD_ANDROID_RUNTIME`（ZalithLauncher）里的兼容桩**。
桩存在但缺少 LWJGL 需要的 JNI 导出 `Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror` 时，
得到 `undefined symbol: ...`；桩完全不存在时，得到 `library "libc.so.6" not found` 或 `(error = null)`。
三种文本的共同点是**都以 `Failed to dynamically load library: libc.so.6` 开头**，
这个前缀本身就是判据。

**第五层：Java 层的版本错配靠 `class file version` 判定。** 报错里的两个数字直接给出结论：

| class file version | 对应 Java | 实测场景 |
|---|---|---|
| 69 | Java 25 | 模组按 Java 25 编译，跑在 Java 21 JRE 上（`up to 65.0`）|
| 65 | Java 21 | 模组按 Java 21 编译，跑在 Java 8 JRE 上（`up to 52.0`）|
| 61 | Java 17 | 移动端 1.20.x 的常规目标 |
| 60 | Java 16 | `ForgeBootstrap` 一例的编译目标 |
| 52 | Java 8 | 1.12.2 / 1.16.5 时代的常规目标 |

`UnsupportedClassVersionError` 的**左数**是「模组要求」，**右数**（`up to X.0`）是「当前 JRE 提供」，
两者一比对就知道该升 JRE 还是该降模组。

**第六层：hs_err 的 `Problematic frame` 字母指层。** `j` = Java 解释执行帧（问题在 JVM 内部）、
`V` = JVM 生成代码（`libjvm.so`）、`C` = C 原生帧（问题在某个 `.so`）。抽样 685 份日志中 69 份带 hs_err，
帧分布如下：

| Problematic frame | 份数 | 归因方向 |
|---|---|---|
| `j java.lang.System.registerNatives()V+0 java.base` | 10 | JRE 自身在 JVM 引导阶段崩溃 |
| 其余 `j` 帧（如 `LevelRenderer.wrapOperation$zpp000$...`） | 1 | 模组注入后的 Java 帧 |
| `C [libinstrument.so+...]` / `C [libOSMesa_8.so+...]` | 15 / 10 | 第三方 agent / 软件渲染库 |
| `C [libzink_dri.so+...]` / `C [libvulkan_freedreno.so+...]` / `C [libc.so+...]` | 5 / 4 / 3 | GPU 驱动（zink/Vulkan 软栈）、系统 libc |
| `V [libjvm.so+...]` | 6 | JVM 自身代码 |

崩溃信号实测只有两种：`SIGSEGV (0xb) at pc=...`（55 份）与 `SIGILL (0x4) at pc=...`（10 份），
`si_code` 为 `SEGV_MAPERR` / `SEGV_ACCERR` / `ILL_ILLOPC`。

## 常见触发

### 触发 A：模组自带的 .so 依赖 glibc soname（生产最高频）

触发条件与用户操作无关，只取决于**模组作者在哪里编译、用什么链接器**。命中清单（括号内为 logId）：

- 语音组 `libopus4j` / `libspeex4j` / `librnnoise4j` / `liblame4j` 缺 `libm.so.6`（7BODkhZ）
- 同组库缺 `libgcc_s.so.1`（KLSPwvN、VrrK8OU）
- Distant Horizons 的 `libzstd-jni_dh-1.5.7-<H>.so` 缺 `libpthread.so.0`（MX3XehR）
- `libjunixsocket-native-2.6.2.so` 缺 `libc.so.6`，同样缺 `accept4` 符号（gMMlzXn、i2z1T4i）
- HID 输入 `jn<...>.tmp` 缺 `libc.so.6`（SndZ96C）、缺 `libudev.so.1`（Dca84KT）

`MX3XehR` 同时给出了失败后的连锁结果：`no zstd-jni_dh-1.5.7-12 in java.library.path: ...` 与
`Unsupported OS/arch, cannot find /<P>/libzstd-jni_dh-1.5.7-12.so or load ... from system libraries`。
这两行是**同一个原因的下游陈述**，不是第二个问题。

**各启动器的表现差异**（同一 MC 问题，不是不同问题）：

| 启动器（实测） | 打印的细节 | logId |
|---|---|---|
| FCL（`Minecraft argument: Fold Craft Launcher`，`app_runtime/java/jre21`） | `in namespace classloader-namespace`，路径含 `app_runtime_mod` | 7BODkhZ、Dca84KT、GCrXz0u |
| FCL 换 JRE 后同形（`app_runtime/java/jre17`） | 同样的 `clns-9` namespace 与 `app_runtime_mod` 路径 | MX3XehR |
| ZalithLauncher 2.5.3（`▷ Launcher version: 2.5.3`） | 同一簇的 `Failed to dynamically load library: libc.so.6(error = null)`，缓存目录为 `com.movtery.zalithlauncher.v2/cache/` | J4MvE5d |

三者只是**缓存目录名、JRE 版本与 namespace 打印形式不同**，注入点与修法完全一致。
注意同一台设备上 FCL 的 `jre17` 与 `jre21` 都会命中同一批 `.so`——这是模组自带的原生库问题，
**换启动器 JRE 不解决**（与触发 E 的 JRE 崩溃不同，判据也不同）。

### 触发 B：LWJGL 与 Android 链接器不匹配（案例 1）

`rsls`（Raise Sound Limit Simplified）与 `voxy` 都会在客户端初始化阶段主动探测系统资源上限，
探测方式对桌面 Linux 成立、对 Android 不成立，于是 `RSLSInjectorLWJGL.<clinit>` /
`ThreadUtils.<clinit>` 抛 `ExceptionInInitializerError`。
判据是 `Failed to dynamically load library: libc.so.6` 这个前缀本身，后面括号里的 error 文本只是
链接器对该桩文件状态的描述（`undefined symbol: ...` / `library "libc.so.6" not found` / `null` 三种）；
`error = undefined symbol: Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror` 里的符号名属 LWJGL
自己的绑定位面，说明链接器拿到了桩文件但桩不导出该 JNI 符号。

### 触发 C：下载到了错误 CPU 架构的整合包 / 模组包（案例 4）

`is for EM_X86_64 (62) instead of EM_AARCH64 (183)` 是**唯一的架构判据**，且自然语言部分已经写明
`Possible cause: can't load AMD 64 .so on a AARCH64 platform`。实测被命中的是机械动力的
`libimgui-java64.so`（7HWhiCO、XS2PCbY）与物理模组的 `libPhysXJniBindings_64.so`（0nS1edZ、VTMq5AI）。
这两个文件名里的 `64` 指 x86_64 而非 arm64，是整合包按 Windows 分发时的常见残留。

### 触发 D：linker namespace 隔离（案例 5）

模组把 `.so` 放在**模组自己的目录**（如 `机械动力/<...>/sable_rapier_aarch64_linux.so`）并直接 `dlopen`
绝对路径时，Android 的 linker namespace 会拒绝——报错把两个路径都点出来：
`needed or dlopened by "/<P>/libjvm.so"` 表示调用者是 JVM，`is not accessible for the namespace "clns-N"`
表示调用者的 namespace 看不到这个路径。`ZhSDbRH` 的调用者不是 libjvm 而是 `/<P>/libjnidispatch.so`，
说明**JNA 也会触发同一拒绝**。

### 触发 E：JRE 在引导阶段崩溃（案例 7）

`Problematic frame` 是 `j java.lang.System.registerNatives()V+0 java.base` 时，崩溃点在
**JVM 初始化 JDK 原生方法表**的那一刻——此时还没有加载任何模组。配合
`# JRE version:  (17.0.10) (build )`（注意版本号字段为空）与
`Java VM: OpenJDK 64-Bit Server VM (17.0.10-internal+0-adhoc.runner.openjdk, ..., linux-aarch64)`，
可以确认这是启动器自带的 JRE 构建。抽样中 10 份日志共用这一帧，说明它不是偶发的内存损坏。

### 触发 F：JRE 与 MC / 模组的版本错配（案例 8）

两个方向都会发生：

- **模组比 JRE 新**：`class file version 69.0 ... up to 65.0`（模组要 Java 25，JRE 是 21）
- **JRE 比模组旧**：`class file version 60.0 ... up to 52.0`（模组要 Java 16，JRE 是 8）
- **工具链比 JRE 旧**：`Error loading class: java/lang/invoke/MethodHandles$Lookup (java.lang.IllegalArgumentException: Unsupported class file major version 69)` —— 运行在 `Internal-25` 上，
  自带的 Mixin/ASM 读不了 JDK 25 自身的类（class file 69）

## 修复步骤

**触发 A（glibc soname 缺失）**

1. 从报错里读出**两个名字**：`needed by` 后面的那个是「谁的依赖」，`library "X" not found` 的 X 是「缺什么」
2. 该库属于工具链依赖（语音 `libopus4j` 组、`libzstd-jni_dh`、`libjunixsocket-native`）时，**先找上游是否已发布 Android/ARM 构建**；只有桌面构建时，只能移除或在配置里关掉使用它的模组功能
3. Distant Horizons 这类会**在配置里直接放 `.so`** 的模组，注意 `MX3XehR` 的反面提示：不要从别处拷贝同名 `.so` 覆盖，`Distant Horizons critical setup error: One or more libraries are either in-accessible, corrupted, or overwritten by another mod` 正是覆盖后的报错
4. 不要手动往系统目录写 `libm.so.6` / `libc.so.6` 软链接——改动系统分区在 Android 上不可行且会破坏全局环境

**触发 B（rsls / voxy 探测失败）**

1. 确认模组名：报错栈里的 `com.ishland.fabric.rsls.*` 对应 Raise Sound Limit Simplified，`me.cortex.voxy.*` 对应 Voxy
2. 到该模组的发布页找**声明支持 Android / 移动端**的版本；没有就临时移除该模组
3. 这是运行期反射式探测失败，改 `-Xmx`、换渲染器、换 MC 版本都不会改变结论

**触发 C（架构不符）**

1. 用 `EM_AARCH64 (183)` 这个字符串确认设备是 arm64
2. 按**文件名里带 `64` 的 .so 所属模组**去重新下载 arm64 构建（`libimgui-java64.so` → 对应模组；`libPhysXJniBindings_64.so` → 对应模组）
3. 整合包整体是 Windows 版时，换该整合包的 Android / arm64 分发，不要逐个替换 .so

**触发 D（namespace 拒绝）**

1. 该模组需要把 `.so` 释放到**启动器可见的原生库目录**（FCL 的 `app_runtime_mod/`、ZalithLauncher 的 `MOD_ANDROID_RUNTIME`）才能被加载——这是模组与启动器的适配问题，用户侧无解
2. 更新模组（已适配的版本会改走 `System.load` 而不是 `dlopen` 绝对路径）
3. 不要为了绕过隔离去关 SELinux 或改 linker 配置

**触发 E（JRE 引导期崩溃）**

1. 先看 `Problematic frame`：是 `j ...System.registerNatives...` 就**与模组无关**，不要去删模组
2. 在启动器里切换到**另一个 JRE 版本**（FCL 的 `app_runtime/java/jre17`、`jre21`；ZalithLauncher 的 `Internal-17/21/25`）
3. 若所有 JRE 都在同一帧崩溃，怀疑设备 CPU 与 JRE 构建不兼容（`SIGILL` = 非法指令），换启动器的 JRE 构建
4. hs_err 里 `# Core dump will be written. Default location: core.<pid> (may not exist)` 与 `OpenJDK exited with code : 6` 是伴随输出，不是新问题

**触发 F（class file version 错配）**

1. 取报错的左右两个数字，按下表定方向
2. 提升 JRE：在启动器里选更高的 `Java Runtime`（ZalithLauncher 的 `▷ Java Runtime: Internal-NN` 即该项）
3. 或降低模组：到该模组发布页选与当前 MC 版本匹配的构建
4. 出现 `Unsupported class file major version 69` 这类**工具链**报错时，正解是**换回该 MC 版本设计的 JRE**（1.20.1 用 17），而不是升级 Mixin

## 置信度线索

> **份数的读法**：本文所有「份数」都是**抽样观测值**，不是全库比例。观测方式为取生产库最近上传的
> 700 条记录（去重后 685 份日志，2026-10），不同抽样批次之间同一签名的份数可有两倍量级波动
> （例如崩溃信号 SIGSEGV/SIGILL 在前一批是 36/28，后一批是 55/10）。因此只把**签名本身与数量级**
> 当作判据，不要用具体数字去反推「这个问题有多常见」。

- **确定（glibc soname 缺失）**：`dlopen failed: library "libX.so.N" not found: needed by ...`，其中 `X` 属 `libm`/`libc`/`libpthread`/`libgcc_s`/`libudev` 之一。Android 只有 `libX.so`，没有 `.so.N`
- **确定（符号缺失 ≠ 文件缺失）**：`cannot locate symbol "S" referenced by ...`。此时文件找到了，是版本不对
- **确定（架构不符）**：`is for EM_X86_64 (62) instead of EM_AARCH64 (183)`
- **确定（namespace 拒绝）**：`is not accessible for the namespace "clns-N"` 或 `in namespace classloader-namespace`
- **确定（Java 版本错配）**：`UnsupportedClassVersionError ... class file version A, ... up to B`；A 是模组要求、B 是 JRE 提供
- **确定（JRE 自身崩溃）**：`A fatal error has been detected by the Java Runtime Environment` 且 `Problematic frame` 为 `j` 帧（如 `System.registerNatives`）。此帧出现时尚未加载模组
- **较确定（案例 1 的桩文件推断）**：报错含 `Failed to dynamically load library: libc.so.6` 且 `error = undefined symbol: Java_org_lwjgl_system_linux_DynamicLinkLoader_ndlerror` 时，可判定为「启动器提供的 `libc.so.6` 兼容桩缺少 LWJGL 的 JNI 导出」；堆栈落在 `com.ishland.fabric.rsls.*` 或 `me.cortex.voxy.*` 时直接锁定该模组
- **需区分：`SIGBUS` 不是崩溃信号**：`SIGBUS: 0x<H> in libjvm.so+<N>` 这类行出现在 hs_err 的**已安装信号处理器列表**里，任何 hs_err 都有；判断崩溃信号只看 `#  SIGXXX (0xN) at pc=` 那一行。实测两轮抽样共 139 份 hs_err 的崩溃信号只有 SIGSEGV 与 SIGILL，没有一份是 SIGBUS
- **需排除（告警，不是根因）**：以下三类在抽样中各出现 三百份左右 / 数十份 / 一百份以上，属**正常告警**，不要据此改 `--add-opens`：
  - `WARNING: Unknown module: net.fabricmc.loader.impl.launch.knot specified to --add-exports`（启动器注入的 `--add-exports/--add-opens` 指向尚未加载的模块）
  - `WARNING: A restricted method in java.lang.System has been called` + `WARNING: java.lang.System::loadLibrary has been called by org.lwjgl.system.Library in module org.lwjgl` + `Use --enable-native-access=org.lwjgl to avoid a warning`
  - `WARNING: A terminally deprecated method in sun.misc.Unsafe has been called` + `WARNING: sun.misc.Unsafe::objectFieldOffset has been called by org.lwjgl.system.MemoryUtil`
- **需排除（告警，不是根因）**：`[OptiFine] (Reflector) java.lang.reflect.InaccessibleObjectException: Unable to make public static long jdk.internal.misc.VM.maxDirectMemory() accessible: module java.base does not "exports jdk.internal.misc"`（16 份）。这是 OptiFine 反射读 JDK 内部类的失败回退，日志会继续
- **需追问**：日志未标 JRE 版本时向用户确认。平台标记为 `▷ Java Runtime: Internal-NN`（ZalithLauncher）或路径 `app_runtime/java/jreNN`（FCL），hs_err 里的 `# JRE version:` 与 `# Java VM:` 也可提供依据
- **需区分**：`no jsound in system library path: /<P>/lib`（数份）是 MIDI 音频子系统的可选依赖缺失，日志继续，不阻断启动；出现它不代表崩溃原因
