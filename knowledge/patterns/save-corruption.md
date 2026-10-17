# 存档 / 世界损坏（区块、region 文件、NBT 循环引用、数据包加载失败）

## 签名 (Signature)

**区块 NBT 读取失败**

```
java.io.IOException: Chunk NBT read error
net.minecraft.nbt.NbtIo: Unable to read NBT data
java.io.IOException: Failed to read chunk data
[Server thread/ERROR]: Couldn't load chunk [123, 45]
[Server thread/ERROR]: Chunk file at (12, 3) is missing level data, skipping
[Server thread/ERROR]: Chunk file at (12, 3) is missing sections data, skipping
```

**region 文件损坏 / 截断**

```
Region file 'r.0.0.mca' appears truncated
java.io.EOFException
java.util.zip.ZipException: invalid LOC header (bad signature)
java.io.IOException: Region file 'r.0.-1.mca' has an invalid header
java.lang.NullPointerException at net.minecraft.world.level.chunk.storage.RegionFile
```

**NBT 递归 / 循环引用（`StackOverflowError`）**

```
java.lang.StackOverflowError
	at net.minecraft.nbt.CompoundTag.write(CompoundTag.java)
	at net.minecraft.nbt.CompoundTag.write(CompoundTag.java)
	at net.minecraft.nbt.CompoundTag.write(CompoundTag.java)
	at net.minecraft.nbt.ListTag.write(ListTag.java)
Caused by: java.lang.StackOverflowError
	at net.minecraft.nbt.CompoundTag.toString(CompoundTag.java)
```

**世界加载被拦截**

```
Failed to load world
Errors in currently selected datapacks prevented the world from loading.
Registry loading errors / Unknown registry key in ResourceKey[<注册表路径>]
Missing dimension in a Minecraft server
java.lang.IllegalStateException: Missing registry entry / Unknown registry element
net.minecraftforge.fml.config.ConfigFileTypeHandler$ConfigLoadingException: Failed loading config file <文件> of type SERVER for modid <模组ID>
```

**`level.dat` 损坏**

```
Failed to load level.dat
java.io.IOException: Unable to read level.dat
Error reading level.dat
```

## 含义

Minecraft 的世界数据是**多层嵌套的二进制格式**，任一层损坏都可能导致世界无法加载：

```
saves/<世界名>/
├── level.dat            世界元数据（种子、出生点、游戏规则、时间）
├── level.dat_old        上一份 level.dat 的自动备份
├── region/r.X.Z.mca     区块数据，每个文件包含 32×32 个区块（512×512 方块）
├── entities/r.X.Z.mca   实体数据
├── data/                地图物品、末影箱等
├── playerdata/<UUID>.dat 玩家数据（位置、背包）
└── datapacks/           数据包
```

**区块与坐标的换算**：region 文件名为 `r.X.Z.mca`，其中

```
X = floor(区块X ÷ 32)
Z = floor(区块Z ÷ 32)
```

日志报出的是**区块坐标**（如 `[123, 45]`）时，除以 32 向下取整才得到 region 文件名。这一步决定了要替换哪个文件，算错就会换错文件。

四类损坏的机制完全不同：

| 类型 | 机制 | 影响范围 |
|---|---|---|
| 单个区块 NBT 损坏 | 该区块的 NBT 数据无法解析 | 单区块（表现为空洞或加载即崩） |
| region 文件损坏/截断 | 整个 `.mca` 文件头部或长度表损坏 | 最多 1024 个区块（该 region 内全部） |
| NBT 循环引用 | 复合标签被互相引用，序列化/打印时无限递归 | 加载或保存即崩 |
| 数据包/注册表不匹配 | 存档引用了当前环境不存在的物品、方块、维度 | **整个世界**被加载拦截 |

