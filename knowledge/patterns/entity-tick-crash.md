# 实体 / 方块实体 tick 崩溃（定点崩溃与服务器 tick 循环异常）

## 签名 (Signature)

**实体 tick 崩溃的 crash-report 形态**

```
---- Minecraft Crash Report ----
Description: Ticking entity

java.lang.ArrayIndexOutOfBoundsException: Index 2 out of bounds for length 2
	at net.modderg.thedigimod.server.entity.DigimonEntity.evolveDigimon(DigimonEntity.java:543) ~[%23196!/:?] {re:classloading}
	at net.modderg.thedigimod.server.entity.DigimonEntity.tick(DigimonEntity.java:1171)

-- Entity being ticked --
Details:
	Entity Type: thedigimod:agumonblack (net.modderg.thedigimod.server.entity.DigimonEntity)
	Entity ID: 46
	Entity Name: Digimon (21Lv)
	Entity's Exact location: -66.50, 68.50, 173.50
	Entity's Block location: World: (-67,68,173), Section: (at 13,4,13 in -5,4,10; chunk contains blocks -80,-64,160 to -65,319,175), Region: (-1,0; contains chunks -32,0 to -1,31, blocks -512,-64,0 to -1,319,511)
	Entity's Momentum: 0.00, -0.08, 0.00
	Entity's Passengers: []
	Entity's Vehicle: null
```

**方块实体 tick 崩溃的 crash-report 形态**

```
Description: Ticking block entity

java.lang.NullPointerException: Cannot invoke "com.simibubi.create.foundation.advancement.CreateAdvancement.isAlreadyAwardedTo(net.minecraft.world.entity.player.Player)" because "c" is null
	at com.simibubi.create.foundation.advancement.AdvancementBehaviour.lambda$removeAwarded$0(AdvancementBehaviour.java:62)

-- Block entity being ticked --
Details:
	Name: create:crushing_wheel // com.simibubi.create.content.kinetics.crusher.CrushingWheelBlockEntity
	Block: Block{create:crushing_wheel}[axis=x]
	Block location: World: (-118,65,275), Section: (at 10,1,3 in -8,4,17; chunk contains blocks -128,-64,272 to -113,319,287), Region: (-1,0; contains chunks -32,0 to -1,31, blocks -512,-64,0 to -1,319,511)
```

**服务器 tick 循环中的异常（旧版与 Paper 系）**

```
Encountered an unexpected exception
net.minecraft.util.ReportedException: Ticking block entity
	at net.minecraft.server.MinecraftServer.func_71190_q(MinecraftServer.java:715)
Caused by: java.lang.NoSuchMethodError: nc.tile.energy.TileEnergy.addTileToENet()V

Description: Exception in server tick loop
java.lang.VerifyError: Bad type on operand stack
	at net.minecraft.server.integrated.IntegratedServer.loadAllWorlds(IntegratedServer.java:88)

Exception in server tick loop
java.lang.NoSuchFieldError: legendaries
	at com.github.xpxpand.pixelmonbroadcasts.listeners.SpawnListener.onSpawnEntityEvent(SpawnListener.java:141)
```

**tick 路径的固定栈帧（用于确认崩溃确实发生在 tick 中）**

```
	at net.minecraft.world.level.Level.guardEntityTick(Level.java:479)
	at net.minecraft.server.level.ServerLevel.tickNonPassenger(ServerLevel.java:693)
	at net.minecraft.world.level.entity.EntityTickList.forEach(EntityTickList.java:53)
	at net.minecraft.world.level.chunk.LevelChunk$BoundTickingBlockEntity.m_142224_(LevelChunk.java:689)
	at net.minecraft.world.level.chunk.LevelChunk$RebindableTickingBlockEntityWrapper.m_142224_(LevelChunk.java:782)
	at net.minecraft.server.MinecraftServer.tickChildren(MinecraftServer.java:893)
```

**服务器崩溃后拒绝启动并移除实体**

```
Removing entity from world: <实体ID>
Entity <实体ID> is being removed
Server thread dump
```

**实体 AI 死循环与卡服（无崩溃，但 tick 超时）**

