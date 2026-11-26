// Skill 接入：扫描用户级 ~/.paw/skill/*/SKILL.md（可通过 PAW_SKILLS_DIR 覆盖），
// 解析 frontmatter 的 name/description，把清单注入 user-context。
// 模型要用某个 skill 时，用内置 read_file 工具读它的 SKILL.md 全文照做。
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

// Paw 专用技能目录（放在 ~/.paw/skill，重装不丢；结构：每个子目录一个 SKILL.md）
// PAW_SKILLS_DIR 可覆盖（测试用临时目录，别往真技能目录里写垃圾）
export const SKILLS_DIR = process.env.PAW_SKILLS_DIR
  ? path.resolve(process.env.PAW_SKILLS_DIR)
  : path.join(DATA_DIR, 'skill');
let listCache: { mtime: number; skills: SkillInfo[] } | null = null;
let blockCache: { mtime: number; block: string } | null = null;

interface SkillInfo { dir: string; name: string; description: string; file: string }

/** 解析 SKILL.md 的 YAML frontmatter（只要 name/description 两个简单字段） */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^(name|description):\s*(.+)$/);
    if (m) out[m[1] as 'name' | 'description'] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** 扫描 skills 目录，返回技能清单。
 *  mtime 门控缓存：每次先 stat 各 SKILL.md 求指纹（便宜），指纹没变不重读正文；改动即时生效。 */
export async function loadSkills(): Promise<SkillInfo[]> {
  let dirs: string[];
  let latest = 0;
  try {
    dirs = await readdir(SKILLS_DIR);
    latest = (await stat(SKILLS_DIR)).mtimeMs;
  } catch {
    return [];
  }
  const found: { dir: string; file: string; mtimeMs: number }[] = [];
  for (const d of dirs) {
    const file = path.join(SKILLS_DIR, d, 'SKILL.md');
    try {
      found.push({ dir: d, file, mtimeMs: (await stat(file)).mtimeMs });
    } catch { /* 没有 SKILL.md 就跳过 */ }
  }
  for (const f of found) latest = Math.max(latest, f.mtimeMs);
  if (listCache && listCache.mtime === latest) return listCache.skills;

  const skills: SkillInfo[] = [];
  for (const f of found) {
    try {
      const text = await readFile(f.file, 'utf-8');
      const fm = parseFrontmatter(text);
      skills.push({
        dir: f.dir,
        name: fm.name || f.dir,
        description: (fm.description || '').slice(0, 200),
        file: f.file,
      });
    } catch { /* 读失败就跳过 */ }
  }
  listCache = { mtime: latest, skills };
  return skills;
}

/** 读指定 skill 的 SKILL.md 全文（去掉 frontmatter），用于用户选中后注入 */
export async function loadSkillContent(id: string): Promise<string | null> {
  // id 是目录名，防路径穿越：不允许斜杠和 ..，其余（含中文）都可以
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(id) || id.includes('..')) return null;
  try {
    let text = await readFile(path.join(SKILLS_DIR, id, 'SKILL.md'), 'utf-8');
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end >= 0) text = text.slice(end + 4).trimStart();
    }
    return text.trim();
  } catch {
    return null;
  }
}

/** 生成注入到 user-context 的 <available_skills> 块（复用清单缓存的 mtime 指纹） */
export async function loadSkillsBlock(): Promise<string> {
  const skills = await loadSkills();
  if (!skills.length) return '';
  const mtime = listCache?.mtime ?? 0;
  if (blockCache && blockCache.mtime === mtime) return blockCache.block;

  const lines = skills.map((s) =>
    `- **${s.name}**: ${s.description || '（无描述）'} [读 ${s.file} 获取完整指令]`
  );
  const block = [
    '<available_skills>',
    'The following skills are available. When a task matches a skill, use read_file to load its SKILL.md and follow it.',
    ...lines,
    '</available_skills>',
  ].join('\n');
  blockCache = { mtime, block };
  return block;
}

// ---------------------------------------------------------------- 创建（skill creator）
//
// 技能目录规范：
//   - 扁平布局 <skill>/SKILL.md，frontmatter 包含 id / name / description / version
//   - 可选 references/ scripts/ assets/ 目录，自动作为附带资源
//   - 内置 lint 规则：name / version 必填为 error，description 为空为 warning

export interface SkillFile { path: string; content: string }

export interface SkillDraft {
  name: string;
  description: string;
  content: string;
  /** 附加文件，路径相对于技能目录（references/xxx.md、scripts/run.py） */
  files?: SkillFile[];
  /** 已存在时是否覆盖 */
  overwrite?: boolean;
}

export interface SkillWriteResult {
  id: string;
  dir: string;
  file: string;
  written: string[];
  warnings: string[];
}

