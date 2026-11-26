// 人设注入：照抄 WorkBuddy 的 user-context-identity.tpl 机制。
// 关键：XML 标签分块 + 正面「embody」指令 + 人设当上下文资料而非硬命令。
// 带 mtime 缓存——改了人设文件不用重启 server，下一条请求自动生效。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '@paw/shared';
import { DATA_DIR } from './paths.js';
import { loadSkillsBlock } from './skills.js';
import { loadWorkspaceBlock } from './workspace.js';
import { loadSubagentsBlock } from './agent/agents.js';
import { loadMemoryIndex } from './tools/memory.js';

const PERSONA_DIR = path.join(DATA_DIR, 'persona');
const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const;

let filesCache: { mtime: number; text: string } | null = null;

/** 读一份人设文件，去 YAML frontmatter */
async function readPersonaFile(name: string): Promise<string | null> {
  try {
    let text = await readFile(path.join(PERSONA_DIR, name), 'utf-8');
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end >= 0) text = text.slice(end + 4).trimStart();
    }
    return text.trim();
  } catch {
    return null;
  }
}

/** 读全部人设文件。mtime 门控：指纹没变不重读正文；文件缺失不阻塞主流程 */
async function readPersonaFiles(): Promise<{ mtime: number; files: string }> {
  let latest = 0;
  for (const f of FILES) {
    try {
      latest = Math.max(latest, (await stat(path.join(PERSONA_DIR, f))).mtimeMs);
    } catch { /* 缺文件 */ }
  }
  if (filesCache && filesCache.mtime === latest) return { mtime: latest, files: filesCache.text };

  const contents: string[] = [];
  for (const f of FILES) {
    const text = await readPersonaFile(f);
    if (text) contents.push(`## ${f}\n${text}`);
  }
  const files = contents.join('\n\n');
  filesCache = { mtime: latest, text: files };
  return { mtime: latest, files };
}

/** 证据纪律：独立于 SOUL.md，换人设也生效。专治「没干说干完、被抓包后道歉表演」。 */
const EVIDENCE_RULES = [
  '<evidence_discipline priority="highest">',
  '1. 说「已完成 / 搞定 / 下载好了 / 改好了 / 查清楚了」之前，当前轮必须已有对应的工具结果；有副作用的动作还要再做一次独立验证（读回文件、查数量、查状态、看退出码）。没有证据就只说「还没验证」或「未执行」，并写明下一步。',
  '2. 区分三种状态：「已执行且有结果」「已执行但尚未验证」「未执行」。不要把它们混成一句「已处理」。后台任务只说「已启动 / 仍在运行 / 已失败」，拿到终态前不许说完成。',
  '3. 报告事实用可核对的量：成功数、失败数、文件路径、字节数、状态码、退出码。没有这些就不要下结论，也不要把计划、猜测或上轮结果当成本轮结果。',
  '4. 禁止表演式回填：不要说「抱歉我刚才」「糟糕」「这次是真的查了」「我错了」来替代事实。发现前面说错，直接给更正后的状态和证据。',
  '5. 用户质疑结果时，先重新验证再回答；不要用更肯定的语气重复没有依据的结论。',
  '</evidence_discipline>',
].join('\n');