```
Can't keep up! Is the server overloaded? Running 5000ms or 100 ticks behind
Server took <N>ms to tick
```

## 含义

Minecraft 服务端每 tick（20 次/秒）遍历世界里所有已加载的实体与方块实体，逐一调用它们的 `tick()`。**只要单个实体的 `tick()` 抛异常，整个服务端 tick 循环中断，服务器崩溃。**

这决定了两条关键性质：

1. **存档已"带病"**。崩溃原因存在于世界数据中，不是随机的瞬时故障。重新启动会再次加载该实体，再次崩溃。
2. **崩溃点是稳定的**。报错给定了实体类型、坐标、Block 坐标，对同一份存档而言每次都在同一位置复现。

`Description: Ticking entity` 与 `Description: Ticking block entity` 是 crash-report 的**第一线索**，它直接告诉你崩溃发生的阶段。两个子段 `-- Entity being ticked --` 与 `-- Block entity being ticked --` 给出定位所需的全部信息：

| 字段 | 含义 | 用途 |
|---|---|---|
| `Entity Type` / `Name` | 实体的注册 ID / 显示名 | 判断属于哪个模组 |
| `Entity's Exact location` | 精确坐标（浮点） | 精确位置 |
| `Entity's Block location` | 所在方块坐标 + 区块 + Region 范围 | 定位 `.mca` 文件与区块 |
| `Entity ID` | 运行时实体编号 | 服务端命令可用（如 `/kill` 或对应模组的清理命令） |
| `Name: <ID> // <类全限定名>` | 方块实体的注册 ID 与实现类 | 判断属于哪个模组 |
| `Block location` | 方块坐标 + 区块 + Region 范围 | 同实体 |

`Exception in server tick loop` 是**不同的 Description**：崩溃发生在 tick 循环的其它环节（区块加载、世界状态更新），而非单个实体。但它同样会给 `-- Entity being ticked --` 或其它子段，需按子段判定。

`VerifyError: Bad type on operand stack` 与 tick 循环同时出现时，实质是**字节码层面的错误**（模组或 CoreMod 改坏了类），不是存档问题。

`Can't keep up!` 是性能警告，不是崩溃——但实体 AI 死循环（如寻路算法不收敛）会以此形式表现，服务器卡顿而不崩溃。

**"定点崩溃"** 是这类故障的通俗描述：玩家走到某个位置、或加载某区块就崩溃。原因正是该处的实体或方块实体在 tick 时抛异常。

## 常见触发

### 触发 A：移除模组导致旧实体残留

卸载了会生成自定义实体的模组，存档中仍有该模组的实体实例。服务端加载它时找不到对应的实体类型或 NBT 结构。

典型特征：`Entity Type` 的命名空间属于已卸载的模组；栈中可能伴随 `ClassNotFoundException` / `NoClassDefFoundError`。

### 触发 B：模组更新后 NBT 结构变化

模组更新改变了实体的 NBT 结构，旧存档中的数据反序列化后字段缺失或类型不符，`tick()` 中访问该字段即抛异常。

典型特征：`NullPointerException` / `ArrayIndexOutOfBoundsException` 落在该模组代码中，`tick()` 调用链清晰。

上面 Create 的 `crushing_wheel` 实例（`"c" is null`）即属此类：行为对象的初始化依赖存档中已不存在的数据。

### 触发 C：实体数量爆炸拖垮 tick

掉落物、刷怪塔、大量船/矿车、区块预加载的实体堆积。单个 tick 要处理的对象过多。

典型特征：`Can't keep up! Is the server overloaded?` 伴随 `Running Nms or M ticks behind`，而非异常栈。

### 触发 D：实体 AI 死循环

模组的寻路/目标选择算法不收敛，单个实体的 `tick()` 长时间不返回。表现是 tick 耗时暴增，可能触发看门狗或堆栈转储。

典型特征：服务器卡顿但无异常；`Server thread dump` 或超时日志；栈落在该模组的 AI 代码。

### 触发 E：区块数据损坏导致方块实体异常

区块文件受损，方块实体反序列化出错误数据（见存档损坏）。

典型特征：`Description: Ticking block entity` + 固定 `Block location`，且该区块之前有过写入中断。

