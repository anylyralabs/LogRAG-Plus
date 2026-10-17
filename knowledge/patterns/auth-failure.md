# 账号认证失败（正版会话 / 离线登录 / 服务端验证）

## 签名 (Signature)

**客户端拉取账号属性或证书失败（最常见）**

```
com.mojang.authlib.exceptions.InvalidCredentialsException: Status: 401
com.mojang.authlib.exceptions.MinecraftClientHttpException: Status: 401
Caused by: com.mojang.authlib.exceptions.MinecraftClientHttpException: Status: 401
Caused by: MinecraftClientHttpException[type=HTTP_ERROR, status=401, response=ErrorResponse[path=/player/attributes, error=null, errorMessage=null, details=null]]
Caused by: MinecraftClientHttpException[type=HTTP_ERROR, status=401, response=ErrorResponse[path=/player/certificates, error=null, errorMessage=null, details=null]]
	at com.mojang.authlib.exceptions.MinecraftClientHttpException.toAuthenticationException(MinecraftClientHttpException.java:70)
	at com.mojang.authlib.yggdrasil.YggdrasilUserApiService.fetchProperties(YggdrasilUserApiService.java:150)
```

**伴随的下载线程报错（与上一组同时出现）**

```
[Render thread/ERROR]: Failed to fetch user properties
[Download-2/ERROR]: Failed to retrieve profile key pair
[Download-2/ERROR]: Failed to fetch Realms feature flags
[Download-2/INFO]: Could not authorize you against Realms server: java.lang.RuntimeException: Failed to parse into SignedJWT: <32位十六进制串>
```

**会话加入服务器被拒（`ForbiddenOperationException`）**

```
com.mojang.authlib.exceptions.InvalidCredentialsException: ForbiddenOperationException
com.mojang.authlib.exceptions.MinecraftClientHttpException: Status: 403
	at com.mojang.authlib.yggdrasil.YggdrasilMinecraftSessionService.joinServer(YggdrasilMinecraftSessionService.java:83)
Caused by: com.mojang.authlib.exceptions.InvalidCredentialsException: ForbiddenOperationException
```

**服务端侧验证失败**

```
[Server thread/WARN]: Failed to verify username but will let them in anyway!
[Server thread/ERROR]: Username '<玩家名>' tried to join with an invalid session
Failed to verify username!
com.mojang.realmsclient.exception.RealmsServiceException: Realms authentication error with message
    'javax.ws.rs.NotAuthorizedException: HTTP 401 Unauthorized'
```

## 含义

Minecraft 的账号认证走 Microsoft / Mojang 的 HTTP 服务，登录成功后客户端持有一个**会话令牌（access token）**与**档案密钥对（profile key pair）**。游戏启动后会在后台异步拉取账号属性、证书与 Realms 信息，这些请求携带令牌；令牌失效、过期或被吊销时，服务端返回 401 / 403。

**本类故障最关键的认知：401 类的认证错误极常与真正的崩溃「同时出现」，且往往读起来比真正的崩溃更显眼。**

原因是两者的出现时机与格式差异极大：

| 维度 | 认证错误 | 真正的崩溃 |
|---|---|---|
| 出现时机 | 游戏**启动过程中**（后台 `Download-*` 线程） | 游戏**加载/运行到故障点**时 |
| 日志级别 | 多为 `ERROR`，带完整 Java 栈 | `FATAL`，或形如 `# A fatal error` 的原生崩溃块 |
| 线程名 | `Download-1` / `Download-2` / `Realms Notification Availability checker` | `Render thread` / `Main` / `Server thread` |
| 是否终止进程 | **不终止** | 终止 |
| 后续日志 | 游戏继续正常输出 INFO | 日志在此处终止 |

所以在 `fcl-latest-2646648029949214115.log` 中，第 276 行的 `InvalidCredentialsException: Status: 401`（后台线程，游戏继续运行）与第 372 行的真正崩溃（`SIGSEGV` + `libbinder.so`）之间相隔近百行——**只要看到 401 就归因于认证，会把真正的原因（内存耗尽导致的系统组件损坏）完全错过**。

同类情况在 `KBj3hBs.log` 中重复出现：第 1762 行是认证 401，真正的崩溃是第 5292 行的 `SIGSEGV`。两者之间相差三千多行。

**区分方法**：认证错误**不会终止进程**，因此**判断一份日志是否真的崩溃，必须找终止性标记，而不是找最显眼的异常**。终止性标记只有四种：

```
---- Minecraft Crash Report ----       游戏崩溃
# A fatal error has been detected     原生崩溃（其后紧跟 Problematic frame）
<启动器名> Crash Report                 启动器崩溃
Minecraft has crashed!                 游戏崩溃（简化版）
```

**这四种标记一个都没有时，认证错误才可能是用户实际遇到的问题**（即游戏确实正常退出了，只是登录失败）。

## 常见触发

### 触发 A：会话令牌过期或失效（正版账号）

Microsoft 账号的 access token 有有效期（数小时至数天），过期后需要重新登录刷新。启动器长时间未重启、或从备份还原了旧启动器数据时会持有过期令牌。

典型签名：`InvalidCredentialsException: Status: 401`，`path=/player/attributes` 或 `path=/player/certificates`。

### 触发 B：账号在其他设备登录导致令牌被吊销

同一账号在多设备登录时，新登录的会话可能使旧令牌失效。

典型签名：与触发 A 相同，但用户会在「不久前还能正常玩」的描述中出现。

