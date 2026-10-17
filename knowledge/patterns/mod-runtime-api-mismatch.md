# 模组与运行时接口不匹配（配置读取时机、重复传参、旧式类加载器）

## 签名 (Signature)

```
joptsimple.OptionException$MultipleArgumentsForOptionException: Found multiple arguments for option gameDir
java.lang.IllegalStateException: Cannot get config value before config is loaded
java.lang.NoSuchMethodError: 'void com.example.render.RenderSystem.clearFrameRate(com.example.Surface)'
java.lang.IllegalStateException: No context is current or a function that is not available in the current context was called
java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader cannot be cast to class java.net.URLClassLoader
java.lang.NoClassDefFoundError: customskinloader/fake/itf/IFakeIResourceManager
com.google.gson.JsonParseException: Not a JSON Object: null
```

## 含义

这一族报错的共同点是：**代码在编译时针对的接口，与运行时实际存在的接口不一致**。
表现形式依错位发生的位置而不同：

| 报错 | 错位发生在 |
|---|---|
| `MultipleArgumentsForOptionException` | 启动参数（同一个选项被给了两次） |
| `Cannot get config value before config is loaded` | 生命周期时机（太早读配置） |
| `NoSuchMethodError` | 方法签名（编译时有、运行时无） |
| `No context is current` | 图形上下文（调 GL 的线程没有绑定上下文） |
| `AppClassLoader cannot be cast to URLClassLoader` | 类加载器类型（旧式 coremod 假定） |
| `NoClassDefFoundError: customskinloader/...` | 加载器适配层（针对另一加载器编译） |
| `Not a JSON Object: null` | 配置文件内容（文件里就是 `null`） |

它们都不是「手机不行」或「内存不够」这类环境问题，因此**不要**用改内存、换渲染器的方式去试。

## 常见触发

### 触发 A：启动参数重复（`Found multiple arguments for option gameDir`）

游戏启动参数的解析器（Forge 使用的 `joptsimple`）规定 `gameDir` 这类选项**只能给一次**，
收到两次即抛错并中止启动。

成因几乎总是：启动器的「自定义 Java 参数」或「自定义启动参数」里手填了 `--gameDir`，
而启动器自己也会生成一份。玩家在照抄网上教程添加参数时最容易踩这个。

**判据**：报错里点名的选项名（`gameDir`、`assetsDir`、`assetIndex`、`username` 等）就是被重复的那一项。

### 触发 B：配置读取时机过早（`Cannot get config value before config is loaded`）

模组在自己的类初始化阶段（静态字段）或极早的加载事件里去读配置项，而此时 Forge 的配置系统
还没装载完成。

**性质**：这是**模组自身的代码缺陷**，与玩家的配置内容无关——配置写对也一样报。
**判据**：报错前一行通常是某个模组命名空间的类名，那就是源头模组。

### 触发 C：方法签名不存在（`NoSuchMethodError: ... clearFrameRate(...)`）

模组调用了一个在当前运行时里不存在的方法。`NoSuchMethodError` 与
`NoClassDefFoundError` 的区别很重要：前者是**类找到了但方法没有**，
意味着模组针对的是**另一版本的库**（渲染库、加载器 API、工具库）。

**判据**：`NoSuchMethodError: '<返回值类型> <类名>.<方法名>(<参数类型>)'` 里给出的
类名就是错位的那一方；去该类的持有方（渲染器/加载器/前置库）确认版本。

### 触发 D：图形上下文不在当前线程（`No context is current or a function that is not available in the current context was called`）

调用 OpenGL 函数时，当前线程没有绑定 GL 上下文，或该函数在当前 GL 版本/上下文中不可用。

移动端特别容易出这个，因为转译层（GL4ES / Krypton Wrapper / MobileGlues）对
**非渲染线程调用 GL** 以及**高版本 GL 特性**的支持不完整：

- 模组在后台线程里做渲染准备 → 该线程没有上下文；
- 模组用了转译层未实现的 GL 入口点 → 同一个报错措辞。

**判据**：看栈帧里调用点所在的线程名（`Render thread` vs `Worker-*`）。
发生在 `Worker-*` 上基本可以确定是线程问题。

### 触发 E：旧式 coremod 机制的类加载器假定（`AppClassLoader cannot be cast to URLClassLoader`）

Forge 1.7.10 时代的 `LaunchWrapper` 体系假定应用类加载器是 `URLClassLoader` 的子类，
并据此做强制类型转换。在更新的 JVM（Java 9+ 模块化类加载器）或第三方启动器自带的
加载器（如 Mio 系列在 1.7.10 上使用的 `MioLaunchWrapper`）下，这个假定不成立。

**性质**：属于**旧版本生态 + 新 JVM / 第三方加载器**的组合问题，与手机硬件无关。
**判据**：日志里同时出现 `LaunchWrapper` / `MioLaunchWrapper` / `1.7.10` 等字样。

### 触发 F：皮肤模组的加载器适配类缺失（`NoClassDefFoundError: customskinloader/fake/itf/IFakeIResourceManager`）

`CustomSkinLoader` 用一层「适配类」对接不同加载器的内部接口。
`fake/itf/` 下的类名说明它试图适配的接口在当前加载器版本里不存在（加载器升级后接口变了），
于是一旦加载到该分支就抛 `NoClassDefFoundError`。

**判据**：此类报错通常出现在启动后期、紧跟 `CustomSkinLoader` 的初始化行。
同一份日志里若还有 `IFakeIResourceManager` 之外的加载器版本信息，以实际加载器版本为准。

### 触发 G：配置文件内容是 `null`（`Not a JSON Object: null`）

Gson 解析时读到的 JSON 文本**就是字面量 `null`**（不是对象）。空文件通常报的是别的错，
`null` 这条例外说明文件里确实写着 `null`，或写入过程把内容截断成了 `null`。

**判据**：报错前的上下文会给出正在读取的文件路径。删除该文件让其重新生成是最快的修复。

## 修复步骤

1. **触发 A**：在启动器设置里找到「自定义 Java 参数 / 启动参数」，删掉手填的 `--gameDir` 等同名选项；不确定时先清空自定义参数再启动。
2. **触发 B**：确认源头的模组名（报错前一行的模组命名空间）→ 更新该模组到与当前 MC / 加载器一致的版本；若无新版则移除。
3. **触发 C**：取 `NoSuchMethodError` 报文里的类名 → 判断它属于哪一方（渲染器 / 前置库 / 加载器），更新**落后的一方**（通常是模组落后于渲染器）。
4. **触发 D**：更换渲染器（如切到 GL4ES）观察是否消失；若模组在 `Worker-*` 线程调 GL，只能等模组修复或移除该模组。
5. **触发 E**：不要尝试改 JVM 参数绕过——把该实例换成 1.7.10 专用的加载器配置，或直接换成更高游戏版本。
6. **触发 F**：更新或移除 `CustomSkinLoader`；若必须保留皮肤功能，选择与当前加载器版本匹配的构建。
7. **触发 G**：按报错前的路径删除该配置文件，重启让游戏重新生成。

## 置信度线索

- `NoSuchMethodError` / `NoClassDefFoundError` 报出的类名**可直接检索**，检索命中率高于用症状描述检索。
- 报错点名了具体选项（`gameDir`）或具体类（`IFakeIResourceManager`）→ 高置信度，可直接给出处置。
- `No context is current` 属于**症状型**报错：相同措辞可能来自线程问题，也可能来自转译层缺少入口点。需看调用点所在线程与渲染器配置才能确定。
- 触发 B / E 属模组或生态的结构性问题，给出「更新/移除」的结论比给出「改设置」的结论更可靠。
