// 打包 staging 组装：把编译产物 + 平铺依赖 + 前端资源拼成 electron-packager 的输入目录。
//
// 与 build-app.sh 里的 python 段逻辑一致，但专门给 Windows 用（PowerShell 做不了
// 干净的递归复制/字符串替换）。为什么这样设计：
// - server 用编译后的纯 JS dist，不带 tsx 运行时转译（见 build-app.sh 头部注释）；
// - pnpm deploy 平铺的 node_modules 里，传递依赖藏在 .pnpm/node_modules，顶层补齐；
//   Windows 上直接复制成真实文件（不走 junction/symlink），electron-packager 复制时
//   不依赖任何链接语义，最稳；
// - 网关配置、用户数据不进包（运行时从 ~/.paw 读）；
// - Office 引擎不进包：运行时由用户确认后下载到 ~/.paw/office/。
//
// 用法：node desktop/scripts/stage-app.mjs --root <repo根> --stage <输出目录> --deploy <pnpm deploy目录>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = path.resolve(arg('root'));
const stage = path.resolve(arg('stage'));
const deploy = path.resolve(arg('deploy'));

if (!existsSync(root) || !existsSync(deploy)) {
  console.error(`✗ --root 或 --deploy 目录不存在：${root} / ${deploy}`);
  process.exit(1);
}

const copy = (src, dest) => cpSync(src, dest, { recursive: true, dereference: true });
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

mkdirSync(stage, { recursive: true });
// 入口 package.json：main 指向 desktop/src/main.cjs，ROOT 解析正好是 stage 根
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'paw', version, productName: 'Paw',
  description: 'Paw Desktop', main: 'desktop/src/main.cjs',
  author: 'Paw', license: 'MIT', type: 'module',
}, null, 2));

// desktop：主进程代码 + 资源
copy(path.join(root, 'desktop/src'), path.join(stage, 'desktop/src'));
copy(path.join(root, 'desktop/assets'), path.join(stage, 'desktop/assets'));

// server：编译产物 + 运行期资源 + 平铺依赖
mkdirSync(path.join(stage, 'server'), { recursive: true });
copy(path.join(root, 'server/dist'), path.join(stage, 'server/dist'));
copy(path.join(root, 'server/agents'), path.join(stage, 'server/agents'));
copy(path.join(deploy, 'node_modules'), path.join(stage, 'server/node_modules'));

// pnpm 把传递依赖（esbuild/zod…）藏在 .pnpm/node_modules，Node 标准解析找不到；
// 顶层补齐（复制成真实目录，不用链接——Windows 上链接语义最不可控）
const hidden = path.join(stage, 'server/node_modules/.pnpm/node_modules');
if (existsSync(hidden)) {
  for (const name of readdirSync(hidden)) {
    const target = path.join(stage, 'server/node_modules', name);
    if (!existsSync(target)) {
      const src = path.join(hidden, name);
      if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) copy(src, target);
    }
  }
}

// 编译产物里的 @paw/shared / @paw/kernel 值导入 → 相对路径（import type 编译后已消失）。
// 层级按文件所在目录算：server/dist/index.js 到 app/shared 是 ../../，再深一层多一级 ../
const distDir = path.join(stage, 'server/dist');
const rewrite = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) { rewrite(p); continue; }
    if (!name.name.endsWith('.js')) continue;
    let s = readFileSync(p, 'utf8');
    if (!s.includes("@paw/shared'") && !s.includes("@paw/kernel'")) continue;
    const levels = path.relative(distDir, p).split(/[\\/]/).length - 1;
    const prefix = '../'.repeat(2 + levels);
    s = s.replaceAll("from '@paw/shared'", `from '${prefix}shared/dist/index.js'`)
      .replaceAll("from '@paw/kernel'", `from '${prefix}kernel/dist/index.js'`);
    writeFileSync(p, s);
  }
};
rewrite(distDir);

// shared & kernel 编译产物 + 前端
copy(path.join(root, 'shared/dist'), path.join(stage, 'shared/dist'));
copy(path.join(root, 'kernel/dist'), path.join(stage, 'kernel/dist'));
copy(path.join(root, 'web/dist'), path.join(stage, 'web/dist'));

console.log(`✓ staging 完成：${stage}（version ${version}）`);
