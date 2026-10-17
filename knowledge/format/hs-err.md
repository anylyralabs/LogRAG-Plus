# hs_err_pid*.log —— JVM 致命错误文件

## 签名 (Signature)

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGSEGV (0xb) at pc=0x00000001952eaa28, pid=58936, tid=259
#
# JRE version: OpenJDK Runtime Environment Microsoft-33154 (17.0.3+7) (build 17.0.3+7-LTS)
# Java VM: OpenJDK 64-Bit Server VM Microsoft-33154 (17.0.3+7-LTS, mixed mode, tiered, compressed oops, compressed class ptrs, g1 gc, bsd-aarch64)
# Problematic frame:
# C  [CoreFoundation+0x1fa28]  CFArrayGetCount+0x8
#
# An error report file with more information is saved as:
# /home/user/.minecraft/hs_err_pid20774.log
#
# If you would like to submit a bug report, please visit:
#   https://aka.ms/minecraftjavacrashes
#
# The crash happened outside the Java Virtual Machine in native code.
# See problematic frame for where to report the bug.
#

---------------  S U M M A R Y ------------

Command Line: ... -Xmx12288m ... net.minecraft.client.main.Main

Host: AArch64, 16 cores, 58G, Alpine Linux v3.23
Time: Wed Apr  8 10:53:09 2026 UTC elapsed time: 0.280455 seconds (0d 0h 0m 0s)

---------------  T H R E A D  ---------------

Current thread (0x0000ffff7d27f940):  JavaThread "Render thread" [_thread_in_native, id=259, ...]

siginfo: si_signo: 11 (SIGSEGV), si_code: 1 (SEGV_MAPERR), si_addr: 0x0000000000000000
```

Windows 上同一结构以 `EXCEPTION_ACCESS_VIOLATION (0xc0000005)` 开头，且 `# Problematic frame:` 与 `siginfo:` 之间出现 `Java frames:` 段。

## 含义

这是 **HotSpot JVM 自身的致命错误处理器**写出的转储文件，由信号（Unix）或结构化异常（Windows）触发，不是 Java 异常。触发时 JVM 已无法继续运行，进程直接终止，因此**不会有 crash-report，`latest.log` 会戛然而止**。

文件写到 JVM 的工作目录（`cwd`），命名 `hs_err_pid<进程号>.log`；路径可由 `-XX:ErrorFile=` 改写。同一目录可能同时出现 `core.<pid>`（Unix core dump）或 Windows 的 `.mdmp`。

分界：若首部之后出现 `# The crash happened outside the Java Virtual Machine in native code.`，说明出错代码在 JVM 之外的原生库；若 `Problematic frame:` 是 `V` 或 `J` 类帧，则问题在 JVM 或编译后的 Java 代码自身。

## 常见触发

### 首部信号行

```
#  <信号名> (<十六进制码>) at pc=0x<指令地址>, pid=<进程号>, tid=<线程号>
```

| 信号 | 十六进制 | 含义 |
|---|---|---|
| `SIGSEGV` | `0xb` | 非法内存访问，段错误 |
| `SIGBUS` | `0x7` | 总线错误，内存对齐错误或映射文件访问越界 |
| `SIGILL` | `0x4` | 执行了非法指令，通常是指令集不匹配（如 CPU 不支持新指令） |
| `SIGFPE` | `0x8` | 算术异常，如整数除零 |
| `SIGABRT` | `0x6` | 进程主动 abort，多由 C 运行库检测到堆破坏触发 |
| `EXCEPTION_ACCESS_VIOLATION` | `0xc0000005` | Windows 上的段错误等价物 |
| `EXCEPTION_STACK_OVERFLOW` | `0xc00000fd` | Windows 上的栈溢出 |
| `EXCEPTION_ILLEGAL_INSTRUCTION` | `0xc000001d` | Windows 上的非法指令 |

### Problematic frame 行

帧首字母标识帧的种类，来源是 JVM 自带的图例 `(J=compiled Java code, A=aot compiled Java code, j=interpreted, Vv=VM code, C=native code)`：

| 前缀 | 含义 | 判读方向 |
|---|---|---|
| `C  [libxxx.so+0x1234]  函数名+偏移` | 原生库帧 | 看方括号内的库名；库名含模组特征则归该模组，是系统库则归驱动或平台 |
| `J  <序号> c1/c2 <类.方法>(签名)` | 编译后的 Java 代码 | `c1` 为轻量编译，`c2` 为服务端编译；出现在 Java 逻辑层 |
| `j  <类.方法>(...)` | 解释执行的 Java 代码 | 未编译路径 |
| `V  [libjvm.so+0x...]  VM 函数名` | JVM 自身 C++ 代码 | 如 `report_vm_out_of_memory`、`Method::validate_jmethod_id`，指向 JVM 或 JNI 检查失败 |
| `v  ~StubRoutines::<名字>` | JVM 生成的桩代码 | 如 `~StubRoutines::call_stub`，常与 native 调用边界有关 |
| `A` | AOT 编译的 Java 代码 | 同上 |

