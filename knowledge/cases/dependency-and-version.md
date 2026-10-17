# 实战案例：依赖缺失与版本错配（Fabric / Forge / NeoForge，全平台通用）

本条汇集 logshare.cn 生产 AI 分析记录中**已核实**的依赖类故障。每个案例都标注了来源
`logId`，可回溯原始日志。抽象规则见 `patterns/mod-dependency-failure.md` 与
`patterns/version-mismatch.md`，本条只给**真实形态**。

## 签名 (Signature)

**案例 1：Veinminer 2.12.3 缺 `fabric-language-kotlin`（MC 26.3 / Fabric Loader 0.19.5，logId: IKhdl1F）**

```
[main/INFO]: Loading Minecraft 26.3 with Fabric Loader 0.19.5
[main/WARN]: Mod resolution failed
[main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE veinminer 2.12.3 {depends fabric-language-kotlin @ [*]}, ROOT_FORCELOAD_SINGLE veinminer 2.12.3]
[main/INFO]: Reason: [HARD_DEP veinminer 2.12.3 {depends fabric-language-kotlin @ [*]}]
[main/INFO]: Fix: add [add:fabric-language-kotlin 1 ([(-∞,∞)])], remove [], replace []
[main/ERROR]: Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
	 - 安装 fabric-language-kotlin，任意版本。
	 - 模组 'Veinminer' (veinminer) 2.12.3 需要 fabric-language-kotlin 的 任意版本，但没有安装它！
	at net.fabricmc.loader.impl.FabricLoaderImpl.load(FabricLoaderImpl.java:202)
	at mio.Wrapper.main(Wrapper.java:21)
```

**案例 2：Iris 1.8.8 与 Sodium 0.8.13 约束互斥（MC 1.21.1 / Fabric Loader 0.19.5，logId: kM7P543）**

```
[FabricLoader/Resolution/WARN]: Mod resolution failed
[FabricLoader/Resolution/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE iris 1.8.8+mc1.21.1 {depends sodium @ [0.6.x]}, ROOT_FORCELOAD_SINGLE iris 1.8.8+mc1.21.1]
[FabricLoader/Resolution/INFO]: Reason: [HARD_DEP iris 1.8.8+mc1.21.1 {depends sodium @ [0.6.x]}, NEG_HARD_DEP sodium 0.8.13+mc1.21.1 {breaks iris @ [<1.8.13]}]
[FabricLoader/Resolution/INFO]: Fix: add [], remove [], replace [[sodium 0.8.13+mc1.21.1] -> add:sodium 0.6- ([[0.6-,0.7-)])]
	 - 模组 'Iris' (iris) 1.8.8+mc1.21.1 需要 模组 'Sodium' (sodium) 的 任意 0.6.x 版本，但已经安装了的版本 0.8.13+mc1.21.1 不对！
	 - 模组 'Sodium' (sodium) 0.8.13+mc1.21.1 与 模组 'Iris' (iris) 的 1.8.13 以下任意版本 不兼容，但已经安装了的版本是 1.8.8+mc1.21.1！
```

**案例 3：`puzzleslib` 追 `fabric-api` 下限（MC 26.3，logId: YckshpQ）**

```
[FabricLoader/Resolution/INFO]: Immediate reason: [HARD_DEP easyanvils 26.3.1 {depends puzzleslib @ [>=26.3.12]}, HARD_DEP_NO_CANDIDATE puzzleslib 26.3.15 {depends fabric-api @ [>=0.163.0]}, ROOT_FORCELOAD_SINGLE easyanvils 26.3.1]
[FabricLoader/Resolution/INFO]: Reason: [HARD_DEP puzzleslib 26.3.15 {depends fabric-api @ [>=0.163.0]}]
[FabricLoader/Resolution/INFO]: Fix: add [], remove [], replace [[fabric-api 0.162.0+26.3] -> add:fabric-api 0.163.0 ([[0.163.0,∞)])]
	 - 模组 'Puzzles Lib' (puzzleslib) 26.3.15 需要 模组 'Fabric API' (fabric-api) 的 0.163.0 及以上版本，但已经安装了的版本 0.162.0+26.3 不对！
```

