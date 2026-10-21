# 路径编码失败（`InvalidPathException`、`__THESEUS_UTF8__` 前缀、非 ASCII 路径）

启动器把游戏目录路径传给模组，模组按「普通字符串」直接交给文件系统，
而路径里含中文、中文冒号或启动器自定义编码前缀时，解析失败。

## 签名 (Signature)

单一签名（最常见，`InvalidPathException` 直接出现在静态初始化器里）：

```
java.nio.file.InvalidPathException: Illegal char <:> at index 4: 1945: /storage/emulated/0/…
	at java.base/sun.nio.fs.UnixPath.normalizeAndCheck(UnixPath.java:77)
	at brazier_modding.gdarp.…
```

带启动器编码前缀（Modrinth Theseus / 部分基于它的启动器）：

```
java.lang.RuntimeException: java.nio.file.InvalidPathException: Illegal char <:> at index 16:
    __THESEUS_UTF8__:L3N0b3JhZ2UvZW11bGF0ZWQvMC8…
```

Android 上目录名含中文冒号（`1945:`）时：

```
java.nio.file.InvalidPathException: Illegal char <:> at index 4: /storage/emulated/0/Games/1945: …
```

## 含义

**路径字符串的来源与消费方约定不一致**。三种形态，机制不同，处置也不同：

| 形态 | 谁的问题 | 机制 |
|---|---|---|
| 目录名含 `:` / `*` / `?` | 用户或启动器 | 这些字符在 Unix 合法、在 Windows 非法；跨平台模组按 Windows 规则校验时直接拒绝 |
| 路径含中文且模组未指定编码 | 模组 | 按平台默认编码解码，Windows 中文系统（GBK）与 Android（UTF-8）结果不同 |
| `__THESEUS_UTF8__:` 前缀 | 启动器 + 模组 | 启动器把含非 ASCII 的路径 Base64 编码后加前缀传递，模组没解码就当路径用 |

关键判断：**看异常里的路径是不是「编码后的乱码」**。是乱码 → 启动器编码约定（形态三）；
是可读但含非法字符 → 形态一；是中文能正常显示但仍失败 → 形态二。

## 常见触发

- **触发 A：游戏目录名带冒号或中文**
  - 目录名如 `1945:`、`1.20.1:整合包`（冒号在 Windows 非法，跨平台模组会拒绝）
  - 移动端把游戏放在 `/storage/emulated/0/我的游戏/` 之类的中文目录
  - 这一类在 Android 上尤其多：Android 允许这些字符，模组却按 Windows 规则校验

- **触发 B：Modrinth Theseus 系启动器 + 静态初始化读路径的模组**
  - 启动器检测到路径含非 ASCII，编码成 `__THESEUS_UTF8__:<base64>` 传递
  - 模组在静态初始化器里直接 `Path.of(该字符串)`，未先解码
  - 典型肇事模组：`globalpacks` / `gdarp`（`net.brazier_modding.gdarp`）

- **触发 C：系统语言或默认编码不匹配**
  - Windows 中文系统默认 GBK，模组读 UTF-8 路径
  - 表现为 `MalformedInputException` 或文件名变成乱码后「找不到文件」

## 修复步骤

**先确认是哪种形态**：把异常信息里的路径字符串抄出来看。

1. **是乱码 / 以 `__THESEUS_UTF8__:` 开头** → 启动器编码问题
   - 把游戏目录改成**纯 ASCII 路径**（如 `/storage/emulated/0/Games/mc/`），
     这是最省事的绕过：启动器不再编码，模组不再误解码
   - 或换用不启用该编码的启动器版本
   - 删掉该模组（如果是它单方面不支持该启动器）

2. **是可读路径但含 `:`、`*`、`?`、`|`** → 目录名问题
   - 重命名目录，去掉这些字符
   - 冒号常见于「版本号 + 备注」的命名习惯（`1.20.1:forge`），改成 `1.20.1-forge`

3. **是中文路径且乱码** → 编码问题
   - 优先：把目录移到纯 ASCII 路径（一次解决，不用逐个排查模组）
   - 或在启动器里为 JVM 加 `-Dfile.encoding=UTF-8`（只对尊重该属性的模组有效）

**通用建议**：移动端与 Windows 之间同步游戏目录时，**目录名只用 ASCII 字母数字与短横线**。
这是唯一能让「所有模组 + 所有启动器」都正常工作的约定；其它做法都要求每个模组各自正确。

**不要做的**：不要试图改模组的 jar、不要相信「改 locale 就好」——
静态初始化器里的路径解析发生在 locale 生效之前。

## 置信度线索

- **确定**：日志含 `InvalidPathException` 且能对应到上面三种路径形态之一
- **确定**：含 `__THESEUS_UTF8__` 前缀 → 触发 B，无需再看别的
- **很可能**：日志同时出现「静态初始化失败」+ `ExceptionInInitializerError`，
  且堆栈底部是 `Path.of` / `Paths.get` / `File.<init>`
- **需区分**：
  - 与 `mod-jar-corruption.md` 的区别：那条是**文件本身损坏**（`zip END header`），
    本条是**路径字符串非法**，文件可能完全正常
  - 与 `json-config-corruption.md` 的区别：那条是文件内容语法错，本条读文件前就失败了
- **实测频次**：生产 9353 条分析中，`__THESEUS_UTF8__` 相关 128 条、
  `InvalidPathException` 相关 126 条，合计约 2.8%，是移动端启动失败里被低估的一类