### 触发 F：两个模组对同一实体的行为叠加

两个模组都改写某实体的 tick 逻辑或都注册行为组件，组合后进入异常状态。

典型特征：栈中同时出现两个模组的包名，或 `Mixin` 相关异常伴随 tick 崩溃。

## 修复步骤

**触发 A（模组残留）**

1. 把被移除的模组**装回去**，进入游戏让其实体正常加载后，用游戏内方式清理这些实体
2. 或用 MCA Selector 删除实体所在区块（会连带删除该区块的方块，慎用）
3. 清理完毕后再移除模组
4. 若模组无法恢复（作者删除、版本不兼容），只能删区块

**触发 B（NBT 结构变化）**

1. 确认是否为最近的模组更新引起——回退到旧版本可立即验证
2. 把模组更新到修复了 NBT 迁移的版本
3. 若该实体不重要，直接清除它即可；若重要，只能等模组修复

**触发 C（数量爆炸）**

1. 用实体清理命令（`/kill @e[type=item]` 等）批量清除
2. 降低刷怪塔产出、限制区块预加载范围
3. 服务端可配置实体上限与自然消失规则

**触发 D（AI 死循环）**

1. 从超时堆栈确定是哪个模组的 AI 代码，更新或移除该模组
2. 临时缓解：降低模拟距离，让该实体不进入 tick 范围
3. 清除该实体

**触发 E（区块损坏）**

1. 按坐标定位区块，用 MCA Selector 删除该区块让游戏重新生成
2. 有备份时优先还原
3. 见「存档 / 世界损坏」条目

**触发 F（模组叠加）**

1. 按 `-- Block entity being ticked --` 的 `Name` 找出该方块实体所属模组
2. 检查是否有其它模组也改写同类实体
3. 二分法定位冲突方

**定点崩溃的通用处置顺序**

1. **先记录坐标**——`-- Entity being ticked --` / `-- Block entity being ticked --` 的 `Entity's Block location` 或 `Block location` 给出的 `World: (x,y,z)`
2. **尝试不删档解决**：进入游戏后传送到远处 / 用清理命令清除该坐标的实体，或直接将该实体移除
3. **再考虑删区块**：用 MCA Selector 定位坐标所在区块并删除（`World: (x,y,z)` 的 x,z 除以 16 取整即区块坐标；再除以 32 取整即 region 坐标，可定位 `.mca` 文件名）
4. **服务端先停服再操作**，避免恢复过程中再次写入
5. **始终先备份**整个存档目录

坐标换算示例：`Block location: World: (-118,65,275)` → 区块坐标 `(-8, 17)` → region 坐标 `(-1, 0)` → 文件 `r.-1.0.mca`。Region 坐标负数向下取整（`-118 / 16 = -7.375` → `-8`；`-8 / 32 = -0.25` → `-1`）。

## 置信度线索

- **确定**：`Description: Ticking entity` / `Description: Ticking block entity` → 定位到具体实体，且给定了 `Entity Type` 与坐标
- **确定**：`-- Block entity being ticked --` 段落中的 `Name: <命名空间>:<路径> // <类全名>` → 命名空间即肇事模组
- **确定**：同一坐标在多次崩溃报告中重复出现 → 定点崩溃，该处的实体/方块实体数据有问题
- **较确定**：`Exception in server tick loop` 但无 `-- Entity being ticked --` 子段 → 崩溃在 tick 循环的其它环节（区块加载、世界状态），需按栈顶帧判断，不要默认按实体处理
- **较确定**：`Can't keep up!` 无异常栈 → 性能问题或 AI 死循环，不是异常崩溃
- **易误判**：`VerifyError` / `NoSuchMethodError` / `NoSuchFieldError` 出现在 tick 栈中时，根因是**字节码或版本问题**，不是实体数据损坏；此时删实体无效
- **易误判**：客户端整合服（Integrated Server）崩溃的报告与专用服务器格式一致，但文件落在客户端 `.minecraft/crash-reports/`，需向用户确认是哪一侧
- **需追问**：日志无 `-- Entity being ticked --` 子段也无坐标时，无法定位具体实体，应向用户确认崩溃是否与特定位置/操作相关