**案例 4：Java 符号缺失即 MC 版本错配（MC 1.21.11，logId: LzNjZjk）**

```
java.lang.RuntimeException: Could not execute entrypoint stage 'client' due to errors,
    provided by 'newvisualkeybing' at 'com.github.newvisualkeybing.client.NewVisualKeybingFabricClient'!
Caused by: java.lang.NoSuchMethodError: 'void net.minecraft.client.option.KeyBinding.<init>(java.lang.String, int, java.lang.String)'
	at knot//com.github.newvisualkeybing.client.NewVisualKeybingFabricClient.onInitializeClient(NewVisualKeybingFabricClient.java:18)
```

同一形态的另一实例为 `Real Camera 0.6.11-beta`（MC 1.21.11，logId: pZFnGrN）：

```
Caused by: java.lang.NoSuchMethodError: 'void net.minecraft.client.option.KeyBinding.<init>(java.lang.String, int, java.lang.String)'
	at knot//com.xtracr.realcamera.KeyBindings.createKeyBinding(KeyBindings.java:40)
	at knot//com.xtracr.realcamera.RealCameraFabric.onInitializeClient(RealCameraFabric.java:15)
```

**案例 5：加载器 API 变动（Forge 47.2.18，logId: UQiitML）**

```
java.lang.NoSuchMethodError: 'java.util.List net.minecraftforge.event.OnDatapackSyncEvent.getPlayers()'
	at .../kaleidoscopetavern.init.register.DatapackReloadListenerEvent.onDatapackSyncEvent(DatapackReloadListenerEvent.java:23)
```

**案例 6：缺内容模组本体（Fabric，logId: nd7FRqE）**

```
[main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE delightlib 26.6.23-26.2-fabric {depends farmersdelight @ [*]}, ROOT_FORCELOAD_SINGLE delightlib 26.6.23-26.2-fabric]
[main/INFO]: Fix: add [add:farmersdelight 1 ([(-∞,∞)])], remove [], replace []
```

## 含义

Fabric 的 `Immediate reason` 与 `Reason` 两行构成**完整的约束冲突快照**：

- `HARD_DEP` = 硬依赖不满足
- `HARD_DEP_NO_CANDIDATE` = 连候选版本都找不到（通常就是「没装」）
- `NEG_HARD_DEP` = 某个模组声明了**负依赖**（`breaks`），即 `sodium 0.8.13` 明确排斥 `iris < 1.8.13`
- `ROOT_FORCELOAD_SINGLE` = 该模组是唯一被强制的根节点，求解器没有替换余地
- `Fix: replace [[旧] -> add:新]]` = 求解器给出的**具体替换方案**（案例 2 要求把 Sodium 换成 `0.6-`）

`NoSuchMethodError` / `NoSuchFieldError` 则属**运行期**发现：依赖求解**已通过**，类链接到那一行时才炸。
描述符里出现 `net.minecraft.client.option.KeyBinding.<init>(String,int,String)` 这类具体签名，说明模组是按
**另一个 MC 版本**编译的——同一条 `KeyBinding` 三参构造在 MC 1.21.11 中已被改动。

## 常见触发

### 触发 A：前置模组根本没装（生产最高频）

已核实的缺失组合（括号内为 logId）：

- `fabric-language-kotlin` 缺失 ← Veinminer 2.12.3（IKhdl1F）；同类还有 `sodiumoptionsmodcompat` 缺 `txnilib`（hy39xXB）
- `reeses-sodium-options` 缺失 ← sodiumoptionsapi 1.0.10（tPB2ovF）
- `farmersdelight` 缺失 ← delightlib（nd7FRqE）
- `accessories` + `resourcefullib` 同时缺失 ← berrypouch / chipped / handcrafted（0AtZSsj）
- `sodium 0.8.11~0.9` + `geckolib ≥5.4.4` 同时缺失 ← Iris / Point Blank / Reese's Sodium Options（BDDhh0a、pH1FpfV）
- **整包缺全部前置库**（`fabric-api`、`fabric-language-kotlin`、`libipn`、`geckolib`、`terrablender`、`glitchcore`）——只装了内容模组的整合包（VKH7V4W）