**NBT 循环引用值得单独说明**：正常存档不会出现循环引用（写入时是树形结构），它通常由**模组或编辑工具错误地构造了双向引用的 NBT 树**导致。因为序列化与 `toString()` 都会递归遍历，所以表现为 `StackOverflowError`，且栈帧是**完全相同的 `CompoundTag.write` 行重复数百次**——这是与其他 `StackOverflowError`（如递归算法的逻辑错误）区分的依据。

**数据包加载失败严格来说不是「损坏」而是「加载拦截」**：进程没有崩溃，MC 主动拒绝了世界加载并弹出选择界面。它往往是**用户移除了内容型模组**的结果，而不是文件真的坏了。

## 常见触发

### 触发 A：单个区块 NBT 损坏

写入过程中断电、存储写满、进程被强杀，导致区块数据只写了一半。

典型签名：`Chunk NBT read error`、`Couldn't load chunk [x, z]`、`Chunk file at (x, z) is missing level data, skipping`。

**服务器与单机的行为不同**：服务器遇到损坏区块通常会记录错误并跳过（世界仍可加载，只是那块地变成空洞或重新生成）；单机加载到该区块时更容易直接崩溃。

### 触发 B：region 文件损坏或截断

存储介质故障、文件传输中断、或外部工具（地图编辑器、备份还原）操作中断。

典型签名：`Region file 'r.X.Z.mca' appears truncated`、`EOFException`、`ZipException: invalid LOC header`。

已实测的同类案例：多个 `.jar` 模组文件同时出现 `ZipException` 时，通常指向**存储或磁盘层面的问题**，而非单个文件下载失败。

### 触发 C：NBT 循环引用

模组或存档编辑工具构造了互相引用的 NBT 复合标签。

典型签名：`StackOverflowError` 且栈中 `CompoundTag.write` / `CompoundTag.toString` 帧重复出现数百次。

### 触发 D：数据包 / 注册表与当前环境不匹配

移除了内容型模组（提供新物品、新方块、新维度）后仍尝试打开旧存档。

典型签名：`Errors in currently selected datapacks prevented the world from loading.`、`Failed to load world`、`Unknown registry key in ResourceKey[...]`、`Missing dimension in a Minecraft server`。

**服务器特有的变体**：`Missing dimension in a Minecraft server` 表示存档引用的自定义维度已不存在。此错误**只在服务端触发**，单机不会因它拒绝加载。

### 触发 E：`level.dat` 损坏

整个世界的元数据文件损坏，世界完全无法打开。

典型签名：`Failed to load level.dat`、`Unable to read level.dat`。

### 触发 F：从高版本降级打开世界

新版 MC 写入的数据结构（如区块调色板格式、注册表格式）在旧版无法解析。

典型签名：加载时批量报 `Chunk NBT read error` 或区块被大量重新生成。

已实测的同类机制：1.18 起 MC 不再接受调色板尺寸与数据长度不匹配的区块段（此前版本可正常读取），导致依赖该宽松行为的旧存档在升级后区块被重新生成。

### 触发 G：配置文件损坏（附带现象）

与存档同目录的模组配置文件损坏会一并导致加载失败，但报错信息指向配置文件而非存档。

典型签名：`ConfigLoadingException: Failed loading config file <文件> of type SERVER for modid <模组ID>`。实测中该文件中内容全部为 `[NUL]` 空字节，删除该配置文件后世界即恢复正常加载。

## 修复步骤

**触发 A（单个区块损坏）**

1. 从日志读出区块坐标，先按 `÷32 向下取整` 换算出 region 文件名
2. 从备份中只替换**该一个 region 文件**，不要替换整个世界，以最小化数据损失
3. 无备份时用区块编辑工具（MCA Selector）打开世界，工具会高亮报错的区块，删除它们后由服务端按种子重新生成地形
4. 使用删除区块的手段意味着**该区块内玩家建造的内容会丢失**，属于最后手段
5. 服务端遇到 `Chunk file at (x, z) is missing level data, skipping` 时通常可继续运行，可先观察影响范围再决定是否处理

**触发 B（region 文件损坏）**

