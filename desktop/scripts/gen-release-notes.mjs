// 生成 GitHub Release 正文（Markdown）：
// - 优先提取 CHANGELOG.md 对应版本章节；
// - 附带上一个 v* tag 以来的提交记录与对比链接；
// - 自动列出产物大小、SHA-256 校验值，以及 macOS / Windows 首次安装指引。
//
// 用法：node desktop/scripts/gen-release-notes.mjs --tag v1.0.0-rc.2 --artifacts dist-artifacts --out release-notes.md
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const tag = arg('tag') || '';
const version = tag.replace(/^v/i, '');
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

// 1. 提取 CHANGELOG.md 中对应版本的章节（如 ## [1.0.0-rc.2] ...）
function extractChangelog(ver) {
  if (!ver || !existsSync('CHANGELOG.md')) return '';
  const text = readFileSync('CHANGELOG.md', 'utf8');
  const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1].replace(/\n---\s*$/, '').trim() : '';
}

// 2. 查找上一个 v* tag（排除当前 tag 本身）
function findPrevTag(currentTag) {
  const tags = git(['tag', '--list', 'v*', '--sort=-creatordate'])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== currentTag);
  return tags[0] || '';
}

// 3. 收集产物信息（文件名、平台说明、大小、SHA-256）
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

const changelogSection = extractChangelog(version);
const prevTag = findPrevTag(tag);
const logArgs = prevTag
  ? ['log', `${prevTag}..HEAD`, '--no-merges', '--pretty=format:- %s (`%h`)']
  : ['log', '-n', '20', '--no-merges', '--pretty=format:- %s (`%h`)'];
const commits = git(logArgs)
  .split(/\r?\n/)
  .filter(Boolean);
const artifacts = collectArtifacts(artifactsDir);

const lines = [];

if (changelogSection) {
  lines.push(changelogSection);
  lines.push('');
}

if (commits.length > 0) {
  lines.push(changelogSection ? '<details>\n<summary>完整提交记录</summary>\n' : '### 提交记录\n');
  lines.push(...commits);
  if (changelogSection) lines.push('\n</details>');
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
console.log(`✓ 已生成 Release Notes：${outPath}`);