/** 执行手册：教模型怎么选工具、怎么失败、怎么收尾；独立于人设文件。 */
const EXECUTION_PLAYBOOK = [
  '<execution_playbook>',
  '1. 先判断任务类型：只回答 / 查证 / 改代码 / 跑长任务。多步任务先 todo_write 建清单，再按阶段推进；不要一边做一边临时想下一步。',
  '2. 文件探查优先 list_dir、search_file、search_content、read_file；run_command 只用于真正的 shell 命令。不要用 ls/find/grep/cat 代替专用工具。',
  '3. 多行脚本不要硬塞进 run_command 的引号：用 write_file 落一个临时脚本再执行；失败时改一处重跑，别每轮重写整段。',
  '4. 同一工具 + 同一参数失败一次后不要原样重试：先读错误，检查 schema、路径、字段名、版本；换参数或换路。',
  '5. 预期超过 30 秒的批处理命令用 background=true + get_terminal_output(wait_seconds) 等结果，不要在命令行里 sleep 轮询；需要跨轮常驻的服务（本地 HTTP/RAG/dev server）用 daemon=true 启动、用 kill_job 停止，不要在前台命令里写 nohup ... &。',
  '6. 停进程安全铁律：停自己起的服务优先用 list_jobs + kill_job；若必须按端口查监听进程，lsof 必须带 `-sTCP:LISTEN` 并先 `ps -p <pid> -o command=` 核对命令行，严禁对 `lsof -ti:<port>` 直接 kill（会把建立 ESTABLISHED 连接的客户端业务进程一并误杀）。',
  '7. 改代码：read_file 拿最新内容 → 小步 edit_file → 读回或 git_diff 验证；不要整文件重写。',
  '8. 独立只读操作同一轮并行发；同一文件不要反复读；已确认的事实（文件路径、job_id、端口、DTO 字段）写进 todo 或回复，不要反复查。',
  '9. 连续 3 次没有推进就停下来重定计划：换工具、缩小范围，或把大任务拆给 subagent；不要用更多相同的调用硬顶。',
  '10. 收尾前做一次验证（测试/构建/读回/计数）；没有验证就写“未验证”，不要用语气代替证据。',
  '11. 消息里的 @"..." 引用是附件在本机的真实路径。图片要用画面内容时调用 read_image 读那个路径；本轮消息里的 @image#N 同时对应请求里的第 N 张图。看不到画面就不要凭用户的转述说“和截图一致”。',
  '12. 在正在提供服务的环境上做会改变运行状态的操作（切节点、重启服务、批量探测、改线上配置）之前，先说明影响并征得用户同意；批量脚本必须给每一步设超时、用 try/finally 恢复现场，并先拿 1-2 个样本试跑，确认无损再全量。',
  '</execution_playbook>',
].join('\n');

/**
 * 拼人设 prompt——照 WorkBuddy 实测成功的那条 system 的做法：
 * - 人设文件**直接平铺**进 system（不包 XML 标签、不当"上下文资料"）
 * - **绝不提 Qwen/DeepSeek 等模型名**——提到就激活模型自身身份防御，反而答"我是Qwen"
 * - 只靠一句"称呼我小爪子" + 人设内容本身，像 WorkBuddy 的"称呼我小尾巴"那样
 *
 * 不再缓存整条 prompt：技能块/工作区块各自按 mtime 缓存，这里只是拼字符串。
 * （原来的缓存键混入 block 长度，同长度内容变更会用旧 prompt。）
 */
export async function loadPersonaPrompt(workspace?: string | null): Promise<string> {
  const [skillsBlock, workspaceBlock, subagentsBlock, personaFiles] = await Promise.all([
    loadSkillsBlock(),
    loadWorkspaceBlock(workspace),
    loadSubagentsBlock(workspace),
    readPersonaFiles(),
  ]);
  const memoryBlock = loadMemoryIndex(workspace);

  const identitySection = personaFiles.files ? [
    '称呼我「小爪子」。',
    '<identity_context>',
    'The following identity files are included in the Project Context for this turn.',
    'Use them directly as context.',
    '',
    'If SOUL.md is present, embody its persona and tone.',
    'Stay consistent with the latest injected identity and user profile.',
    'If you change SOUL.md, tell the user.',
    '',
    'Injected workspace identity files:',
    '',
    personaFiles.files,
    '</identity_context>',
    '',
  ] : [];

  // 照 WorkBuddy 实测格式：identity_context 放在 user 消息的 system-reminder 里
  const prompt = [
    '<system-reminder data-role="user-context">',
    ...identitySection,
    EVIDENCE_RULES,
    '',
    EXECUTION_PLAYBOOK,
    ...(workspaceBlock ? ['', workspaceBlock] : []),
    ...(skillsBlock ? ['', skillsBlock] : []),
    ...(subagentsBlock ? ['', subagentsBlock] : []),
    ...(memoryBlock ? ['', memoryBlock] : []),
    '</system-reminder>',
  ].join('\n');
  return prompt;
}

/** 把身份上下文注入到第一条 user 消息前面（WorkBuddy 做法：user 消息里的 system-reminder） */
export function withPersona(messages: ChatMessage[], prompt: string): ChatMessage[] {
  if (messages.some((m) => typeof m.content === 'string' && m.content.includes('<system-reminder data-role="user-context">'))) return messages; // 幂等
  if (!prompt) return messages;
  const idx = messages.findIndex((m) => m.role === 'user');
  if (idx < 0) return messages;
  const out = [...messages];
  out[idx] = { ...out[idx], content: prompt + '\n' + out[idx].content };
  return out;
}
