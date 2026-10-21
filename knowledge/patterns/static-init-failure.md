# 模组静态初始化失败（`ExceptionInInitializerError`、`NoClassDefFoundError: Could not initialize class`）

模组的 `static { }` 块或静态字段初始化器抛了异常，类初始化中止。
之后**任何**对该类的引用都会变成 `NoClassDefFoundError: Could not initialize class`——
所以日志里的「第一个」错误往往不是根因，真正的原因被埋在后面。

## 签名 (Signature)

首次失败（真正的根因在这里）：

```
java.lang.ExceptionInInitializerError
	at com.example.mod.SomeRegistry.<clinit>(SomeRegistry.java:42)
Caused by: java.lang.RuntimeException: <真正的原因>
```

后续连锁（大量出现，会掩盖根因）：

```
java.lang.NoClassDefFoundError: Could not initialize class com.example.mod.SomeRegistry
```

静态初始化里读路径 / 读配置的典型形态：

```
Caused by: java.nio.file.InvalidPathException: Illegal char <:> at index 4: 1945: /storage/…
Caused by: com.google.gson.JsonSyntaxException: Expected BEGIN_OBJECT but was STRING
```

## 含义

**类初始化是一次性的、不可重试的**。JVM 第一次访问某类的静态成员时执行 `<clinit>`，
若抛异常，该类被标记为 `erroneous`，此后所有访问直接抛 `NoClassDefFoundError`，
**不会再执行一次**。

这个机制造成两个判读陷阱：

| 陷阱 | 后果 |
|---|---|
| 顺着 `NoClassDefFoundError` 查 | 会以为是「类缺失 / jar 少了」，实际类在，只是初始化失败过 |
| 看到大量同一个 `Could not initialize class` | 以为是一堆独立故障，实际是**一个**根因的连锁 |

因此判读顺序必须是**从下往上**：先找 `ExceptionInInitializerError`，
再找它的 `Caused by`，那才是根因。

## 常见触发

- **触发 A：静态初始化器里做 I/O**
  - 读配置文件、读路径、建目录（`Path.of` / `Files.readAllBytes` / `new File(...)`）
  - 路径含非法字符或编码不对 → 见 `path-encoding-failure.md`
  - 配置文件是空文件或被截断 → 见 `json-config-corruption.md`

- **触发 B：静态初始化器依赖尚未就绪的东西**
  - 在 `<clinit>` 里访问 Minecraft 的注册表 / 资源管理器，而此时它们还没建好
  - 与 `mod-config-timing-failure.md` 是同一个家族：**时序**问题，
    区别是那条发生在事件回调里，本条发生在类初始化里

- **触发 C：静态初始化器里调用会抛检查异常的逻辑**
  - 版本检测、特性探测（如 `Sodium` 检测到 PojavLauncher/FCL 环境主动抛异常拒绝初始化）
  - 第三方库初始化失败（JNI 加载、原生库符号缺失）

- **触发 D：两个模组互相静态引用**
  - A 的 `<clinit>` 访问 B 的静态字段，B 的 `<clinit>` 又访问 A → 一方看到另一方「未初始化完成」

## 修复步骤

**第一步永远是找 `Caused by`，不要看 `NoClassDefFoundError`。**

1. **在日志里搜 `ExceptionInInitializerError`**
   - 找到后看它下面的 `Caused by:`
   - 若有多条，看**最早**的那一条（时间戳最早 / 行号最小）

2. **按 `Caused by` 的类型分派**
   - `InvalidPathException` / `MalformedInputException` → 走 `path-encoding-failure.md`
   - `JsonSyntaxException` / `EOFException` → 走 `json-config-corruption.md`
   - `NullPointerException` → 该模组在配置或注册表就绪前读它们；
     通常是**模组自身 bug**，处置是更新或移除该模组
   - `UnsatisfiedLinkError` / `NativeLibrary` → 走 `native-symbol-resolution-failure.md`
   - 自定义异常（如「Sodium 拒绝在 X 环境初始化」）→ 读异常消息，通常直接给出结论

3. **确认是哪个模组**
   - `<clinit>` 堆栈里的包名就是肇事模组
   - 若包名是混淆后的短名（如 `a.b.c`），改用「`Caused by` 的类名」或
     「日志里 `Loading N mods` 列表对照 jar 名」来定位

4. **处置**
   - 模组自身 bug → **更新到最新版**；无新版则移除
   - 路径/配置问题 → 按对应条目修
   - 触发 D（互相静态引用）→ 移除其中一个

**不要做的**：
- 不要顺着 `Could not initialize class` 去「补 jar」——类大概率就在，补了没用
- 不要在同一份日志里同时处理多个 `NoClassDefFoundError`，它们通常是一个根因

## 置信度线索

- **确定**：日志里同时有 `ExceptionInInitializerError` 与其 `Caused by`
  → 根因就是那个 `Caused by`
- **确定**：只有 `Could not initialize class` 而找不到 `ExceptionInInitializerError`
  → 说明首次失败发生在本次日志记录之前（日志被截断或只给了 `latest.log` 的后半段），
  应要求用户提供完整日志
- **很可能**：`<clinit>` 出现在堆栈第一行 → 静态初始化失败
- **需区分**：
  - 与 `mod-jar-corruption.md` 的区别：那条是 `NoClassDefFoundError` 但**类真的不在**
    （jar 损坏 / 缺依赖），本条是类在但初始化失败过。判据：前者日志里会有
    `zip END header not found` 之类，后者没有
  - 与 `class-loading-failure.md` 的区别：那条讲类加载器隔离（同一个类被两个加载器加载），
    本条讲单个类的初始化过程
- **实测频次**：生产语料中「静态初始化」相关根因 351 条（约 3.9%），
  是被低估的一类——因为它的表象（`Could not initialize class`）看起来像「缺 jar」