`hy39xXB` 的报错文案有一个易误判点：求解器给出的是
`Fix: add [], remove [], replace [[sodiumoptionsmodcompat 1.0.10] -> add:sodiumoptionsmodcompat 1 ([(-∞,∞)])]`
——它建议**替换被依赖方本身**，而非安装缺失的 `txnilib`。真正的缺失目标在 `Reason` 行的 `depends txnilib @ [*]` 里。

### 触发 B：前置存在但版本不在区间

案例 3 是最典型的**链式追版本**：`easyanvils` → `puzzleslib ≥26.3.12` → `fabric-api ≥0.163.0`。
只升级 `puzzleslib` 不能解决问题，因为卡点在更深一层。

另一实例是 **Fabric Loader 自身过旧**（logId: UGBrK9Q）：Loader 0.18.4，而多个模组要求 ≥0.19.0/0.19.3/0.19.5。
报错文案直接给出双向建议：

```
	 - 安装 sodium，任意 0.8.x 版本。
	 - 将 模组 'Fabric Loader' (fabricloader) 0.18.4 替换为 0.19.5 及以上版本。
```

### 触发 C：声明式互斥造成无解

案例 2 是「约束无解」的标准形态：Iris 要 `sodium ∈ [0.6,0.7)`，而新 Sodium 声明 `breaks iris @ [<1.8.13]`。
**两边都是硬约束、都无法通过升级满足**——只有「降 Sodium 到 0.6.x」或「升 Iris 到 ≥1.8.13」两条出路。
`Fix` 行给出的 `replace [[sodium 0.8.13] -> add:sodium 0.6-]` 就是降级方案。

判定要点：出现 `NEG_HARD_DEP` 时，问题不在缺失，而在**互斥声明**，不要去找「缺哪个前置」。

### 触发 D：模组编译目标与 MC 版本不符

`NoSuchMethodError` 描述符中的**具体 API 签名**比类名更有价值。已核实的两例都指向同一个 API 变动点——
`KeyBinding(String, int, String)` 三参构造：

| logId | 模组 | 版本 | 崩溃阶段 |
|---|---|---|---|
| LzNjZjk | NewVisualKeybing | 0.9.4 | `client` entrypoint |
| pZFnGrN | Real Camera | 0.6.11-beta | `KeyBindings.<clinit>` |

案例 5 属**加载器 API 变动**而非 MC 变动：`OnDatapackSyncEvent.getPlayers()` 在当前 Forge 47.2.18 中不存在，
栈帧落在 `net.minecraftforge.event.*`。

### 触发 E：同一 MC 版本上的跨版本混装

logId `ZqBLcna`（MC 26.1）同时踩了两个方向：

```
[FabricLoader/Resolution/INFO]: Reason: [HARD_DEP litematica-printer beta25 {depends minecraft @ [>=1.21 <=1.21.1]},
    HARD_DEP gca 2.12.8-mc26.3-snapshot-9+build.97 {depends minecraft @ [>=26.3-]}]
Immediate reason: [... HARD_DEP_NO_CANDIDATE litematica-printer beta25 {depends malilib @ [>=0.28.12]}, ...]
```

`litematica-printer` 只支持到 1.21.1，`gca` 要求 26.3+，**两者夹在 26.1 上形成无解区间**；
同时 mods 目录里还有 **16 份重复的 `litematica-printer beta25`**（`Fix` 行里同一 ID 重复列出十余次），
且缺 `malilib`。该案例的正确处理顺序是：先清重复 → 再补 `malilib` → 最后取舍 `litematica-printer` 与 `gca`。

### 触发 F：整合包跨版本整体搬运

