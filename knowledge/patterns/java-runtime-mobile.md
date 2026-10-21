# 移动端 Java 运行时问题

## 签名 (Signature)

```
java.lang.UnsupportedClassVersionError: ... has been compiled by a more recent version
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
Error: Could not find Java SE Runtime Environment.
Error: could not find libjava.so
dlopen failed: cannot locate symbol "JVM_InitClassName" referenced by libjava.so
dlopen failed: cannot locate symbol "JNU_GetStringPlatformCharsStrict" referenced by libnet.so
Problematic frame / 崩溃点: System.registerNatives
信号: SIGILL / ILL_ILLOPC
ClassNotFoundException: sun/java2d/SurfaceManagerFactory
```

## 含义

移动端的 Java 运行时由**启动器内置或按需下载**（启动器界面里的 `Internal-8` / `Internal-17` / `Internal-21` / `Internal-25` 即指内置的 Java 版本），因此可能出现：下载不完整、解压损坏、与设备 SoC 不兼容。用户也无法像 PC 那样直接 `java -version` 排查。

## 常见触发

### 触发 A：MC 版本与 Java 版本不匹配

| Minecraft 版本 | 最低 Java |
|---|---|
| ≤ 1.16.5 | Java 8 |
| 1.17 – 1.20.4 | Java 17 |
| 1.20.5 – 1.21.x | Java 21 |
| **26.x** | **Java 25** |

选错的后果：`UnsupportedClassVersionError`（明确），或运行时诡异崩溃（隐晦）。

### 触发 B：内置运行时损坏或缺失

运行时文件解压不完整，或运行时内部的 `libjvm.so` 与 `libjava.so` 版本不匹配。

典型特征：多条 `[ERROR] DLOPEN: ... failed (cannot locate symbol "JVM_*")`，随后 `could not find libjava.so`。

### 触发 C：运行时与 SoC 不兼容（SIGILL）

Java 运行时按特定指令集编译，某些设备/容器环境不提供该运行时期望的指令。

典型特征：**崩溃发生在 JVM 创建阶段**（尚未加载游戏）；信号是 `SIGILL`（非法指令）而非 `SIGSEGV`；设备为特殊 SoC（麒麟 / Exynos / 紫光展锐）；**换渲染器无效**（因为还没到图形初始化）。

### 触发 D：JVM 参数不当

**注意本节只适用于 Android 移动端。** PC 服务端的情况**相反**：
`-Xms` 设为与 `-Xmx` 相等是 Aikar's flags 等服务端方案的推荐做法
（如 `-Xms4096M -Xmx4096M`），目的是避免堆扩张带来的 GC 停顿与 CPU 开销，
配合 `-XX:+AlwaysPreTouch` 在启动时一次预触。两者不矛盾，因为约束条件不同：
PC 服务端有独占的物理内存，而 Android 上 JVM 要与系统、启动器、GPU 驱动共享同一块内存，
且系统会在压力下直接杀进程。

| 参数 | 问题（仅限移动端） |
|---|---|
| `-Xms` 等于 `-Xmx` 且值过大 | 启动即申请并 commit 全量堆，系统内存立刻见底，易被 OOM Killer 杀掉 |
| `-Xmx` 超过设备物理内存的一半 | 同上；JVM 常驻内存 ≈ 堆 + 元空间(150–400MB) + 线程栈 + 原生库 |
| `-XX:ActiveProcessorCount=8` | 强制线程数，部分驱动（Mali）多线程处理异常 |

已知实例：`-Xms15231m -Xmx15231m`（设备物理内存约 14.9GB）→ 原生内存耗尽 → SurfaceFlinger 的 binder 事务损坏 → `libbinder.so` 中 `finishUnflattenBinder` 触发 SIGSEGV。

### 触发 E：caciocavallo / AWT 警告（通常无害）

移动端用 **caciocavallo**（cacio）在 Android 上模拟 AWT/Swing。新版 Java 移除了部分内部类，导致 cacio 老版本报 `ClassNotFoundException: sun/java2d/SurfaceManagerFactory`。

**这通常是无害警告，不是崩溃原因。** 只有当它是唯一异常且游戏确实无法启动时，才考虑启动器更新。多数情况下真正的崩溃原因在别处（如 LWJGL 原生库缺失）。

## 修复步骤

**触发 A（版本不匹配）**

1. 在启动器的 Java 设置里选择与 MC 版本匹配的运行时
2. 26.x 必须用 Java 25；1.17–1.20.4 用 Java 17

**触发 B（运行时损坏）**

1. 打开启动器的「Java / 运行时管理」，**删除该运行时并重新下载安装**（首选）
2. 若启动器有「校验 / 修复运行时」功能，先试它
3. 确认设备**存储空间充足**——运行时解压中断是常见成因
4. 仍失败则重装启动器（务必选 arm64-v8a 包）

运行时目录在**应用私有空间**（`/data/user/0/<包名>/files/...`），普通用户无法直接访问。必须通过启动器自带的管理功能操作，不要用文件管理器删除。

**触发 C（SoC 不兼容）**

1. **更换 Java 运行时版本**（切换 Internal-17 / Internal-21 / Internal-25，每次切换后重启验证）
2. 若设备运行在**多用户 / 应用分身 / 容器环境**（路径形如 `/data/user/124/`），改到主用户环境运行
3. 查找为特定 SoC 修复过的 Java 构建
4. **不要在渲染器上做调整**——崩溃发生在 JVM 创建阶段，换渲染器无效

**触发 D（JVM 参数）**

1. 内存改为 **4096–6144 MB**（或开启启动器的「自动分配」）
2. **不要让 `-Xms` 等于 `-Xmx`**
3. 降低渲染距离（32 → 8–12）与模拟距离（12 → 4–6）

**触发 E（cacio 警告）**

1. 通常无需处理，先排查其他崩溃原因
2. 若确认是唯一异常，更新启动器

## 置信度线索

- **确定**：日志含 `UnsupportedClassVersionError` / `Could not create the Java Virtual Machine` / `cannot locate symbol "JVM_*"`
- **较确定**：`SIGILL` + `System.registerNatives` + 特殊 SoC
- **需追问**：日志未标明使用的 Java 版本时，向用户确认（启动器设置里可见）
