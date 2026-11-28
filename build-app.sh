#!/usr/bin/env bash
# Paw：打一个自包含 Paw.app 并安装到 /Applications（macOS arm64）
#
# 用法：
#   pnpm package-app                       # 全流程：编译 → 组装 → 打包 → 安装
#   PAW_NODE=/path/to/node pnpm package-app  # 指定内置 node（默认读 NVM 的 v24）
#   PAW_NO_INSTALL=1 pnpm package-app      # 只打包不安装（产物在 /tmp/paw-pack）
#
# 为什么这样设计（踩过的坑，别删）：
# - server 用 tsc 编译后的 dist/index.js，**不用 tsx 运行时转译**：
#   tsx 依赖 esbuild/zod 等传递依赖，pnpm 虚拟 store + 打包极易缺模块，编译成纯 JS 一了百了。
# - asar 必须禁用：node-pty 是原生模块，塞进 asar 加载不了。
# - 网关配置不进包：运行时 server 从 ~/.paw/gateway-config.json 读（没配置会显示页面让填，不直接退出）。
# - Office 引擎不进包：首次打开文档时询问用户，确认后下载到 ~/.paw/office/。
# - 内置 node：server 必须有个 node 跑 JS，不能依赖用户 PATH，也不能用 Electron 的 execPath。
set -euo pipefail

T0=$SECONDS  # bash 内置秒数，从本 shell 启动算起，用来输出总耗时
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Paw"
# 版本号直接从 JSON 读（进到 ROOT 再读，避免引号嵌套）
cd "$ROOT"
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
ELECTRON_VERSION="$(python3 -c "import json;print(json.load(open('desktop/node_modules/electron/package.json'))['version'])")"

# 内置 node：优先环境变量，其次当前 PATH 中的 node
PAW_NODE="${PAW_NODE:-$(command -v node || true)}"
if [ ! -x "$PAW_NODE" ]; then
  echo "✗ 内置 node 不存在：${PAW_NODE}（用 PAW_NODE=/path/to/node 指定）" >&2
  exit 1
fi

STAGE="/tmp/paw-stage"
DEPLOY="/tmp/paw-deploy-server"
PACK="/tmp/paw-pack"
APP="$PACK/$APP_NAME-darwin-arm64/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

log() { echo "→ $*"; }

# ===== 1. 编译 =====
log "编译 web / shared / kernel / server ..."
cd "$ROOT"
pnpm build                                          # web/dist
./node_modules/.bin/tsc -p shared/tsconfig.build.json
./node_modules/.bin/tsc -p kernel/tsconfig.build.json
./node_modules/.bin/tsc -p server/tsconfig.build.json

# ===== 2. pnpm deploy：把 server 依赖平铺到独立目录（原生 node-pty 也在）=====
log "平铺 server 运行依赖 ..."
rm -rf "$DEPLOY"
pnpm --filter @paw/server deploy "$DEPLOY" --prod=false >/dev/null

# ===== 3. 组装 staging（最终会原样塞进 .app/Contents/Resources/app）=====
log "组装 staging ..."
rm -rf "$STAGE" && mkdir -p "$STAGE"
VERSION="$VERSION" APP_NAME="$APP_NAME" ROOT="$ROOT" STAGE="$STAGE" DEPLOY="$DEPLOY" python3 - <<'PY'
import json, os, shutil, pathlib
root, stage, deploy = (pathlib.Path(os.environ[k]) for k in ('ROOT', 'STAGE', 'DEPLOY'))
version, app = os.environ['VERSION'], os.environ['APP_NAME']

# 入口 package.json：main 指向 desktop/src/main.cjs，ROOT 解析正好是 stage 根
(stage / 'package.json').write_text(json.dumps({
    'name': 'paw', 'version': version, 'productName': app,
    'description': 'Paw Desktop', 'main': 'desktop/src/main.cjs',
    'author': 'Paw', 'license': 'MIT', 'type': 'module',
}, ensure_ascii=False, indent=2))

# desktop：主进程代码 + 资源
for d in ('src', 'assets'):
    shutil.copytree(pathlib.Path(root) / 'desktop' / d, stage / 'desktop' / d)

# server：编译产物 + 运行期资源 + 平铺依赖
sd = stage / 'server'; sd.mkdir()
shutil.copytree(pathlib.Path(root) / 'server' / 'dist', sd / 'dist')
# 只带「代码要读的资源」。data/、persona/ 和 workspace-config.json / search-config.json 是**用户数据**，
# 放 ~/.paw（见 server/src/paths.ts）——以前跟着包走，每次重装就把会话和工作区清空了。
shutil.copytree(pathlib.Path(root) / 'server' / 'agents', sd / 'agents')
shutil.copytree(pathlib.Path(deploy) / 'node_modules', sd / 'node_modules')
# node-pty 在 macOS 上靠 spawn-helper 起 shell，必须带执行位；pnpm deploy 复制时会丢掉，
# 丢了之后终端报 posix_spawnp failed。只给当前架构的 helper 补，别动 win32/x64 的。
for helper in (sd / 'node_modules').rglob('node-pty/prebuilds/darwin-arm64/spawn-helper'):
    helper.chmod(0o755)
    print(f'→ 已修复 spawn-helper 执行位：{helper}')

