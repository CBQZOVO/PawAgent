// 生成 GitHub Release 正文（Markdown）：
// - 仅提取「上一个 v* tag 到当前 HEAD」的提交记录，按类型自动分组为本次 Changelog；
// - 自动列出产物平台、大小与 SHA-256 校验值；
// - 附带 macOS / Windows 首次安装指引与 Full Changelog 对比链接。
//
// 用法：node desktop/scripts/gen-release-notes.mjs --tag v1.0.0-rc.3 --artifacts dist-artifacts --out release-notes.md
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const tag = arg('tag') || '';
const artifactsDir = arg('artifacts') || 'dist-artifacts';
const outPath = arg('out') || 'release-notes.md';
const repo = process.env.GITHUB_REPOSITORY || 'CBQZOVO/PawAgent';

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// 查找当前分支历史上最近的一个 v* tag（排除当前即将发布的 tag 本身）
function findPrevTag(currentTag) {
  const tags = git(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-creatordate'])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== currentTag);
  return tags[0] || '';
}

// 按 Conventional Commits 分组上次 tag 到当前的提交
function groupCommits(prevTag) {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const raw = git(['log', range, '--no-merges', '--pretty=format:%h\t%s']);
  const groups = {
    feat: [],
    fix: [],
    perf: [],
    docs: [],
    chore: [],
    other: [],
  };
  if (!raw) return groups;

  for (const line of raw.split(/\r?\n/)) {
    const [hash, subject] = line.split('\t');
    if (!hash || !subject) continue;
    const m = subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
    if (!m) {
      groups.other.push(`- ${subject} (\`${hash}\`)`);
      continue;
    }
    const [, type, scope, msg] = m;
    const item = scope ? `- **${scope}**: ${msg} (\`${hash}\`)` : `- ${msg} (\`${hash}\`)`;
    if (type === 'feat') groups.feat.push(item);
    else if (type === 'fix') groups.fix.push(item);
    else if (type === 'perf' || type === 'refactor') groups.perf.push(item);
    else if (type === 'docs') groups.docs.push(item);
    else if (type === 'chore' || type === 'ci' || type === 'build' || type === 'test') groups.chore.push(item);
    else groups.other.push(item);
  }
  return groups;
}

function collectArtifacts(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  return files.map((name) => {
    const full = path.join(dir, name);
    const bytes = statSync(full).size;
    const sizeMB = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex');
    let platform = '通用';
    if (name.endsWith('.dmg')) platform = 'macOS (Apple Silicon / arm64)';
    else if (name.endsWith('.exe')) platform = 'Windows (x64 安装向导)';
    else if (name.includes('macos')) platform = 'macOS (Apple Silicon / arm64)';
    else if (name.includes('windows')) platform = 'Windows (x64)';
    return { name, platform, sizeMB, sha256 };
  });
}

const prevTag = findPrevTag(tag);
const groups = groupCommits(prevTag);
const artifacts = collectArtifacts(artifactsDir);

const lines = [];
lines.push('### 更新内容');
lines.push('');

const sections = [
  ['✨ 新功能', groups.feat],
  ['🐛 问题修复', groups.fix],
  ['⚡ 优化与重构', groups.perf],
  ['📚 文档更新', groups.docs],
  ['🔧 工程与构建', groups.chore],
  ['📝 其他变更', groups.other],
];

let hasChanges = false;
for (const [title, items] of sections) {
  if (items.length === 0) continue;
  hasChanges = true;
  lines.push(`#### ${title}`);
  lines.push(...items);
  lines.push('');
}
if (!hasChanges) {
  lines.push('- 暂无新的代码提交。');
  lines.push('');
}

if (artifacts.length > 0) {
  lines.push('### 下载与校验');
  lines.push('');
  lines.push('| 平台 | 安装包 | 大小 | SHA-256 |');
  lines.push('| :--- | :--- | :---: | :--- |');
  for (const a of artifacts) {
    lines.push(`| ${a.platform} | \`${a.name}\` | ${a.sizeMB} | \`${a.sha256.slice(0, 16)}…\` |`);
  }
  lines.push('');
}

lines.push('### 安装说明');
lines.push('');
lines.push('> 当前安装包暂未进行商业代码签名，首次安装时系统可能会弹出安全提醒，按下方步骤放行即可：');
lines.push('');
lines.push('- **macOS (Apple Silicon)**：双击 `.dmg`，将 `Paw.app` 拖入 `Applications`。若首次打开提示「无法验证开发者 / 已损坏」，可在「访达 → 应用程序」中**右键 `Paw.app` → 打开**，或在终端执行：`xattr -cr /Applications/Paw.app`。');
lines.push('- **Windows (x64)**：双击 `Setup.exe` 按向导安装（默认装到当前用户目录，无需管理员权限）。若弹出 SmartScreen 蓝窗，点击 **更多信息 → 仍要运行** 即可。');
lines.push('- **数据与升级**：网关配置（`gateway-config.json`）、会话数据库、技能（`~/.paw/skill`）与外置插件（`~/.paw/plugins`）均独立存放在 `~/.paw/` 目录，覆盖安装升级不会丢失数据。');
lines.push('');

if (prevTag && tag) {
  lines.push(`**Full Changelog**: https://github.com/${repo}/compare/${prevTag}...${tag}`);
}

writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`✓ 已生成 Release Notes（${prevTag || '初始提交'}..${tag || 'HEAD'}）：${outPath}`);
