# JSON 配置文件损坏（空文件、截断、语法非法）

## 签名 (Signature)

**Gson 读到空文件（生产最高频形态）**

```
Caused by: java.io.EOFException: End of input at line 1 column 1 path $
	at com.google.gson.stream.JsonReader.nextNonWhitespace(JsonReader.java:1457)
	at com.google.gson.stream.JsonReader.doPeek(JsonReader.java:558)
	at com.google.gson.internal.bind.TypeAdapters$28.read(TypeAdapters.java:769)
```

**Gson 读到非法内容**

```
com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected BEGIN_OBJECT but was ...
com.google.gson.stream.MalformedJsonException: Use JsonReader.setLenient(true) to accept malformed JSON at line 1 column 1
com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected BEGIN_OBJECT but was END_DOCUMENT at line 3 column 1 path $
com.google.gson.JsonSyntaxException: java.lang.IllegalStateException: Expected NAME at line 7 column 5 path $.settings
```

**Minecraft 资源 / 数据文件解析失败**

```
[Worker-Main-2/ERROR] [net.minecraft.server.packs.resources.SimpleJsonResourceReloadListener/]: Couldn't parse data file epic_fight_avalon:merlin_gg from epic_fight_avalon:item_skins/merlin_gg.json
com.google.gson.JsonParseException: java.io.EOFException: End of input at line 1 column 1 path $
	at net.minecraft.util.GsonHelper.fromNullableJson(GsonHelper.java:527)
	at net.minecraft.util.GsonHelper.fromJson(GsonHelper.java:532)
	at net.minecraft.server.packs.resources.SimpleJsonResourceReloadListener.scanDirectory(SimpleJsonResourceReloadListener.java:42)
	at net.minecraft.server.packs.resources.SimpleJsonResourceReloadListener.prepare(SimpleJsonResourceReloadListener.java:30)
```

**语言文件字段类型不匹配**

```
[Render thread/WARN] [net.minecraft.client.resources.language.ClientLanguage/]: Skipped language file: isometric-renders:lang/zh_cn.json (com.google.gson.JsonSyntaxException: Expected gui.isometric-renders.mesh_corrupt to be a string, was an object ({"te...d"}))
```

## 含义

Gson 报错文本本身就是**文件状态的直接读数**：`line` / `column` / `path $` 分别指出出错位置与 JSON 路径（`$` 是根），异常类型指出「读到什么」而非「应该读到什么」。

| 报错文本 | 文件实际状态 |
|---|---|
| `EOFException: End of input at line 1 column 1 path $` | **读到空文件**：0 字节、仅空白、仅 BOM、或内容全是 `[NUL]` 空字节。连第一个 token 都不存在，所以停在 1:1 根路径 |
| `MalformedJsonException ... at line 1 column 1` | 有内容，但**第一个字符不是合法 JSON 起始符**（截断到半个字符、写入了乱码、文件头多出文本） |
| `Expected BEGIN_OBJECT but was END_DOCUMENT at line 3 column 1` | 内容存在但**结构未闭合**，读到文件尾仍缺 `}` |
| `Expected BEGIN_OBJECT but was STRING`/`NUMBER`/`BOOLEAN` | 整个文件被写成了一个**标量**（如只剩 `"1"` 或 `0`），典型是截断后残留 |
| `Expected NAME at line N column M` | 第 N 行的键名位置结构损坏（缺引号、多余逗号、丢了一个字段） |
| `Expected ... to be a string, was an object` | 语法**合法**但字段类型错，属内容写错而非文件损坏 |

**为什么 `line 1 column 1` 是「空文件」的判据**：JSON 解析器必须先 peek 首个非空白字符才能定位。文件非空时首个 token 至少能读出来，报错会落在具体行列（如 `line 3 column 1`）或给出「读到了什么」（`was STRING`）。停在 `1:1 path $` 且异常是 `EOFException`，说明读取器在根位置就撞到了文件末尾。这一步判读决定了修复方向：空文件**重建成默认值**即可，非空但非法的文件则要判断是**截断**（后半段内容丢失）还是**手改坏**（内容完整但结构错）。

**写入被中断导致空文件的机制**：多数程序保存配置的做法是「先 `truncate` 到 0 字节，再写入新内容」。若在 truncate 之后、写入完成之前进程被杀（Android 上应用被系统回收、低内存杀后台、用户强制停止）或设备断电，磁盘上留下的就是 0 字节文件。同理，磁盘写满时 truncate 成功而写入全部失败，也会留下空文件——因此**批量出现空 JSON 时优先怀疑存储或磁盘空间**，而不是逐个文件手改。

## 常见触发

### 触发 A：写入过程中断（空文件 / 0 字节）

进程被杀、强制关机、磁盘写满，发生在 truncate 与 write 之间。

典型签名：`EOFException: End of input at line 1 column 1 path $`；文件大小 0 字节，或内容全为 `[NUL]`。

### 触发 B：模组自身保存配置时崩溃

模组在保存自己的 `config/*.json` 时抛异常退出，留下半个文件。

典型签名：gson 栈帧**下方**（即 gson 内部帧之后）的调用者属于某个模组的包名，而非 `net.minecraft.*`。

### 触发 C：手动编辑破坏 JSON

缺逗号、多余尾随逗号、引号不成对、用带 BOM 的编辑器保存、把注释写进 JSON。

典型签名：`MalformedJsonException` 或 `Expected NAME at line N column M`，行列号指向用户改过的那一行。

