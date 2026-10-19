#!/data/data/com.termux/files/usr/bin/bash
#
# 重启 LogRAG+ 服务。
#
# 用法: scripts/restart.sh [--port N]
#
# 为什么需要脚本：手写 `kill && sleep && start` 有三个坑，都踩过：
#   1. kill 之后进程未必立刻退出（SQLite/协程还在收尾），新进程撞 EADDRINUSE；
#   2. 启动要 6–10 秒才监听，`sleep 3` 就去探测会误判成「没起来」；
#   3. 失败信息被 `>log 2>&1` 吞掉，只看到「服务没起来」。
# 这里每一步都**等确定的事实**（进程消失、端口释放、READY 出现），不猜时长。
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PIDFILE=/data/data/com.termux/files/usr/tmp/lograg-server.pid
LOG=/data/data/com.termux/files/usr/tmp/lograg-server.log
READY_TIMEOUT=60

PORT_ARG="${PORT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT_ARG="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

# ── 1. 停旧进程 ──────────────────────────────────────────
stop_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill -0 "$pid" 2>/dev/null || return 0

  kill "$pid" 2>/dev/null

  # 等它真的消失（最多 10 秒），而不是 sleep 固定秒数
  local i=0
  while [ $i -lt 100 ]; do
    kill -0 "$pid" 2>/dev/null || { echo "  ✓ 进程 $pid 已退出"; return 0; }
    sleep 0.1
    i=$((i + 1))
  done

  echo "  ! 进程 $pid 10 秒未退出，强制终止"
  kill -9 "$pid" 2>/dev/null
  sleep 1
}

echo "[1/4] 停止旧进程"
if [ -f "$PIDFILE" ]; then
  stop_pid "$(cat "$PIDFILE" 2>/dev/null)"
  rm -f "$PIDFILE"
fi
# pidfile 之外可能还有手起的实例（开发时常见）
STRAY=$(ps -ef 2>/dev/null | grep "node dist/server.js" | grep -v grep | awk '{print $2}')
for p in $STRAY; do stop_pid "$p"; done

# ── 2. 等端口释放 ────────────────────────────────────────
echo "[2/4] 等待端口释放"
BASE_PORT="${PORT_ARG:-$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2)}"
BASE_PORT="${BASE_PORT:-8080}"
free=0
for i in $(seq 1 50); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$BASE_PORT") 2>/dev/null; then
    free=1; break
  fi
  exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null
  sleep 0.1
done
if [ "$free" = "1" ]; then
  echo "  ✓ 端口 $BASE_PORT 空闲"
else
  echo "  ! 端口 $BASE_PORT 仍被占用（继续启动，服务会自动递增端口）"
fi

# ── 3. 启动 ──────────────────────────────────────────────
echo "[3/4] 启动服务"
: > "$LOG"
if [ -n "$PORT_ARG" ]; then export PORT="$PORT_ARG"; fi
setsid nohup node dist/server.js >> "$LOG" 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

# ── 4. 等 READY（服务自己打印的真实端口）──────────────────
echo "[4/4] 等待就绪（最多 ${READY_TIMEOUT}s）"
REAL_PORT=""
for i in $(seq 1 $((READY_TIMEOUT * 10))); do
  if grep -q '^READY port=' "$LOG" 2>/dev/null; then
    REAL_PORT=$(grep '^READY port=' "$LOG" | tail -1 | sed 's/.*port=//')
    break
  fi
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "  ✗ 进程已退出，日志："
    tail -20 "$LOG"
    exit 1
  fi
  sleep 0.1
done

if [ -z "$REAL_PORT" ]; then
  echo "  ✗ ${READY_TIMEOUT}s 内未就绪，日志："
  tail -20 "$LOG"
  exit 1
fi

if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$REAL_PORT/health"; then
  echo "  ✓ 健康检查通过 → http://127.0.0.1:$REAL_PORT"
  # 前端不由本仓库提供：只有 WEB_DIR 指向了产物才报地址，否则如实说没有
  if grep -q '前端页面: 未布置' "$LOG" 2>/dev/null; then
    echo "  · 前端未布置（纯 API 模式；用 WEB_DIR 指向前端产物即可挂到 /logshare/）"
  else
    echo "  ✓ 前端页面     → http://127.0.0.1:$REAL_PORT/logshare/"
  fi
else
  echo "  ✗ 端口已监听但 /health 不通，日志："
  tail -20 "$LOG"
  exit 1
fi
