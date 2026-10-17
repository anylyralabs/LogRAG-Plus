# 高频日志行的性质判定（噪音与真信号）

> 本文件的数据来源：对线上 6660 份 `latest.log`（1227 万行）做签名规范化后统计。
> 下列行号数字是**行出现总次数**，不是「多少份日志出现过」。

## 签名 (Signature)

```
Signature is missing from Property textures
[MixinHelper] Failed to get field MixinConfig.server: server
[net.pinkcats.createlazytick.CreateLazyTick/]: [unknown][Error]BlockEntity is not a SmartBlockEntityControl!
CachedBlockTags#match(State): Invalid tag list 'tweakeroo:pickaxe_override'
CachedBlockTags#match(State): Invalid tag list 'tweakeroo:silk_touch_override'
java.lang.IllegalArgumentException: null
\-- conditional-mixin N
[me.cx.vy.cn.wd.or.Mapper$StateEntry]: Could not decode blockstate, attempting fixes, error: Failed to parse either. First: Not a string; Second: No key id in MapLike[{Name:"minecraft:redstone_wire"...}]
Initializing MixinExtras via com.llamalad7.mixinextras.service.MixinExtrasServiceImpl(version=N).
zone.rong.bansoukou.BansoukouSecurityManager$CheatIOException: Bansoukou: Premature Exit Please Ignore
Unable to play unknown soundEvent: minecraft:fireworks.largeblast
java.lang.IllegalStateException: zip file closed
Force-disabling mixin 'features.render.world.sky.LevelRendererMixin'
Error reading pack metadata, attempting fallback type
```

## 含义

上面这些行在**全站出现频率排名前 15**，但绝大多数与「为什么这份日志被上传」无关。
它们合计占掉了日志里最显眼的位置，因此模型很容易把第一条醒目的报错当成根因——
实际排查中新手上当最多的就是这一类。

判断一行是否与本次崩溃有关的**结构性判据**（与内容无关，任何行都适用）：

| 判据 | 说明 |
|---|---|
| 有没有异常栈 | 光秃秃一行 `[Error]`/`WARN` 通常由调用方吞掉了异常；带 `at ...` 栈帧的才是抛出点 |
| 是否紧邻崩溃点 | 崩溃标志（`---- Minecraft Crash Report ----`、`# A fatal error`、退出码）前后 50 行内的才是嫌疑 |
| 是否**首次**出现 | 同一行在一份日志里重复几十次 → 它是循环里打印的，不是一次性故障 |
| 能否解释退出 | 若它的语义是「跳过 / 回退 / 忽略 / 继续」，它就不可能是崩溃原因 |

## 常见触发

### 触发 A：皮肤纹理属性提示（`Signature is missing from Property textures`，8684 次，全站第 2）

玩家皮肤属性缺少签名字段时客户端打印的一行提示。集中出现在特定启动器/账号来源的日志里
（本样本里几乎全部来自同一款启动器）。

**性质**：单行提示，不带异常栈；游戏对该属性会走回退处理，不中断启动。
**它通常不是崩溃原因**。只有当你的日志里除了它以外再无任何可疑行时，它也不足以解释崩溃——
此时应回到「有没有崩溃标志」这一步重新判断日志类型。

### 触发 B：模组反射读取 Mixin 内部字段失败（`[MixinHelper] Failed to get field MixinConfig.server: server`，6826 次）

某个模组（或它依赖的辅助库）尝试用反射读取 Mixin 自身类的 `server` 字段，读取失败后打印。
样本中该行**全部**来自同一款启动器的日志，属于该环境下的固定输出。

**性质**：模组侧的兼容性提示，携带「失败」字样但通常自带降级路径。
**判据**：看它后面有没有紧跟的异常栈与 `Caused by`。若只是单独一行，属于噪音；
若它出现在 `Mixin apply failed` / `MixinTransformerError` 之前，则可能是同一条因果链上的前兆，
此时以 `Caused by` 的实际异常类名为准。

### 触发 C：模组自报的方块实体类型错误（`BlockEntity is not a SmartBlockEntityControl!`，6034 次）

`createlazytick` 这个模组在遍历方块实体时的类型断言失败，用带颜色码的 `[unknown][Error]` 格式打印。

**性质**：模组自身的检测逻辑打印，**不抛异常、不终止游戏**。带 ANSI 颜色转义（`\u001b[31m`）是
它的输出特征，与游戏原生日志格式明显不同。
**判据**：它不带栈帧。若日志里只有它，则不能解释崩溃。

### 触发 D：模组引用当前版本不存在的物品标签（`CachedBlockTags#match(State): Invalid tag list 'tweakeroo:pickaxe_override'`，5220×2 次）

`tweakeroo` 模组引用了 `pickaxe_override` / `silk_touch_override` 两个标签，而当前游戏版本里
这两个标签不存在。

