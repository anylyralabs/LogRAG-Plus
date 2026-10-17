# 内存不足（OOM：堆、元空间、直接内存与系统级进程被杀）

## 签名 (Signature)

**JVM 内抛出的 OOM（有 Java 异常栈）**

```
java.lang.OutOfMemoryError: Java heap space
java.lang.OutOfMemoryError: Metaspace
java.lang.OutOfMemoryError: Compressed class space
java.lang.OutOfMemoryError: GC overhead limit exceeded
java.lang.OutOfMemoryError: Direct buffer memory
java.lang.OutOfMemoryError: Unable to create native thread: possibly out of memory or process/resource limits reached
java.lang.OutOfMemoryError: Requested array size exceeds VM limit
```

**JVM 启动阶段即失败（native 内存申请不到，堆还没建成）**

```
OpenJDK 64-Bit Server VM warning: INFO: os::commit_memory(0x0000000700000000, 1073741824, 0) failed;
    error='Cannot allocate memory' (errno=12)
# There is insufficient memory for the Java Runtime Environment to continue.
# Native memory allocation (mmap) failed to map 1073741824 bytes for committing reserved memory.
# Out of Memory Error (os_linux.cpp:3275), pid=11899, tid=11915
```

**系统级 OOM Killer 杀进程（无 Java 栈，日志戛然而止）**

```
Killed
Out of memory: Killed process 11899 (java) total-vm:15234567kB, anon-rss:9876543kB, file-rss:0kB
lowmemorykiller: Kill 'com.tungsten.fcl' (pid 11899), adj 0, size 9876543, to free 1234567
```

**Android 上 `-Xms` 远超物理内存导致的连锁原生崩溃**

```
Java argument: -Xmx15231m
Java argument: -Xms15231m
Command Line: ... -Xmx15231m -Xms15231m ...
Host: AArch64, 8 cores, 14G, Linux
#  SIGSEGV (0xb) at pc=0x000000733735a424, pid=11899, tid=11915
# Problematic frame:
# C  [libbinder.so+0x7d424]  android::Parcel::finishUnflattenBinder(android::sp<android::IBinder> const&, android::sp<android::IBinder>*) const+0x74
Memory: 4k page, physical 15596828k(4362896k free), swap 8388604k(4760304k free)
```

## 含义

「内存不足」不是单一故障，而是**四种物理位置不同**的耗尽。签名落在哪一层，决定修复方向完全不同：

| 签名 | 耗尽的位置 | 与 JVM 堆参数的关系 |
|---|---|---|
| `Java heap space` | Java 堆（受 `-Xmx` 约束） | 调大 `-Xmx` 有效 |
| `Metaspace` / `Compressed class space` | 类元数据区（存 `.class` 结构） | `-Xmx` 无关，受 `-XX:MaxMetaspaceSize` 约束 |
| `Direct buffer memory` | 堆外直接内存（NIO/Netty 分配） | 受 `-XX:MaxDirectMemorySize` 约束 |
| `Cannot allocate memory` / `Native memory allocation (mmap) failed` / 系统 `Killed` | **宿主机物理内存**（JVM 堆 + 元空间 + 线程栈 + 原生库 + 系统） | `-Xmx` **调大反而更容易触发** |

关键在于：`-Xmx` 只约束 Java 堆这一项。JVM 实际占用的常驻内存约为

```
宿主机占用 ≈ 堆(-Xmx) + 元空间(约 150–400 MB，模组多时更高) + 线程栈(数量 × 1 MB)
           + 原生库映射(LWJGL / 驱动 / 转译层) + JIT 代码缓存 + 渲染器与 GPU 驱动占用
```

Android 设备还要额外承担 Android 系统、启动器 App、GPU 驱动与 SurfaceFlinger 的开销。所以「`-Xmx` 开到接近物理内存」不是「内存充裕」，而是**把系统推到 OOM Killer 的射程内**。

`-Xms` 等于 `-Xmx` 且值很大时，JVM 启动即申请（并尽量 commit）全量堆，设备在进入游戏前就已处于内存临界状态。

## 常见触发

### 触发 A：`-Xmx` 过大导致系统级 OOM（移动端最常见）

配置值达到甚至超过设备物理内存，JVM 声称要 commit 的堆超出系统可供给量。

已知实例：`fcl-latest-2646648029949214115.log` 中 `-Xmx15231m -Xms15231m`，而同文件的 hs_err 记录 `Host: AArch64, 8 cores, 14G`、`Memory: 4k page, physical 15596828k`（约 14.9 GB）。进程存活约 42 秒后崩溃。

此类崩溃的表现有两种，取决于哪一层最先撑不住：

- 纯堆申请失败 → `Cannot allocate memory (errno=12)` + `insufficient memory for the Java Runtime Environment`
- 系统级压力传导到非 JVM 组件 → 驱动/SurfaceFlinger 的 binder 事务损坏，在 `libbinder.so` 内触发 `SIGSEGV`（`Problematic frame` 落在 `android::Parcel::*`），此时**崩溃点与内存完全无关，极易被误判为渲染器或系统 bug**

### 触发 B：`-Xmx` 过小导致堆耗尽

堆装不下当前负载：大整合包、高渲染距离、巨型存档、大量实体或区块同时加载。

