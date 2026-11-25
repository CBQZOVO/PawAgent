#!/usr/bin/env bash
# Paw：编译 + 打包 + 重启桌面 App（macOS）
#
# 用法：pnpm rebuild-app
#   或：bash desktop/scripts/rebuild-restart.sh
#
# 关键点（别删）：
# - server 是 tsx 源码跑的，静态目录直读 web/dist，所以 build 完不用额外「部署」；
# - 退出必须走 osascript 正常退出，Paw 主进程会带 server 子进程一起收，别直接 kill；
# - 网关配置由 server 自动读取 ~/.paw/gateway-config.json（也可用环境变量 GATEWAY_KEY 覆盖）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/desktop/.local/rebuild.log"
URL="http://127.0.0.1:8787"
PAW_MAIN="$ROOT/desktop/.local/Paw.app/Contents/MacOS/Paw"

echo "→ 编译打包..."
cd "$ROOT"
pnpm build

echo "→ 退出当前 Paw..."
if osascript -e 'tell application "Paw" to quit' >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    pgrep -f "$PAW_MAIN" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
# 端口还占着说明 server 没退干净，别起一个连不上后端的空壳
if curl -sf "$URL/api/health" >/dev/null 2>&1; then
  echo "✗ 8787 仍有服务在跑，先手动关掉 Paw / server 再重试" >&2
  exit 1
fi

echo "→ 启动 Paw（日志：${LOG}）..."
mkdir -p "$(dirname "$LOG")"
# 直接后台启动 + disown 脱离脚本：不要套 ( ... & ) 子 shell，
# 那样 pnpm 会挂在脚本进程下，脚本退出不了（终端一直不返回）。
nohup pnpm desktop > "$LOG" 2>&1 < /dev/null &
disown || true

echo "→ 等后端就绪..."
for _ in $(seq 1 60); do
  if curl -sf "$URL/api/health" >/dev/null 2>&1; then
    echo "✓ 完成：$(curl -s "$URL/api/health")"
    ASSETS="$(curl -s "$URL/" | grep -oE '/assets/[^"]+' | tr '\n' ' ' || true)"
    echo "  首页资源：${ASSETS:-无}"
    exit 0
  fi
  sleep 0.5
done

echo "✗ 启动超时，看日志：$LOG" >&2
tail -30 "$LOG" >&2
exit 1
