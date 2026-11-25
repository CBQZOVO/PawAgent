// 启动 Electron 前清掉宿主可能设置的 ELECTRON_RUN_AS_NODE（WorkBuddy 等 Electron 宿主会设它，
// 导致我们的 electron 被当纯 Node 跑、require('electron') 返回 undefined）。
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // electron 可执行文件路径
const { ensurePawApp } = require('./prepare-app.cjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS; // 宿主注入的 Node 参数在 .app 里会报不支持，Launcher 不需要
const executable = process.platform === 'darwin' ? ensurePawApp(electron) : electron;
const child = spawn(executable, [path.resolve(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