典型特征：`Java heap space`，并在其前后伴随密集的 `[Full GC (Allocation Failure) ...]` 行。

### 触发 C：模组数量多导致元空间耗尽

每个类都要在 Metaspace 里存结构信息。200+ 模组、大量动态生成类（脚本引擎、字节码生成、Mixin 生成类）会把 Metaspace 推到默认上限。

典型特征：`Metaspace` 或 `Compressed class space`。已实测案例中 Metaspace 用量为 `used 158144K, committed 160704K, reserved 1245184K`（约 154 MB），属大整合包的量级。

### 触发 D：直接内存耗尽

网络库（Netty）、原生绑定、图形库通过 `ByteBuffer.allocateDirect` 申请堆外内存，不计入 `-Xmx`。

典型特征：`Direct buffer memory`，栈中常见 `java.nio.` / `io.netty.` 帧。

### 触发 E：Android 低内存杀手直接杀进程

设备可用内存不足时，Android 的 LMK 会直接杀掉整个启动器进程，Java 层来不及抛出任何异常。

典型特征：**日志在正常 INFO 行处突然中止，没有任何异常结尾**；启动器弹「游戏已停止」但没有 `crash-reports/`，也没有 `hs_err_pid*.log`。

## 修复步骤

**触发 A（`-Xmx` 过大 → 系统级 OOM / 原生崩溃）**

1. 先在日志里读出设备物理内存：搜索 `Host:` 或 `Memory: 4k page, physical` 行
2. 把 `-Xmx` 降到**物理内存的 40%–50%**。14.9 GB 设备建议 `-Xmx4096m`–`-Xmx6144m`
3. 把 `-Xms` 降到明显小于 `-Xmx` 的值（如 `-Xms1024m`）或直接删除 `-Xms`，不要让它等于 `-Xmx`
4. 优先开启启动器内存设置里的**自动分配**开关，由启动器按设备内存给出上限
5. 同步下调渲染距离（如 32 → 8–12）与模拟距离（12 → 4–6）
6. 启动前关闭后台大内存应用（浏览器、通讯类 App 各占 1–2 GB）
7. **不要**把 `libbinder.so` 的 `SIGSEGV` 当作系统或渲染器问题去处理——先按上述步骤把内存降下来再看是否复现

**触发 B（`Java heap space`）**

1. 确认物理内存确实有余量（`Memory:` 行的 free 值），再上调 `-Xmx`，每次加 512–1024 MB
2. 若物理内存已紧张，不能靠加堆解决——按触发 A 的步骤反向降负载
3. 上调无效且 GC 日志显示回收后占用持续爬升，说明存在泄漏，按「停用一半模组」的方式二分定位
4. 创建新世界以排除存档本身过大的因素

**触发 C（`Metaspace`）**

1. 加参数 `-XX:MaxMetaspaceSize=512m`（模组极多时可给 768m）
2. 精简模组数量，尤其是会动态生成类的脚本类与优化类模组
3. 注意 Metaspace 上调会挤占物理内存，需与触发 A 的额度一起计算

**触发 D（`Direct buffer memory`）**

1. 加参数 `-XX:MaxDirectMemorySize=512m`
2. 排查网络增强模组（多人联机、代理、遥测类），尝试停用
3. 降渲染距离与视距，减少图形层一次性申请的缓冲

**触发 E（进程静默被杀）**

1. 这是系统层行为，改 JVM 参数无效，必须降低整体内存占用（合并触发 A 的步骤）
2. 服务器/终端环境查看内核日志：`dmesg | grep -i -E "killed process|oom"`，确认是否命中 OOM Killer
3. 复现时用启动器的日志级别调到最详细，确认日志中止位置是否恒定在同一加载阶段
4. 确认设备剩余存储空间充足（部分场景下存储写满会连带影响内存映射）

## 置信度线索

- **确定（堆/元空间/直接内存）**：出现 `java.lang.OutOfMemoryError:` 加上具体的变体名，方向直接由变体名决定
- **确定（系统级）**：出现 `Cannot allocate memory (errno=12)`、`insufficient memory for the Java Runtime Environment` 或 `Out of memory: Killed process ... (java)`
- **确定（`-Xmx` 配置错误）**：搜索 `Java argument: -Xmx` 或 `Command Line:` 中的 `-Xmx` / `-Xms` 值，与 `Host:` / `physical` 行的物理内存对比——配置值 ≥ 物理内存的一半即高度可疑
- **较确定（Android 连锁原生崩溃）**：`-Xmx` / `-Xms` 配置值异常大 + `Problematic frame` 落在 `libbinder.so` / `libgui.so` 等系统库 + hs_err 中物理内存证明设备实际只有十几 GB。三者同时出现即可判定为内存耗尽导致的系统组件损坏，而非渲染器或模组缺陷
- **较确定（静默被杀）**：日志无异常结尾、无 `crash-reports/`、无 `hs_err_pid*.log`，且设备处于低内存状态
- **需排除**：日志中出现 `InvalidCredentialsException: Status: 401` 一类认证错误时不要据此判断——认证失败不消耗内存，真实崩溃原因仍在上述签名中，需继续查找 `Minecraft Crash Report` / `A fatal error has been detected` 标记
- **需追问**：日志未给出物理内存与 `-Xmx` 设置时，向用户确认设备型号、物理内存大小与启动器内存设置里的具体数值