1. 用 `--forceUpgrade` 参数启动一次：`java -jar server.jar --forceUpgrade nogui`，它会重新保存所有区块，可修复部分「数据有效但格式过旧」的情况
2. `--forceUpgrade` **不能修复 region 文件本身的损坏**，纯文件损坏仍需从备份替换或删除该 region 文件
3. 删除 region 文件后地形按种子重新生成，该 512×512 区域内的建造全部丢失
4. 若**多个**文件同时损坏，先检查存储介质健康状态——同时损坏通常意味着磁盘问题，修复存档无法阻止再次发生

**触发 C（NBT 循环引用）**

1. 确认 `StackOverflowError` 的栈帧是否重复出现 `CompoundTag.write` / `CompoundTag.toString`——是则该区块的 NBT 存在循环引用
2. 用 NBT 编辑工具打开出问题的区块文件，定位并删除相互引用的那组标签
3. 无法手工修复时删除该区块，让其重新生成
4. 若该现象在**写入时**稳定复现（而非读旧档），说明是某个模组构造 NBT 的方式有缺陷，需定位该模组

**触发 D（数据包 / 注册表不匹配）**

1. 在加载失败弹窗中选择**安全模式**（只加载原版数据包）先进入世界
2. 进入后立即备份整个存档目录，再做后续操作
3. 装回提供这些注册项的模组（即用户此前移除的那个），是最直接的解法
4. 无法装回时，用 NBT 编辑工具清理存档中引用已移除内容的实体与方块数据
5. 服务器端出现 `Missing dimension` 时，需在服务端配置中恢复该维度或从 `level.dat` 中清除该维度引用

**触发 E（`level.dat` 损坏）**

1. MC 会自动维护 `level.dat_old` 备份，用它将 `level.dat` 覆盖回去
2. `level.dat_old` 不可用时用 NBT 编辑工具（NBTExplorer）打开修复
3. 修复 `level.dat` 前先整目录备份

**触发 F（版本降级）**

1. **禁止用低版本 MC 打开高版本存档**——这会造成不可逆的区块重生成
2. 必须先整目录备份存档，再尝试
3. 确认世界确实是为更高版本创建的（查看 `level.dat` 中的 `DataVersion`）
4. 只能升级打开，不能降级打开；确需降级时需使用专门的降级工具而非直接开档

**触发 G（配置文件损坏）**

1. 从 `ConfigLoadingException: Failed loading config file <文件> ... for modid <模组ID>` 读出损坏的配置文件路径
2. 删除该配置文件（模组下次启动会重新生成默认值）
3. 若多个配置文件同时损坏且内容为 `[NUL]` 空字节，先检查存储健康状态

## 置信度线索

- **确定（区块级）**：`Chunk NBT read error` / `Couldn't load chunk [x, z]` / `Chunk file at (x, z) is missing level data` 直接给出坐标
- **确定（region 文件级）**：`Region file 'r.X.Z.mca' appears truncated` 之类已直接给出文件名，无需换算
- **确定（NBT 循环引用）**：`StackOverflowError` 且栈帧重复出现 `CompoundTag.write` 或 `CompoundTag.toString`
- **确定（加载拦截）**：`Errors in currently selected datapacks prevented the world from loading.` 是 MC 的官方界面文案，出现该句子说明是主动拦截而非崩溃
- **较确定（版本降级）**：日志中批量区块报错 + 用户承认曾用低版本打开过高版本存档
- **需区分**：`Unknown registry key` 列表很长时，逐条对应模组效率极低——直接确认用户**最近移除了哪个模组**更快
- **需注意（服务器 ≠ 单机）**：服务器遇损坏区块往往跳过并继续运行，单机更容易崩溃；`Missing dimension` 只在服务端出现。判断影响范围时要区分运行环境
- **需追问**：日志未标明是否已备份存档时，**必须先提醒用户备份再操作**。同时确认损坏是首次出现还是反复出现（反复出现指向存储介质问题）