/**
 * 目录名清洗：允许中文（技能名经常是中文），把空格和标点换成短横线。
 * 不允许 `/`、`\`、`..`、以 `.` 开头——这些要么能跳目录，要么会被当成隐藏目录。
 */
function slugifySkill(name: string): string {
  const raw = String(name ?? '').trim();
  // 含斜杠或 .. 直接拒绝，不要静默清洗成另一个名字——否则 ../evil 会变成 evil，
  // 用户和模型都以为自己写的是别的东西
  if (/[\\/]/.test(raw) || raw.includes('..')) throw new Error(`技能名不能包含斜杠或 ..：${raw}`);
  const s = raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!s) throw new Error('技能名不能为空（或全是符号）');
  if (s.length > 60) throw new Error('技能名太长了（最多 60 个字符）');
  return s;
}

/** 附加文件路径校验：只能是技能目录下的相对路径 */
function safeRelPath(p: string): string {
  const raw = String(p ?? '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error('文件路径不能为空');
  if (raw.startsWith('/') || /^[a-z]+:/i.test(raw)) throw new Error(`文件路径必须是相对路径：${p}`);
  const parts = raw.split('/');
  if (parts.some((x) => x === '..' || x === '.' || x === '')) throw new Error(`文件路径不合法：${p}`);
  return raw;
}

/** YAML 标量：用 JSON 双引号形式，冒号/换行/引号都不会把 frontmatter 弄坏 */
const yamlStr = (s: string) => JSON.stringify(String(s));

/**
 * 创建（或覆盖）一个技能。返回写入结果 + lint 警告。
 * 有 error 时直接抛，让模型看到原因去改；warning 不阻塞，随结果回给模型。
 */
export async function createSkill(draft: SkillDraft): Promise<SkillWriteResult> {
  const id = slugifySkill(draft.name);
  const description = String(draft.description ?? '').trim();
  let content = String(draft.content ?? '').trim();

  // 模型经常把整份 SKILL.md（连 frontmatter）当正文传进来，拼起来就变成两个 --- 块。
  // 直接剥掉它自带的那层，并提醒一句（不静默吞掉，否则它下次还这么写）。
  let strippedFrontmatter = false;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end >= 0) {
      content = content.slice(end + 4).trim();
      strippedFrontmatter = true;
    }
  }

  // 这三条对应 skill-cli linter.go 的 error 级：缺了技能就跑不起来
  if (!description) throw new Error('description 不能为空——它是模型判断"什么时候该用这个技能"的唯一依据');
  if (!content) throw new Error('content 不能为空——SKILL.md 的正文就是技能本身');

  const dir = path.join(SKILLS_DIR, id);
  const file = path.join(dir, 'SKILL.md');

  const exists = await stat(file).then(() => true).catch(() => false);
  if (exists && !draft.overwrite) {
    throw new Error(`技能 ${id} 已存在（${file}）。确认要替换就传 overwrite: true`);
  }

  const files = (draft.files || []).map((f) => ({ path: safeRelPath(f.path), content: String(f.content ?? '') }));

  const warnings: string[] = [];
  if (strippedFrontmatter) warnings.push('正文里自带了 frontmatter，已自动剥掉（content 只写正文即可）');
  if (description.length > 120) {
    warnings.push(`description 有 ${description.length} 字，清单里会截断到 200 字，建议压到 120 字以内`);
  }
  if (!/^#\s/m.test(content)) warnings.push('正文没有一级标题（# xxx），读起来会缺个开头');
  if (files.length && !files.some((f) => content.includes(f.path))) {
    warnings.push('附加文件没有在正文里被引用（用相对路径写进去，模型才知道什么时候去读它）');
  }

  const frontmatter = [
    '---',
    `id: ${id}`,
    `name: ${id}`,
    `description: ${yamlStr(description)}`,
    'version: 1.0.0',
    'agent_created: true',
    '---',
    '',
    content,
    '',
  ].join('\n');

  await mkdir(dir, { recursive: true });
  await writeFile(file, frontmatter, 'utf-8');
  for (const f of files) {
    const abs = path.join(dir, f.path);
    // 再兜一层：join 之后必须还在技能目录里（防止 .. 之类绕过前面的检查）
    if (!abs.startsWith(dir + path.sep)) throw new Error(`文件路径越出技能目录：${f.path}`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf-8');
  }

  // 写完立刻读一遍：frontmatter 都能解析出来才算成功（防止引号之类的坑）
  const parsed = parseFrontmatter(await readFile(file, 'utf-8'));
  if (!parsed.name || !parsed.description) {
    throw new Error('写入后的 SKILL.md frontmatter 解析失败，请检查 description 里是否有多余的 ---');
  }

  return { id, dir, file, written: ['SKILL.md', ...files.map((f) => f.path)], warnings };
}