整合包从 26.2 直接放到 26.3 上运行时，**所有锁 26.2 的模组集体失效**，报错会同时出现
`depends minecraft @ [>=26.2 <=26.2]` 之类的硬区间。这类情况不是单个模组的问题，
`Fix` 行会列出**数十个待替换 ID**，逐个修没有意义。

## 修复步骤

**触发 A（缺前置）**

1. 读 `Reason` 行里 `depends <ID> @ [<范围>]` 的 `<ID>`——那是真正要装的模组 ID，不是 `Fix` 行里被建议替换的模组
2. 按 `<ID>` 去 Modrinth / CurseForge 搜（ID 与文件名不同，如 `fabric-api` 对应 `fabric-api-0.163.0+26.3.jar`）
3. 一次装全：`Reason` 行可能列出多个 `HARD_DEP`，全部处理
4. 装完重启游戏，`/reload` 不生效

**触发 B（版本不在区间）**

1. 从 `Fix` 行读出目标版本字符串（案例 3 为 `0.163.0`），直接装该版本
2. 沿依赖链**自底向上**改：先满足最底层，再逐层向上验证
3. 报错同时点出加载器版本时（如 `fabricloader 0.18.4`），先在启动器里更新加载器

**触发 C（互斥无解）**

1. 看到 `NEG_HARD_DEP ... {breaks ...}` 即确认为互斥，停止寻找「缺失的前置」
2. 取 `Fix` 行给出的**降级方案**（案例 2 为 Sodium 降到 `0.6.x`）
3. 或反向升级被排斥方至互斥区间之外（Iris 升到 ≥1.8.13，同时满足 Sodium 0.8.x 的要求）
4. 渲染/光影家族（Iris 与 Sodium）必须**版本成对**，只升一个必然触发互斥

**触发 D（MC 或加载器版本错配）**

1. 从 `NoSuchMethodError` / `NoSuchFieldError` 的描述符读出被调用签名
2. 描述符是 `net.minecraft.*` → 模组与 MC 版本不符；是 `net.minecraftforge.*` / `net.neoforged.*` / `net.fabricmc.*` → 与加载器不符
3. 到该模组发布页确认它标注的支持版本区间，重新下载对应构建
4. 模组只提供旧构建时，改功能替代品或降 MC 版本

**触发 E / F（跨版本混装）**

1. 先做**物理清理**：同一 mod ID 只保留一份 jar，重复的全删（`ZqBLcna` 的 16 份重复必须先清）
2. 再补前置，最后才处理真正的版本取舍
3. `Fix` 行列出十余个待处理 ID 时，改走「换整合包对应版本的完整包」，不要逐个手改

## 置信度线索

- **确定**：日志含 `Mod resolution failed` / `Some of your mods are incompatible with the game or each other!` / `Missing or unsupported mandatory dependencies` 之一，且带 `Immediate reason` 明细
- **确定（缺什么）**：`Reason` 行中 `{depends <ID> @ [<范围>]}` 的 `<ID>` 即缺失目标；`Fix: add [add:<ID> <版本>]` 给出建议版本
- **确定（互斥）**：出现 `NEG_HARD_DEP` 或 Forge 的 `Incompatibilities between mods`，此时问题不是缺失
- **确定（MC 版本错配）**：`NoSuchMethodError` / `NoSuchFieldError` 描述符指向 `net.minecraft.*`，且栈帧是模组自己的类
- **较确定（加载器 API 变动）**：符号缺失的类属于 `net.minecraftforge.*` / `net.neoforged.*` / `net.fabricmc.*`
- **需区分**：`ClassNotFoundException` 指向玩家可见的模组类时，优先查文件是否损坏或未装上，不要当版本错配
- **需追问**：日志未标 MC 版本与加载器版本时向用户确认；同一份日志中 `Loading Minecraft X with Fabric Loader Y` 或 `ModLauncher ... starting` 可提供依据
- **跨案例共性**：本条所有案例都**没有 `crash-reports/`**——依赖求解失败发生在游戏主类加载之前，日志中看不到崩溃报告属正常现象