# pnpm 把传递依赖（esbuild/zod…）藏在 .pnpm/node_modules，Node 标准解析找不到；
# 顶层补软链。electron-packager 复制时会把软链解引用成真实目录，正好不依赖软链。
hidden = sd / 'node_modules' / '.pnpm' / 'node_modules'
for p in hidden.iterdir():
    target = sd / 'node_modules' / p.name
    if not target.exists():
        target.symlink_to(f'.pnpm/node_modules/{p.name}')

# 编译产物里的 @paw/shared / @paw/kernel 值导入 → 相对路径（import type 编译后已消失）。
# 层级必须按文件所在目录算：server/dist/index.js 到 app/shared 是 ../../，
# server/dist/agent/context.js 到 app/shared 是 ../../../。
for js in (sd / 'dist').rglob('*.js'):
    s = js.read_text()
    if "@paw/shared'" not in s and "@paw/kernel'" not in s:
        continue
    # depth 0=server/dist/index.js；depth 1=server/dist/agent/context.js。
    levels = len(js.relative_to(sd / 'dist').parts) - 1
    prefix = '../' * (2 + levels)
    s = s.replace("from '@paw/shared'", f"from '{prefix}shared/dist/index.js'")
    s = s.replace("from '@paw/kernel'", f"from '{prefix}kernel/dist/index.js'")
    js.write_text(s)

# shared & kernel 编译产物
shutil.copytree(pathlib.Path(root) / 'shared' / 'dist', stage / 'shared' / 'dist')
shutil.copytree(pathlib.Path(root) / 'kernel' / 'dist', stage / 'kernel' / 'dist')
# 前端
shutil.copytree(pathlib.Path(root) / 'web' / 'dist', stage / 'web' / 'dist')
PY

# 内置 node
mkdir -p "$STAGE/runtime"
cp "$PAW_NODE" "$STAGE/runtime/node"
chmod +x "$STAGE/runtime/node"

# ===== 4. electron-packager 打包 =====
log "打包 $APP_NAME.app（Electron ${ELECTRON_VERSION}，禁用 asar）..."
rm -rf "$PACK"
./node_modules/.bin/electron-packager "$STAGE" "$APP_NAME" \
  --platform=darwin --arch=arm64 --electron-version="$ELECTRON_VERSION" \
  --out="$PACK" --overwrite --no-prune --asar=false 2>&1 | grep -v 'invalid value (false)'
# packager 的 --icon 在这版对 icns 无效，直接替换默认图标
cp "$ROOT/desktop/assets/Paw.icns" "$APP/Contents/Resources/electron.icns"

# ===== 5. 安装到 /Applications =====
if [ "${PAW_NO_INSTALL:-0}" = "1" ]; then
  log "跳过安装（PAW_NO_INSTALL=1），产物：$APP"
  echo "✓ 完成，耗时 $((SECONDS - T0)) 秒（跳过安装）"
  exit 0
fi
log "退出正在运行的 $APP_NAME ..."
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  pgrep -f "$DEST/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || break
  sleep 0.5
done
# 端口残留会让新版连不上后端
if lsof -ti:8787 >/dev/null 2>&1; then
  log "清理 8787 残留进程 ..."
  lsof -ti:8787 | xargs -r kill -9 2>/dev/null || true
fi

# 装之前先把旧包里的用户数据搬到 ~/.paw（新包不再带 data，rm -rf 会把它删掉）。
# 只在目标不存在时复制，不覆盖用户已有的数据。
PAW_HOME="$HOME/.paw"
mkdir -p "$PAW_HOME"
OLD_APP_SERVER="$DEST/Contents/Resources/app/server"
if [ -d "$OLD_APP_SERVER" ]; then
  [ -f "$PAW_HOME/paw.db" ] || cp "$OLD_APP_SERVER/data/paw.db" "$PAW_HOME/paw.db" 2>/dev/null || true
  for f in workspace-config.json search-config.json; do
    [ -f "$PAW_HOME/$f" ] || cp "$OLD_APP_SERVER/$f" "$PAW_HOME/$f" 2>/dev/null || true
  done
  log "已把旧版用户数据搬到 $PAW_HOME"
fi

log "安装到 $DEST ..."
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST"

echo "✓ 完成：$DEST"
echo "  版本：$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")"
echo "  大小：$(du -sh "$DEST" | cut -f1)"
echo "  内置 node：$("$DEST/Contents/Resources/app/runtime/node" -v)"
echo "  耗时：$((SECONDS - T0)) 秒"