移动端高发的具体形式：`C  [libgl4es.so+0x...]`（GL 转译层）、`C  [libEGL.so+0x...]`、`C  [libmobileglues.so+0x...]`、`C  [liblwjgl.so+0x...]`、`C  [libvulkan.so+0x...]`、`C  [libcef.so+0x...]`（内嵌浏览器）。这些均属渲染或图形栈，而非模组逻辑。

### S U M M A R Y 段

```
---------------  S U M M A R Y ------------

Command Line: <完整命令行，含全部 JVM 参数与主类>

Host: <CPU 描述>, <核数> cores, <内存>, <操作系统>
Time: <时间> elapsed time: <N> seconds (0d 0h Nm Ns)
```

- `Command Line` 是**唯一完整记录 JVM 参数的位置**：`-Xmx`、GC 选择器、`-Djava.library.path`、`-javaagent`、`net.minecraft.client.main.Main` 等都在此。
- `elapsed time` 显示崩溃距离启动多久。数值极小时（如 `0.280455 seconds`）说明 JVM 启动阶段即崩，常见于架构不匹配或 native agent 问题。
- `Host` 行同时给出架构（`AArch64`、`Intel(R) Core(TM)`）与物理内存，是判断内存不足的关键。

### T H R E A D 段

```
Current thread (0x0000ffff7d27f940):  JavaThread "Render thread" [_thread_in_native, id=259, stack(0x...,0x...)]
```

- 线程名直接对应游戏线程：`Render thread`（客户端渲染）、`Server thread`（服务端逻辑）、`main`（启动主线程）、`Worker-Main-N`（资源加载池）、`Netty ...`（网络）。
- `Current thread is native thread` 表示崩溃线程不由 JVM 管理，通常是 JNI 调用进入的原生代码。
- 线程状态标记：`[_thread_in_native]`（执行原生代码）、`[_thread_in_vm]`（执行 JVM 内部代码）、`[_thread_blocked]`、`[_thread_new]`。
- 其后紧跟 `Stack: [...]`、`Native frames: (J=... C=native code)` 与该线程的 `Java frames:` 段——`Java frames` 是原生崩溃点对应的 Java 调用链。

### siginfo / Registers / Instructions 段

```
siginfo: si_signo: 11 (SIGSEGV), si_code: 1 (SEGV_MAPERR), si_addr: 0x0000000000000000
```

- `si_code` 取值：`SEGV_MAPERR` 表示访问了未映射地址（多为空指针解引用），`SEGV_ACCERR` 表示无权限访问该映射。
- `si_addr` 为 `0x0` 或极小值 → 空指针解引用；地址量级正常但落在已释放区域 → 悬垂指针或内存管理器 bug。
- `Registers`、`Top of Stack`、`Instructions`（出错点前后机器码）属人工调试信息，无自动化价值。

### P R O C E S S 段与堆信息

- `VM state: not at safepoint (normal execution)` / `at safepoint`：后者说明崩溃发生在 STW 暂停点。
- `Heap address: 0x..., size: 3990 MB, Compressed Oops mode: Zero based` 给出堆容量。
- 老版本 JVM 会出现 `Heap:` 段，列出 `PSYoungGen` / `ParOldGen` / `Metaspace` 的 `total / used`；G1 之后的版本改用 `G1 Heap` 与 `garbage-first heap` 形式。
- `Threads class SMR info: ... length=<N>` 与 `Java Threads:` 列表：`length` 异常巨大（数万）说明线程泄漏。

### Dynamic libraries 段

逐行 `<加载基址>  <绝对路径>`（Windows 上为 `<起始>-<结束>  <路径>`）。这是**确认某个原生库是否被进程加载**的唯一权威来源：搜索 `liblwjgl`、`libgl4es`、`libmobileglues`、`libvulkan`、模组自带的 `.so` 名称，可判定缺失或版本无关。列表末尾常见系统库（`kernel32.dll`、`libsystem_malloc.dylib`）。

### vm_info 段与 S Y S T E M 段

```
vm_info: Java HotSpot(TM) 64-Bit Server VM (25.241-b07) for windows-amd64 JRE (1.8.0_241-b07), built on ...

---------------  S Y S T E M  ---------------
OS: Windows 10.0 , 64 bit Build 17134 (10.0.17134.753)
uname: Linux 4.14.146-120.181.amzn2.x86_64 ...
libc: glibc 2.23 NPTL 2.23
CPU:total 8 (initial active 8) (4 cores per cpu, 2 threads per core) family 6 model 158 ... avx2 ...
Memory: 4k page, physical 16731020k(4882164k free), swap 35605388k(12372484k free)
```

- `vm_info` 里 `for <平台>` 部分直接给出运行时目标架构（`windows-amd64`、`linux-aarch64`、`bsd-aarch64`）。
- `libc:` 行在 Android 上不会出现 `glibc` 字样（Android 用 Bionic）。
- `CPU:total` 后的指令集列表（`sse4.2`、`avx2`、`aes`）可用于判断 `SIGILL` 是否由缺少指令集导致。
- `Memory:` 的 `physical ... (Nk free)` 与 `swap` 是判断是否被 OOM 挤压的依据。

