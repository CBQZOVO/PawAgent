// 技能多目录加载测试：全局 ~/.paw/skill、工作区 .agents/skills、.paw/skills 优先级与缓存。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0;
let total = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
  total++;
  try { await fn(); pass++; console.log('✓', label); }
  catch (e) { console.error('✗', label, '\n  ', (e as Error).message); process.exitCode = 1; }
};

const root = await mkdtemp(path.join(tmpdir(), 'paw-skills-test-'));
const globalDir = path.join(root, 'global-skills');
const wsA = path.join(root, 'ws-a');
const wsB = path.join(root, 'ws-b');

process.env.PAW_SKILLS_DIR = globalDir;
const { loadSkills, loadSkillContent, loadSkillsBlock } = await import('../src/skills.js');

const writeSkill = async (base: string, id: string, name: string, desc: string, body: string) => {
  const dir = path.join(base, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`,
    'utf-8',
  );
};

try {
  await writeSkill(globalDir, 'global-only', 'global-only', '全局技能', '# Global\nfrom global');
  await writeSkill(globalDir, 'shared-skill', 'shared-global', '全局版本', 'body-global');

  await writeSkill(path.join(wsA, '.agents/skills'), 'openspec-propose', 'openspec-propose', 'OpenSpec 提案流程', '# Propose\nstep 1');
  await writeSkill(path.join(wsA, '.agents/skills'), 'shared-skill', 'shared-agents', '项目 .agents 版本', 'body-agents');
  await writeSkill(path.join(wsA, '.paw/skills'), 'shared-skill', 'shared-paw', '项目 .paw 覆盖版本', 'body-paw');

  await mkdir(wsB, { recursive: true });

  await test('workspace=null 时只加载全局技能', async () => {
    const list = await loadSkills(null);
    assert.deepEqual(list.map((s) => s.dir).sort(), ['global-only', 'shared-skill']);
    assert.ok(list.every((s) => s.source === 'user'));
    assert.equal(await loadSkillContent('openspec-propose', null), null);
    assert.equal(await loadSkillContent('shared-skill', null), 'body-global');
  });

  await test('工作区加载 .agents/skills 且优先级 .paw/skills > .agents/skills > 全局', async () => {
    const list = await loadSkills(wsA);
    const byId = new Map(list.map((s) => [s.dir, s]));
    assert.equal(byId.size, 3);
    assert.equal(byId.get('global-only')?.source, 'user');
    assert.equal(byId.get('openspec-propose')?.source, 'workspace');
    assert.equal(byId.get('shared-skill')?.source, 'workspace');
    assert.equal(byId.get('shared-skill')?.name, 'shared-paw');

    assert.equal(await loadSkillContent('openspec-propose', wsA), '# Propose\nstep 1');
    assert.equal(await loadSkillContent('shared-skill', wsA), 'body-paw');
  });

  await test('切到无技能工作区后缓存隔离，不串用旧工作区技能', async () => {
    const listB = await loadSkills(wsB);
    assert.deepEqual(listB.map((s) => s.dir).sort(), ['global-only', 'shared-skill']);
    assert.equal(await loadSkillContent('openspec-propose', wsB), null);
    assert.equal(await loadSkillContent('shared-skill', wsB), 'body-global');
  });

  await test('loadSkillsBlock 正确包含工作区技能', async () => {
    const blockA = await loadSkillsBlock(wsA);
    assert.ok(blockA.includes('openspec-propose'));
    assert.ok(blockA.includes('shared-paw'));
    const blockB = await loadSkillsBlock(wsB);
    assert.ok(!blockB.includes('openspec-propose'));
  });

  await test('修改非最新 SKILL.md 时缓存指纹也能即时感知并刷新描述', async () => {
    // 新增一个更新时间戳的无关技能作为最高 mtime 干扰项，再修改较早的 global-only
    await writeSkill(globalDir, 'zzz-newer', 'zzz-newer', '最新干扰项', '# Z');
    await loadSkills(wsA);
    await new Promise((r) => setTimeout(r, 15));
    await writeSkill(globalDir, 'zzz-newer', 'zzz-newer', '最新干扰项2', '# Z2');
    // 修改 global-only 但手动把它的或者在有多个文件情况下验证改任意一项即刷新
    await writeSkill(globalDir, 'global-only', 'global-only-v2', '更新后的全局技能描述', '# Global v2');
    const updated = await loadSkills(wsA);
    assert.equal(updated.find((s) => s.dir === 'global-only')?.name, 'global-only-v2');
    assert.equal(updated.find((s) => s.dir === 'global-only')?.description, '更新后的全局技能描述');
  });

  await test('删除工作区 SKILL.md 后缓存立即失效', async () => {
    await rm(path.join(wsA, '.agents/skills/openspec-propose/SKILL.md'));
    const list = await loadSkills(wsA);
    assert.ok(!list.some((s) => s.dir === 'openspec-propose'));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\nskills.test: ${pass}/${total} passed`);
