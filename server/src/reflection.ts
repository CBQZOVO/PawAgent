// 每轮对话收尾的「复盘」：异步调一次模型，把本轮提炼成一条工作日志 +（可选）一条记忆。
// 对标 title.ts 的模式：第二次模型调用、跟主对话完全独立、失败只打日志不影响使用。
// 指令放 user 消息里（网关模型对 system 角色遵循度差，title.ts 2026-11-23 实测结论）。
import { streamChat, type GatewayConfig } from './gateway/client.js';
import { isImageModel } from './tools/image-gen.js';
import { findMemoryByTitle, loadMemoryIndex, upsertMemoryDirect } from './tools/memory.js';
import { insertWorkLog } from './tools/worklog.js';

const PROMPT_TEMPLATE = `下面是一轮人机对话的记录。请判断是否值得写入「长期记忆」和「当日工作日志」，只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"memory": {"title": "...", "content": "...", "tags": "逗号分隔", "scope": "project 或 global"} 或 null, "worklog": {"title": "...", "content": "..."} 或 null}

规则：
- memory：只记跨会话有用的事实——用户偏好、项目结构/环境事实、重要决策、踩坑教训。寒暄、闲聊、一次性临时查询不要记。已有记忆索引里已经覆盖的内容不要重复记（除非有实质更新，那就用新内容覆盖要点并保持 title 一致）。
- worklog：这轮做了实际工作（写代码、改配置、排查问题、跑任务、整理文档等）才记，title 不超过 16 个字；content 用 2-4 句话概括做了什么、结果如何，提到关键文件/组件名。纯寒暄或没有任何产出的短对话返回 null。报工时按天汇总这些日志，所以 content 要独立可读。
- scope=project 的记忆归到当前项目，scope=global 表示跨项目通用（如用户个人偏好）。

已有记忆索引（title 列表）：
{memory_index}

用户消息：
{user}

本轮工作要点（用到的工具，无则省略）：{tools}

助手回复（节选）：
{assistant}

JSON：`;

interface ReflectResult {
  memory?: { title?: string; content?: string; tags?: string; scope?: string } | null;
  worklog?: { title?: string; content?: string } | null;
}

/** 容错解析：剥 markdown 代码围栏 + 截第一个 { 到最后一个 } */
function parseJsonLoose(text: string): ReflectResult | null {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as ReflectResult; } catch { return null; }
}

// ---------- 复盘模型选择：倍率最低的对话模型 ----------
// 网关 /v1/models 的每个模型带 rate_multiplier（渠道倍率，null=未设置）。
// 拉不到 / 全没配倍率 → 回退默认模型。缓存 10 分钟，别每轮都拉一次列表。

let cheapCache: { model: string; at: number } | null = null;
const CHEAP_TTL_MS = 10 * 60 * 1000;

async function pickCheapestChatModel(cfg: GatewayConfig): Promise<string> {
  if (cheapCache && Date.now() - cheapCache.at < CHEAP_TTL_MS) return cheapCache.model;
  const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/models', {
    headers: { Authorization: 'Bearer ' + cfg.apiKey, 'User-Agent': 'Paw/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`gateway HTTP ${r.status}`);
  const d = await r.json() as { data?: Array<{ id: string; owned_by?: string; rate_multiplier?: number | null }> };
  const candidates = (d.data || []).filter((m) =>
    typeof m.rate_multiplier === 'number' && !isImageModel(m.id) && m.owned_by !== 'Image');
  if (!candidates.length) throw new Error('没有带倍率的对话模型');
  const best = candidates.reduce((a, b) => (b.rate_multiplier as number) < (a.rate_multiplier as number) ? b : a);
  cheapCache = { model: best.id, at: Date.now() };
  return best.id;
}

export interface TurnRecord {
  workspace: string | null;
  sessionId?: string;
  turnId?: string;
  userText: string;
  assistantText: string;
  toolNames: string[];
}

/** 提炼并落库。30 秒超时；任何失败只 console.warn，绝不影响主对话。 */
export async function reflectTurn(cfg: GatewayConfig, turn: TurnRecord): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const prompt = PROMPT_TEMPLATE
      .replace('{memory_index}', loadMemoryIndex(turn.workspace) || '（暂无）')
      .replace('{user}', turn.userText.slice(0, 3000))
      .replace('{tools}', turn.toolNames.slice(0, 30).join('、') || '（无）')
      .replace('{assistant}', turn.assistantText.slice(0, 3000) || '（无文本回复）');
    const runStream = (model: string) =>
      streamChat({ ...cfg, model }, [{ role: 'user', content: prompt }], [], undefined, ctrl.signal);
    let out = '';
    try {
      // 优先用倍率最低的模型；模型列表拉不到就回退默认
      const model = await pickCheapestChatModel(cfg).catch(() => cfg.model);
      for await (const d of runStream(model)) {
        if (d.content) out += d.content;
      }
    } catch (e) {
      // 便宜模型流失败（免费/低价渠道偶尔抽风）→ 用默认模型重试一次
      if (ctrl.signal.aborted) throw e;
      console.warn('[reflect] 低价模型调用失败，回退默认模型重试:', (e as Error).message);
      out = '';
      for await (const d of runStream(cfg.model)) {
        if (d.content) out += d.content;
      }
    }
    const r = parseJsonLoose(out);
    if (!r) return; // 模型没给出合法 JSON，放弃（日志工具可以有，但不强求）
    if (r.worklog && r.worklog.title?.trim() && r.worklog.content?.trim()) {
      insertWorkLog({
        workspace: turn.workspace, sessionId: turn.sessionId,
        title: r.worklog.title.trim(), content: r.worklog.content.trim(),
      });
    }
    if (r.memory && r.memory.title?.trim() && r.memory.content?.trim()) {
      const title = r.memory.title.trim();
      const content = r.memory.content.trim();
      const tags = (r.memory.tags || '').trim();
      const ws = r.memory.scope === 'global' ? '' : (turn.workspace || '');
      // 无人值守复盘不阻断：同名同内容跳过，同名不同内容原地更新并刷新来源
      const existing = findMemoryByTitle(title, ws);
      if (!existing || existing.content !== content) {
        upsertMemoryDirect({
          ...(existing ? { id: existing.id } : {}),
          title, content, tags, workspace: ws,
          sourceSessionId: turn.sessionId,
          sourceTurnId: turn.turnId,
        });
      }
    }
  } catch (e) {
    console.warn('[reflect] 本轮复盘失败（不影响对话）:', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
