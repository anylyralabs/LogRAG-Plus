# 实测资产位置

> 实测脚本与数据**不在 git 内**（体积大、可重建）。恢复后按此找。

## 日志来源

| 资产 | 位置 | 说明 |
|---|---|---|
| 27 份真实日志 | `LogShare/testlogs/` | 5.5MB，用户提供 |

## 本地实测产物（`/data/data/com.termux/files/usr/tmp/lstest/`）

| 资产 | 说明 |
|---|---|
| `sse/*.sse` | 27 份完整 SSE 流 |
| `sse/*.json` | `parse_sse.php` 解析结果（思维链/工具链/结构化结论） |
| `progress.log` / `index.jsonl` | 批量进度与上传 ID |
| `*.id` | 各样本的 LogShare 日志 ID |

## 探查与分析脚本（`/data/data/com.termux/files/usr/tmp/`）

| 脚本 | 用途 |
|---|---|
| `run_all.sh` | 批量上传+分析全部日志（大文件用临时 JSON 传参，防参数超长） |
| `run_one.sh` | 单份跑 |
| `parse_sse.php` | SSE → 思维链/工具链/结论 |
| `summarize.php` / `compare.php` | 汇总与人工基准对比 |
| `baseline.php` / `diag_anchor.php` | 真崩溃标注与锚点诊断 |
| `mine output cases.json` | 300 条分析记录挖掘结果（245 条 ≥85 分） |

## 配置备份

| 文件 | 位置 |
|---|---|
| `Config.inc.php` 实测前备份 | `/data/data/com.termux/files/usr/tmp/Config.inc.php.bak` |
| `.env` 备份 | `/data/data/com.termux/files/usr/tmp/env.bak` |

实测改动（`Config.inc.php`，gitignored）：`storageId=f`、`cache.enabled=false`、
`ai.rag.enabled=false`（embedding 不可用）、`eventQueue.enabled=false`。
恢复生产前用备份还原。

## 服务进程

| 服务 | 地址 | 说明 |
|---|---|---|
| 本地模型 | `127.0.0.1:8765`（`hy4-preview-f`） | Bearer 在环境变量，不落盘 |
| Hyperf | `127.0.0.1:9501` | `php bin/hyperf.php start` |
| LogRAG+ | `127.0.0.1:8788` | `npx tsx src/server.ts` |

## 重跑一条实测

```bash
cd /data/data/com.termux/files/home/Project/LogRAG-Plus
npx tsx scripts/e2e-test.ts /data/data/com.termux/files/home/LogShare/testlogs/<file> "问题"
```
