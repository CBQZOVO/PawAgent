// 子代理定义加载器：markdown + YAML frontmatter。
// 按传入目录列表顺序加载，后者同名覆盖前者，mtime 门控缓存。
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface SubagentDef {
  name: string;
  description: string;
  /** 工具白名单（硬边界）；永远剔除 subagent 防递归 */
  tools: string[];
  model?: string;          // 'inherit'/缺省 = 跟主代理同模型
  maxRounds?: number;      // 可选：仅 frontmatter 显式配置时生效
  enabled: boolean;
  /** 子代理自己的 system prompt（frontmatter 之后的正文） */
  prompt: string;
  file: string;
}

const cache = new Map<string, { key: string; defs: SubagentDef[] }>();

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

async function loadDir(dir: string): Promise<{ file: string; mtime: number; text: string }[]> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md')); }
  catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const file = path.join(dir, n);
    try {
      const s = await stat(file);
      out.push({ file, mtime: s.mtimeMs, text: await readFile(file, 'utf-8') });
    } catch { /* skip */ }
  }
  return out;
}

/** 从有序目录列表加载子代理定义（同名后覆盖前） */
export async function loadSubagentsFromDirs(dirs: string[]): Promise<SubagentDef[]> {
  const cacheBucket = dirs.join('\0');
  const loaded = await Promise.all(dirs.map(loadDir));
  const all = loaded.flat();
  const key = all.map((f) => `${f.file}:${f.mtime}`).join('|');
  const hit = cache.get(cacheBucket);
  if (hit && hit.key === key) return hit.defs;

  const byName = new Map<string, SubagentDef>();
  for (const f of all) {
    const { meta, body } = parseFrontmatter(f.text);
    const name = meta.name || path.basename(f.file, '.md');
    const tools = (meta.tools || '').split(',').map((t) => t.trim())
      .filter((t) => t && t !== 'subagent');
    byName.set(name, {
      name,
      description: meta.description || '',
      tools,
      model: meta.model && meta.model !== 'inherit' ? meta.model : undefined,
      maxRounds: Number(meta.maxRounds) > 0 ? Number(meta.maxRounds) : undefined,
      enabled: meta.enabled !== 'false',
      prompt: body,
      file: f.file,
    });
  }
  const defs = [...byName.values()].filter((d) => d.enabled);
  cache.set(cacheBucket, { key, defs });
  return defs;
}

/** 格式化父代理 system prompt 里的 <available_subagents> 块 */
export function formatSubagentsBlock(defs: SubagentDef[]): string {
  if (!defs.length) return '';
  const lines = defs.map((d) => `- ${d.name}：${d.description}`);
  return [
    '<available_subagents>',
    '子代理 = 独立上下文的工人：自己读文件、自己搜索，跑完只把结论交回来给你（不占你的上下文）。',
    '用 `subagent` 工具派活，可用：',
    ...lines,
    '',
    '**什么时候值得派**：',
    '- 探查范围大到你自己读会把上下文撑爆（陌生代码库、多个模块一起摸）',
    '- 几个互相独立的探查方向，可以一轮里同时派出去并行跑（最多 4 个）',
    '- 你只需要结论，不需要逐字看全文',
    '',
    '**什么时候自己来**：读一两个已知文件、找某个符号在哪、改一处代码、跑一条命令。',
    '判断不清就自己读——派活的价值是隔离上下文，不是省你的事。',
    '',
    '调用要点：',
    '- 任务描述必须自包含（子代理看不到当前对话）：查什么、在哪个目录、交付什么、已知线索。',
    '- 同一轮可以发多个 subagent 调用，并行执行（最多 4 个）——互相独立的探查点一次发完，别串行等。',
    '- thoroughness 仅用于向子代理传达探查深度偏好（quick / medium / very thorough），不设硬性轮次截断，子代理会查清所有问题再交付。',
    '- 需要机器可读的产出时传 output_schema（JSON Schema），子代理会用 structured_output 提交合格 JSON。',
    '- 它回的是结论 + 证据（绝对路径、行号），综合分析和最终判断你自己做——不要把"怎么解读"也外包出去。',
    '</available_subagents>',
  ].join('\n');
}