**性质**：这是**真的版本不匹配**，不是噪音——模组是按其它 MC 版本构建的。但它是**功能性失效**
（对应功能不生效），不是崩溃原因，游戏会跳过该标签继续运行。
**修复**：把该模组换成与当前 MC 版本一致的版本，或直接移除。
**注意**：不要把它当成崩溃根因去解释一个启动失败——它的表现是「功能不好用」而非「启动不了」。

### 触发 E：两条 Mixin 配置清单行（`\-- conditional-mixin N`，4512 次；`Force-disabling mixin '...'`，2064 次）

这两行都是 Mixin 在**启动时打印配置清单**的正常输出：前者是缩进后的清单条目，
后者表示某个 Mixin 因条件判断被显式禁用。

**性质**：正常输出。`\--` 这个缩进形态本身就说明它是清单的一部分，不是错误消息。
**判据**：出现它们**不代表**出问题；但如果被禁用的 Mixin 名称与你正在排查的功能对应
（如 `features.render.world.sky.LevelRendererMixin` 对应天空渲染），那它解释了「某功能不生效」。

### 触发 F：正常初始化行（`Initializing MixinExtras via ...(version=N).`，3953 次）

MixinExtras 的初始化日志。**纯正常输出**，出现它说明该组件加载成功。

### 触发 G：方块状态解析告警（`Could not decode blockstate, attempting fixes, error: Failed to parse either...`，4272×2 次）

游戏读到一个不符合当前格式的方块状态定义，打印后**尝试自动修复**。

**性质**：带 `attempting fixes` 字样，说明发生了**回退处理**。通常源于存档或模组残留的旧格式数据。
**判据**：只有升级版本后大量出现、且伴随地形异常时才需要处理；单次出现属正常兼容行为。

### 触发 H：已自带「请忽略」标注的异常（`Bansoukou: Premature Exit Please Ignore`，3857 次）

`bansoukou` 模组的 `CheatIOException`，消息里直接写了 `Please Ignore`。
**性质**：模组用异常做控制流，故意如此。**不应作为根因**。

### 触发 I：未知音效事件（`Unable to play unknown soundEvent: minecraft:fireworks.largeblast`，2754 次）

资源包或模组引用了当前版本没有的音效 ID。

**性质**：单次播放失败，控制台一行提示，不影响游戏运行。
**修复**：仅当特定音效缺失影响体验时才处理——更新或移除对应资源包/模组。

### 触发 J：`zip file closed`（`java.lang.IllegalStateException: zip file closed`，2301 次）

读取某个 zip/jar 时该句柄已被关闭。

**性质**：常见于模组在后台线程异步读取自己的资源包/配置，而句柄已被回收。
**判据**：若它**不伴随** `zip END header not found`、`Invalid or corrupt jarfile`，则多为
模组自身的资源读取时序问题，不指向文件损坏；若伴随出现，按
`patterns/mod-jar-corruption.md` 处理（文件真的损坏）。

### 触发 K：资源包元数据回退（`Error reading pack metadata, attempting fallback type`，3030 次）

资源包元数据读不出类型时游戏回退处理。与上方 `Pack declares support for version newer than 64`
属同一族，完整处置见 `patterns/datapack-world-load.md`。

## 修复步骤

1. 先判断日志里**有没有崩溃标志**（`---- Minecraft Crash Report ----`、`# A fatal error has been detected`、`<启动器名> Crash Report`、退出码）。
2. 有崩溃标志 → **以崩溃标志为起点**，读崩溃报告正文的 `Description:` 与顶层异常的 `Caused by` 链；上述高频行只在它们出现在这条链上时才纳入考虑。
3. 没有崩溃标志（启动后直接退出/卡住）→ 找**最后 30 行**与退出码，而不是找最显眼的 `[Error]`。
4. 遇到触发 D（标签不存在的模组报错）→ 更新或移除该模组；其余触发 A/B/C/E/F/H 不必处理。
5. 遇到触发 J 且伴随 `zip END header`/`Invalid or corrupt jarfile` → 删除并重新下载对应 jar。
6. 遇到触发 K 且资源包异常 → 按 `datapack-world-load.md` 修正 `pack.mcmeta`。

## 置信度线索

- 目标行**带 `at ... ` 栈帧**且位于崩溃点前后 50 行内 → 高置信度与本次崩溃相关。
- 目标行**重复出现数十次**且用词为「跳过/回退/忽略/继续」→ 低置信度，通常与崩溃无关。
- 目标行**全部来自同一个模组命名空间**（如 `net.pinkcats.createlazytick`、`zone.rong.bansoukou`）
  且没有其它模组的报错 → 优先归因到该模组自身的兼容性，而不是整机环境。
- 本文件中触发 D 是唯一「真的代表问题」的高频行，且它代表的是**功能性失效**而非崩溃。