### 移动端差异

Android 上该文件的呈现方式与桌面不同：

- 落盘位置取决于启动器设定的工作目录，常见于游戏实例根目录（与 `crash-reports/` 同级），而非固定路径；部分实现写入启动器私有目录。
- 部分启动器会把 JVM 转储重命名为 `crash-dump` 或收进 `logs/native/` 一类子目录，扩展名也可能不是 `.log`。
- 文件名仍保留 `hs_err_pid` 前缀，这是跨平台最稳定的识别特征。
- Android 的 `libc:` 与 `S Y S T E M` 段信息明显偏少，`OS:` 行往往只给出 kernel 版本。
- 首部通常不出现 `Core dump will be written` 段——Android 默认关闭 core dump。

## 修复步骤

**按 Problematic frame 的库名分流**

1. 方括号内为渲染栈库（`libgl4es.so`、`libEGL.so`、`libmobileglues.so`、`libvulkan.so`、`liblwjgl.so`、`libGL.so`、`libcef.so`）→ 归渲染层，优先更换渲染器或图形后端，不要先删模组。
2. 方括号内为模组自带的 `.so`（路径落在实例或缓存的 Mods 目录）→ 该模组的原生部分，更新或移除该模组。
3. 方括号内为平台系统库（`CoreFoundation`、`IOKit`、`libsystem_*`、`ntdll.dll`）→ 平台层问题，常见于输入设备枚举、窗口管理或驱动。
4. 帧前缀为 `V`（`libjvm.so` / `jvm.dll`）→ 读其函数名：含 `out_of_memory` 者是内存不足；含 `validate_*` / `jniCheck` 者是 JNI 参数校验失败，指向调用 JNI 的原生库。
5. 帧前缀为 `J` / `j` → 问题在 Java 逻辑层，转按 Java 异常路径排查，但仍与直接内存（`Unsafe`）操作高度相关。

**按信号分流**

1. `SIGSEGV` 且 `si_addr` 极小 → 先查 `Current thread` 的 Java frames，判断是否在渲染初始化或 native 调用边界。
2. `SIGILL` → 检查 `S Y S T E M` 段的 CPU 指令集与 `vm_info` 的目标平台是否一致；指令集不匹配时任何配置都无效。
3. `SIGBUS` → 检查可用磁盘空间与存档所在文件系统，映射文件被截断会触发该信号。
4. Windows 的 `EXCEPTION_ACCESS_VIOLATION` 且 `Problematic frame` 为 `J ... sun.misc.Unsafe.putLong` 之类 → 指向直接内存或 `Unsafe` 使用越界。

**按 Command Line 与 Host 核对资源**

1. 读 `Command Line` 里的 `-Xmx`，与 `Host` 行的物理内存对比：`-Xmx` 超过物理内存一半时先按内存参数处理。
2. `elapsed time` 极小 → 问题在启动阶段，检查 `Command Line` 中的 `-javaagent`、`-agentpath` 与 `-Djava.library.path`。
3. `Threads class SMR info` 的 `length` 异常大 → 线程泄漏，非单点崩溃。
4. 崩溃线程为 `Render thread` 且 `_thread_in_native` → 判定为渲染层原生崩溃而非游戏逻辑。

**判定是否需要继续找其他日志**

1. 有 `hs_err_pid*.log` 却同时存在 `crash-reports/*.txt` → 后者是 Java 异常触发的前置崩溃，前者是其后的 JVM 二次崩溃，以 `hs_err` 的 `Problematic frame` 为准。
2. 只有信号行而无完整转储（转储写入失败）→ 只剩首部内容，可用的只有信号名与 `Problematic frame`。
3. 完全无 `hs_err` 而进程被杀 → 属操作系统 OOM Killer，检查 `Host` 行内存与被杀前的内存占用。

## 置信度线索

- **确定**：首部含 `# A fatal error has been detected by the Java Runtime Environment`，且 `# Problematic frame:` 给出库名。据此可确定崩溃发生在原生层、并锁定库。
- **确定**：`Problematic frame` 前缀为 `C` 且库名为渲染栈库，可确定问题属于图形层而非模组逻辑。
- **较确定**：`siginfo` 的 `si_addr` 为 `0x0000000000000000`，指向空指针解引用。
- **较确定**：`S U M M A R Y` 的 `elapsed time` 小于数秒，可确定问题发生在启动阶段。
- **较确定**：`# The crash happened outside the Java Virtual Machine in native code.` 出现时，可确定不需要排查 Java 堆与 GC。
- **需追问**：`Dynamic libraries` 段缺失时无法确认原生库加载情况；此时须向用户确认渲染器名称与版本、设备 SoC 架构，以及启动器内是否开启过自定义图形后端。
- **需追问**：Android 上未找到 `hs_err_pid*` 文件时，须向用户确认启动器的日志导出功能是否包含 native 日志目录。
