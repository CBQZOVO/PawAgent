# Paw：Windows(amd64) 自包含打包（对应 macOS 的 build-app.sh）
#
# 用法（在 Windows 上的仓库根目录，PowerShell 7+）：
#   pnpm install 先跑过，然后：
#   .\build-app.ps1                          # 全流程：编译 → 组装 → 打包
#   $env:PAW_NODE = "C:\path\node.exe"; .\build-app.ps1   # 指定内置 node
#
# 设计约束与 build-app.sh 相同（踩过的坑，别删）：
# - server 用 tsc 编译后的 dist/index.js，不用 tsx 运行时转译；
# - asar 禁用（node-pty 原生模块塞不进 asar）；
# - 网关配置不进包：运行时从 ~/.paw/gateway-config.json 读；
# - 内置 node.exe：不依赖用户 PATH，也不用 Electron 的 execPath；
# - Office 引擎不进包：首次打开文档时询问用户，确认后下载到 ~/.paw/office/。
$ErrorActionPreference = 'Stop'
# 原生命令（pnpm/tsc）退出码非 0 时直接中断：不设这个，pnpm build 失败会拿着旧 dist 继续打包
$PSNativeCommandUseErrorActionPreference = $true
$T0 = Get-Date
$ROOT = $PSScriptRoot
Set-Location $ROOT

function Log($msg) { Write-Host "→ $msg" }

# ===== 0. 前置检查 =====
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Error "✗ 找不到 pnpm，先 npm i -g pnpm"
}
$Version = (Get-Content "$ROOT\package.json" -Raw | ConvertFrom-Json).version
$ElectronVersion = (Get-Content "$ROOT\desktop\node_modules\electron\package.json" -Raw | ConvertFrom-Json).version

# 内置 node.exe：优先环境变量，其次当前 PATH 中的 node
$PawNode = $env:PAW_NODE
if (-not $PawNode) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $PawNode = $cmd.Source }
}
if (-not ($PawNode -and (Test-Path $PawNode))) {
    Write-Error "✗ 内置 node 不存在：$PawNode（用 `$env:PAW_NODE 指定 node.exe 路径）"
}

$Stage = Join-Path $env:TEMP "paw-stage"
$Deploy = Join-Path $env:TEMP "paw-deploy-server"
# 产物放仓库内 pack\（不进 TEMP）：路径稳定，CI 直接传给 upload-artifact
$Pack = Join-Path $ROOT "pack"

# ===== 1. 编译 =====
Log "编译 web / shared / kernel / server ..."
pnpm build
pnpm exec tsc -p shared/tsconfig.build.json
pnpm exec tsc -p kernel/tsconfig.build.json
pnpm exec tsc -p server/tsconfig.build.json

# ===== 2. pnpm deploy：把 server 依赖平铺到独立目录（node-pty 的 win32-x64 预编译也在）=====
Log "平铺 server 运行依赖 ..."
if (Test-Path $Deploy) { Remove-Item -Recurse -Force $Deploy }
pnpm --filter "@paw/server" deploy $Deploy --prod=false

# ===== 3. 组装 staging =====
Log "组装 staging ..."
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
node desktop/scripts/stage-app.mjs --root $ROOT --stage $Stage --deploy $Deploy
if ($LASTEXITCODE -ne 0) { Write-Error "✗ staging 失败" }

# 内置 node.exe
New-Item -ItemType Directory -Force -Path "$Stage\runtime" | Out-Null
Copy-Item $PawNode "$Stage\runtime\node.exe"

# ===== 4. electron-packager 打包 =====
Log "打包 Paw-win32-x64（Electron $ElectronVersion，禁用 asar）..."
if (Test-Path $Pack) { Remove-Item -Recurse -Force $Pack }
pnpm exec electron-packager $Stage "Paw" `
  --platform=win32 --arch=x64 --electron-version=$ElectronVersion `
  --icon="$ROOT\desktop\assets\Paw.ico" `
  --out=$Pack --overwrite --no-prune --asar=false
if ($LASTEXITCODE -ne 0) { Write-Error "✗ electron-packager 失败" }

$App = Join-Path $Pack "Paw-win32-x64"
$SizeMB = [math]::Round((Get-ChildItem $App -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
$Elapsed = [int]((Get-Date) - $T0).TotalSeconds
Write-Host ""
Write-Host "✓ 完成，耗时 $Elapsed 秒"
Write-Host "  产物：$App"
Write-Host "  大小：$SizeMB MB"
Write-Host "  内置 node：$(& "$App\resources\app\runtime\node.exe" -v)"