### 触发 D：整合包元数据 / 启动器配置文件损坏

启动器或整合包安装器未能完成写入，导致清单文件为空。

典型签名：启动器报「无法解析实例」「整合包信息缺失」，文件为 0 字节。涉及文件：`.minecraft/launcher_profiles.json`、`launcher_accounts.json`、整合包 `manifest.json`（CurseForge）与 `modrinth.index.json`（Modrinth）、Prism/MultiMC 的 `instance.cfg` 与 `mmc-pack.json`、HMCL 的 `versions/<实例>/<实例>.json`。

### 触发 E：游戏资源 / 数据包内 JSON 损坏

资源包、数据包、模组内置资源里的 JSON 未写完或被改坏。

典型签名：`Couldn't parse data file <命名空间>:<路径> from <文件>` 与 `Skipped language file: <命名空间>:lang/<语言>.json`，同一行即给出命名空间与相对路径。

### 触发 F：模组配置项类型写错（非损坏）

模组读取配置时发现字段类型与预期不符，JSON 本身可解析。

典型签名：`Expected <键> to be a string, was an object`；Forge/NeoForge 侧则为 `ConfigLoadingException: Failed loading config file <文件> of type SERVER for modid <模组ID>`。修复方向是改字段类型或删除该配置重建，而非修复文件结构。

## 修复步骤

**定位文件：从 gson 栈帧下方的调用者判断**

gson 内部帧（`com.google.gson.*`）不含业务信息，**真正指出文件的是它下面的帧**：

| 栈中出现的调用者 | 指向的文件 |
|---|---|
| `net.minecraft.util.GsonHelper` / `SimpleJsonResourceReloadListener.scanDirectory` | 资源包 / 数据包 / 模组内置资源内的 JSON，看同一行 `from <命名空间>:<路径>` |
| `net.minecraft.client.resources.language.ClientLanguage` | 语言文件 `lang/*.json` |
| `com.<模组包名>.*`（如 `com.example.mymod.config`） | 该模组自己的 `config/*.json` |
| Forge/NeoForge `ConfigFileTypeHandler` | `.toml` 配置（`config/*-client.toml`、`config/*-server.toml`） |
| 启动器包名 | `launcher_profiles.json` / 实例清单 |

日志里没有文件名时，向上找最近的 `ERROR`/`WARN` 行——Minecraft 与多数模组都会在异常之前打印一行带路径的诊断。

1. 在启动器的「实例文件管理」里打开该文件，先看**文件大小**：0 字节即确认是触发 A
2. 删除该文件，让程序下次启动时重建默认值——JSON 配置绝大多数是「文件缺失即用默认值」，删除是成本最低且可逆的解法
3. 有备份（整合包原始安装包、启动器备份目录、同目录的 `.bak`）时优先恢复；`.minecraft/backups/` 内可能留有存档与配置备份
4. 手动改坏的：用 JSON 校验器定位行列后补齐括号与引号；保存时用无 BOM 的 UTF-8，不要留尾随逗号（Gson 默认严格模式不接受）
5. `options.txt` 是键值对文本而非 JSON，但同样是「先清空再写入」，损坏时直接删除，代价是按键与视频设置回到默认
6. `launcher_profiles.json` 损坏时删除该文件并在启动器内重新登录；先确认账号凭据不依赖该文件之外的其他本地文件
7. 整合包 `manifest.json` / `modrinth.index.json` 损坏时重新导入原始安装包，手改清单风险高于重装
8. **多个 JSON 同时为 0 字节时，先清理磁盘并检查存储健康**，否则修复后的文件会被再次截断
9. 触发 F 属配置内容错误：按报错给出的键名改类型，或删除该配置文件让它重建默认值
10. 不要删除整个 `config/` 目录——那会一并丢掉所有模组的个性化设置，只删报错点名的文件

## 置信度线索

- **确定（空文件）**：`EOFException: End of input at line 1 column 1 path $`，且文件大小为 0 字节
- **确定（文件位置）**：日志出现 `Couldn't parse data file <命名空间>:<路径> from <文件>`、`Skipped language file: <命名空间>:lang/<语言>.json` 或 `Failed loading config file <文件> of type <类型> for modid <模组ID>` 时，文件名已直接在日志中给出，无需推断
- **较确定（截断）**：`MalformedJsonException ... at line 1 column 1`，或 `Expected BEGIN_OBJECT but was END_DOCUMENT`
- **较确定（手改坏）**：`Expected NAME at line N column M` 且 N 指向用户最近编辑过的行；`line 1 column 1` 之外的坐标基本可排除空文件
- **较确定（模块归属）**：gson 内部帧之下的第一处非 `com.google.gson` 帧即调用方；其为模组包名时，损坏文件属该模组
- **需区分**：`The mod "<名>" contains invalid entries in its mod json: Unsupported root entry "classTweaker" at line 10 column 17` 是**模组元数据字段非法**，JSON 本身可正常解析，删配置无用
- **需区分**：`minecraft:axolotl_bucket`、`file/Axolotl` 之类命中「axolotl」的行是游戏内生物资源，与配置损坏、与启动器均无关，不能作为来源判据
- **需追问**：只有 gson 栈而无文件名与行号时，需向用户索取该配置文件的路径与文件大小，再决定重建还是修复
- **需注意**：同一份日志里多处不同 JSON 同时报空文件，或报错跨多个模组，指向磁盘/存储问题而非个别配置错误