### 触发 C：未登录 / 离线模式

启动器中未选择有效账号，或以离线模式启动。此时客户端仍会尝试拉取账号属性，必然失败。

典型签名：`Status: 401`，且**游戏仍可正常进入单人世界**——因为单人游戏不需要会话验证。

### 触发 D：服务端 `online-mode` 与会话不匹配

服务器开启 `online-mode=true` 时要求客户端提供有效的 Mojang 会话。离线客户端、令牌失效的客户端、或经过第三方代理（BungeeCord / Velocity）但未正确配置 IP 转发时均会失败。

典型签名（服务端侧）：`Failed to verify username!`、`Username '<玩家名>' tried to join with an invalid session`。

`Failed to verify username but will let them in anyway!` 与前一行的区别在于：服务端处于 `online-mode=false` 或验证被显式跳过时会放行并记录 WARN，属正常行为。

### 触发 E：Realms 相关服务不可用

Realms 的认证链路独立于普通游戏会话，令牌格式不符时会报 `Failed to parse into SignedJWT`。

典型签名：`Could not authorize you against Realms server: java.lang.RuntimeException: Failed to parse into SignedJWT: <32位十六进制串>`、`RealmsServiceException: Realms authentication error`。

注意该串是日志中**被脱敏的令牌片段**，不是可使用的凭据。

### 触发 F：第三方模组的独立认证失败

模组自带账号联动服务（表情同步、皮肤服务、外部平台账号绑定）时，它会独立调用认证接口。

典型签名：`EmoteLibraryException$AuthFailed: verification failed: ForbiddenOperationException`，底层 `Caused by: InvalidCredentialsException: ForbiddenOperationException`，栈帧含 `YggdrasilMinecraftSessionService.joinServer`。

这类失败**只影响该模组的功能**，不影响游戏本体，日志中常紧随 `Failed to open ... notifications!` 之类的功能降级提示。

## 修复步骤

**触发 A / B / C（客户端会话问题）**

1. 在启动器中**退出当前账号并重新登录**，让令牌刷新
2. 确认账号列表中显示的是正版账号而非「离线 / 游客」条目
3. 重新登录后重启游戏（令牌在启动时读取一次，不重启不生效）
4. 多人游戏需要有效会话；单人游戏不需要，若仅为玩单机可忽略该错误
5. 反复出现且重登无效时，确认设备时间是否准确——令牌校验依赖系统时间

**触发 D（服务端会话验证）**

1. 确认服务端 `server.properties` 中 `online-mode` 的取值与客户端账号状态匹配
2. 代理架构下检查 IP 转发配置：BungeeCord 需在 `config.yml` 中开启 `ip_forward: true`，Velocity 需配置 `player-info-forwarding-mode`
3. 未开启转发时，代理后的所有玩家会被视为同一来源，验证必然失败
4. 正版服不要用离线账号连接；离线服应设置 `online-mode=false`

**触发 E（Realms）**

1. 该错误不影响普通多人联机，仅 Realms 功能不可用，可先忽略
2. 需要 Realms 时按触发 A 重新登录刷新令牌
3. 确认账号确实拥有 Realms 订阅

**触发 F（模组独立认证）**

1. 该失败的**影响范围限于该模组自身功能**，不是游戏崩溃原因
2. 按触发 A 重新登录后通常自动恢复
3. 模组功能持续不可用且不影响游戏时，可选择停用该模组

**通用前提：先确认是否存在真正的崩溃**

1. 在日志中搜索终止性标记：`---- Minecraft Crash Report ----`、`# A fatal error has been detected`、`<启动器名> Crash Report`、`Minecraft has crashed!`
2. 找到任一标记即说明存在真正的崩溃，认证错误与它无关，应转向该标记后的 `Problematic frame` / `Description:` 继续分析
3. 四种标记一个都没有，且日志在正常 INFO 行处自然结束，才可认为本次会话没有崩溃
4. 日志存在 `crash-reports/` 附件或 `hs_err_pid*.log` 时，优先读附件——它们的信息密度高于 `latest.log` 尾部

## 置信度线索

- **确定（认证失败本身）**：出现 `InvalidCredentialsException` / `MinecraftClientHttpException` + `status=401` 或 `403` / `ForbiddenOperationException` 之一
- **确定（认证不是崩溃原因）**：日志中同时存在四种终止性标记之一。此时认证错误的线程名必定是 `Download-*` 或 `Realms Notification Availability checker` 一类后台线程
- **较确定（认证是唯一问题）**：只有 401 类错误、**无任何终止性标记**、且日志在正常 INFO 行处自然结束（如 `Stopping server` / 正常退出流程）
- **较确定（影响范围有限）**：401 出现在 `path=/player/attributes` 或 `/player/certificates`，游戏仍继续输出大量 INFO——这类请求失败会让皮肤、证书签名等功能降级，但**不阻止进入游戏**
- **较确定（服务端侧）**：出现 `Failed to verify username!` 或 `tried to join with an invalid session`，此时应从服务端 `online-mode` 与代理转发配置入手，而非客户端账号
- **需注意（时间线判据）**：认证 401 出现的**行号远早于**终止性标记时（实测中相隔数百至数千行），两者必然无关。行号接近也需看线程名，只有后台下载线程的失败才与主流程无关
- **需追问**：确认用户的实际症状——「游戏能正常进但皮肤/联机异常」与「游戏完全无法启动」对应完全不同的处理方向。同时确认账号类型（正版 / 离线）与是否使用了代理
