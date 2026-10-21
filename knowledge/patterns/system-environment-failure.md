# 系统与运行环境层问题（Android 版本缺陷、厂商限制、模拟器与虚拟化）

崩溃不来自 Minecraft、模组或启动器，而来自**操作系统、系统组件或虚拟化层**。
特征是：日志里没有 Java 异常栈，或异常出在 `VpnService` / `Binder` / `libc` 这类系统接口上。

## 签名 (Signature)

Android 系统级 VPN / 网络接口失败（Terracotta、局域网联机）：

```
java.lang.SecurityException: Not allowed to bind to service Intent { act=android.net.VpnService }
	at android.app.ContextImpl.bindServiceCommon(ContextImpl.java:…)
```

`Binder` 调用被系统拒绝 / 事务失败：

```
android.os.DeadObjectException
android.os.RemoteException: Remote stack trace: …
TransactionTooLargeException
```

虚拟化层（模拟器 / 云游戏）的 GPU 与内存限制：

```
[Render thread/ERROR]: Couldn't create window / Could not find any suitable GPU
libGL error: failed to load driver: …
```

厂商 ROM 的进程限制（国产 ROM 常见）：

```
FATAL EXCEPTION: main
Process: <启动器包名>, PID: …
java.lang.OutOfMemoryError: Failed to allocate a … byte allocation
```

## 含义

**故障不在应用层**，所以「更新模组 / 换 Java / 加内存」都不解决问题。
判读的关键是识别**异常发生的层**：

| 层 | 典型线索 | 处置方向 |
|---|---|---|
| Android 框架 | `SecurityException` / `RemoteException` / `VpnService` / `Binder` | 系统权限、系统版本、ROM 限制 |
| 虚拟化 | 无 Java 栈，只有 `libGL` / `EGL` 错误 | 换渲染后端、换模拟器设置 |
| ROM 策略 | 进程被 kill、`OutOfMemoryError` 但堆参数很小 | 电池优化白名单、后台限制 |
| 系统库 | `dlopen failed` / `libc.so` 版本 | 系统版本过低或 ABI 不符 |

这与「模组冲突」的区别很直接：**模组冲突一定有 Java 异常栈且栈顶是模组类**；
本条通常栈顶是 `android.*` / `java.base` / 无栈。

## 常见触发

- **触发 A：Android 新版本的系统组件缺陷**
  - Android 16（SDK 36）的 VPN 相关已知问题：`VpnService` 无法建立连接，
    直接导致 Terracotta / 局域网联机类模组失败
  - 表现为「之前能用，系统更新后就不行」，且换启动器无效

- **触发 B：厂商 ROM 的后台限制**
  - 虚拟内存不足时静默杀进程，日志尾部无异常、直接断
  - 华为 / 小米 / OPPO 等 ROM 的「电池优化」会限制后台进程的内存上限
  - 表现为「跑一会儿自己退」而非「启动即崩」

- **触发 C：模拟器与虚拟化层**
  - GameViewer / MuMu / 雷电等：GPU 直通方式不同，`libGL` 加载失败或 EGL 版本不匹配
  - 表现为渲染相关错误但没有任何模组栈

- **触发 D：系统 ABI 与原生库不匹配**
  - 32 位系统上跑 64 位原生库，或反过来
  - `dlopen failed: is 32-bit instead of 64-bit`

## 修复步骤

**先确认「是不是系统的问题」**，再决定要不要在模组层面折腾。

1. **看异常属于哪一层**（对照上面的表）
   - 栈顶是 `android.*` / `com.android.*` → 系统层，跳到第 2 步
   - 没有 Java 栈、只有原生错误 → 虚拟化或原生库层，跳到第 3 步

2. **系统层**：
   - 查系统版本是否有已知问题（Android 16 的 VPN 缺陷是实例）
   - 关掉该启动器的电池优化 / 加入后台白名单
   - 若只有联机功能的某个模组失败 → **换联机方式**（如改用服务端 + 端口映射，
     绕开 `VpnService`），这是最实际的处置
   - 退版本到已知正常的系统版本（代价高，最后手段）

3. **虚拟化层**：
   - 换渲染后端（如从 VirGL 换到 GL4ES / Zink / MG，见 `ecosystem/renderer-compat.md`）
   - 关掉模拟器的「高帧率 / 高分辨率」以降低显存压力
   - 物理机与模拟器行为不同时，优先信物理机结论

4. **ROM 层**：
   - 关电池优化、允许后台运行
   - 降低游戏内存设置（`-Xmx`）到 ROM 允许的范围
   - 用启动器的「锁定 / 常驻」功能（若有）

**不要做的**：
- 不要因为「内存不足」就无脑调大 `-Xmx`——ROM 层限制下，调大反而更容易被杀
- 不要在模拟器里排查模组冲突：先确认同样配置在物理机上是否正常

## 置信度线索

- **确定**：异常栈顶是 `android.*` 或 `com.android.*`，且日志里没有任何模组类出现在栈上
- **确定**：`SecurityException: Not allowed to bind to service` + `VpnService` → 触发 A
- **很可能**：日志在没有任何异常的情况下突然结束（进程被系统杀）
  → 触发 B，需结合用户描述的「跑一会儿就退」判断
- **需区分**：
  - 与 `out-of-memory.md` 的区别：那条是**堆**不足（有 `OutOfMemoryError: Java heap space` 且
    能对应到 `-Xmx`），本条是**进程被系统杀**（日志无 OOM 或 OOM 的分配量远小于 `-Xmx`）
  - 与 `renderer-compat.md` 的区别：那条在渲染器与 GPU 驱动之间，本条在系统与进程之间
- **实测频次**：生产语料中「系统级 Bug」相关根因 85 条（约 0.9%），
  数量不大但**误判代价高**——一旦判成模组问题，用户会反复装卸模组而永远好不了

**报给谁**（决定处置方向，别报错人）：

- 多个启动器 + 同一系统版本都能复现 → 系统厂商
- 只在特定 ROM + 特定系统版本 → ROM 方
- 只在模拟器 → 模拟器方
- 系统版本正常、只有某个模组失败 → 该模组未适配新系统，报给模组作者

接案所需的最小信息集：**系统版本 + ROM 标识 + 启动器版本 + 是否物理机**。
