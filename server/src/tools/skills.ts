// create_skill：把一套可复用的流程沉淀成技能（写到 ~/.paw/skill/<name>/SKILL.md）。
//
// 对标 skill-cli 的 `init` + `lint`，以及 WorkBuddy 的 skill-creator：
// 重点是**告诉模型什么时候该建技能、描述该怎么写**——技能能不能被正确触发，
// 全靠 description 那一句；正文反而没那么难写。
import type { ToolSchema } from '@paw/shared';
import { createSkill } from '../skills.js';

export const SKILL_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'create_skill',
    description: [
      'Save a reusable procedure as a skill under ~/.paw/skill, so future conversations can load and follow it.',
      '',
      'When to use:',
      '- The user says "save this as a skill" / "把这套流程存成技能" / "下次也这么做"',
      '- You just worked out a repeatable procedure with concrete commands, paths, API calls or pitfalls',
      '- Do NOT use it for one-off answers or for things already covered by an existing skill',
      '',
      'How to write it:',
      '- name: short slug, e.g. `pdf-ocr`, `work-report`. Chinese is fine.',
      '- description: **when to trigger it** — the situation and the words the user would say. It is the only line shown in the skill list, keep it under 120 chars. Bad: "一个处理PDF的技能". Good: "扫描版 PDF 需要 OCR 提取文字时使用，支持中文、保留版面"',
      '- content: markdown, step by step, concrete commands instead of prose. Include the pitfalls you actually hit and the checks that prove it worked.',
      '- files: optional supporting files (`scripts/run.py`, `references/api.md`). Reference them from content by relative path so the model knows when to open them.',
      '',
      'Overwriting an existing skill requires overwrite: true. New skills show up in the skill list on the next turn.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能标识/目录名，如 pdf-ocr、work-report（中文也可以）' },
        description: { type: 'string', description: '什么时候该用这个技能：触发场景 + 用户会说的关键词。清单里只显示这一句，120 字以内' },
        content: { type: 'string', description: 'SKILL.md 正文（markdown，不含 frontmatter）：步骤、命令、坑、验收方式' },
        files: {
          type: 'array',
          description: '可选附加文件（脚本 / 参考资料），路径必须是技能目录下的相对路径',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对路径，如 scripts/run.py' },
              content: { type: 'string', description: '文件内容' },
            },
            required: ['path', 'content'],
          },
        },
        overwrite: { type: 'boolean', description: '技能已存在时是否覆盖（默认 false，会报错并提示）' },
        summary: { type: 'string', description: '用简体中文简述要沉淀什么，20字以内' },
      },
      required: ['name', 'description', 'content'],
    },
  },
];

export async function executeSkillTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'create_skill') throw new Error(`Unknown skill tool: ${name}`);

  const files = Array.isArray(args.files)
    ? (args.files as { path?: unknown; content?: unknown }[])
      .filter((f) => typeof f?.path === 'string')
      .map((f) => ({ path: String(f.path), content: String(f.content ?? '') }))
    : undefined;

  const r = await createSkill({
    name: String(args.name ?? ''),
    description: String(args.description ?? ''),
    content: String(args.content ?? ''),
    files,
    overwrite: args.overwrite === true,
  });

  const lines = [
    `已创建技能 ${r.id}`,
    `  目录：${r.dir}`,
    `  文件：${r.written.join('、')}`,
  ];
  if (r.warnings.length) lines.push('', '⚠️ 建议改一下：', ...r.warnings.map((w) => `- ${w}`));
  lines.push('', '下一轮对话起，它会出现在技能清单里（用户也能在「技能」页看到）。');
  return lines.join('\n');
}

