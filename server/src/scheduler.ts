// 定时任务调度器：分钟级轮询 + 5 段 cron 匹配（零依赖）。
// 到点用 runAgent 执行（与聊天页同一套工具能力），结果写 task_runs 并生成任务会话，
// 会话与运行记录用同一个 runId 关联——运行记录点击直达这次执行。
import { canSeeImages, type ScheduledTask, type ViewMessage } from '@paw/shared';
import { addRun, listTasks, touchTask, upsertSession } from './db.js';
import type { GatewayConfig } from './gateway/client.js';
import { runAgent } from './agent/loop.js';
import { appendText, appendTool, setToolResult } from './agent/blocks.js';
import { loadSkillContent } from './skills.js';
import { composeChatMessages } from './chat-input.js';
import { notifyDone } from './notify.js';

const uid = () => Math.random().toString(36).slice(2, 10);

/** cron 单段匹配：星号通配、星号斜杠 N 步长、逗号列举、范围 */
function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  const step = field.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]) > 0 && value % Number(step[1]) === 0;
  return field.split(',').some((part) => {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return Number(part) === value;
  });
}

export function cronMatches(cron: string, d: Date): boolean {
  const [min, hour, day, month, week] = cron.trim().split(/\s+/);
  if (!week || !month || !day || !hour || !min) return false;
  return matchField(min, d.getMinutes()) && matchField(hour, d.getHours()) &&
    matchField(day, d.getDate()) && matchField(month, d.getMonth() + 1) &&
    matchField(week, d.getDay());
}

/** 每双周：以 startDate（缺省 createdAt 的本地日期）所在周为第 0 周，隔周触发。
 *  cron 的周几段已筛选星期，这里只负责「隔周」。 */
export function biweeklyDue(task: ScheduledTask, now: Date): boolean {
  const c = new Date(task.createdAt);
  const anchorSrc = task.startDate ||
    `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
  const anchor = new Date(anchorSrc + 'T00:00:00');
  if (isNaN(anchor.getTime())) return true; // 无有效锚点，退化为每周
  const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((day0(now) - day0(anchor)) / 86_400_000);
  return diffDays >= 0 && Math.floor(diffDays / 7) % 2 === 0;
}

/** 执行一次任务：与聊天页同一套 runAgent（人设/技能/工具齐全），不带工作区。 */
export async function runTask(
  task: ScheduledTask,
  gateway: { baseUrl: string; apiKey: string },
): Promise<{ ok: boolean; output: string; seconds: number; runId: string }> {
  const t0 = Date.now();
  const runId = `run-${uid()}`;
  // 任务总超时：没有它，网关/工具挂起会让这一轮永不返回，
  // 后面 upsertSession/addRun 全都不执行，这次运行凭空消失还越积越多
  const sig = AbortSignal.timeout(15 * 60_000);
  const skillBlocks: { id: string; content: string }[] = [];
  for (const id of task.skillIds || []) {
    const content = await loadSkillContent(id);
    if (content) skillBlocks.push({ id, content });
  }
  const assistant: ViewMessage = { id: uid(), role: 'assistant', content: [], ts: Date.now(), model: task.model };
  const viewMessages: ViewMessage[] = [
    { id: uid(), role: 'user', content: [{ type: 'text', text: task.prompt }], ts: Date.now(),
      skillIds: skillBlocks.length ? skillBlocks.map((s) => s.id) : undefined },
    assistant,
  ];

  let ok = true;
  let output = '';
  let reasoning = '';
  let errText = '';
  try {
    const composed = composeChatMessages({
      messages: [{ role: 'user', content: task.prompt }],
      skillBlocks,
      attachments: [],
      canSeeImages: canSeeImages(task.model),
    });
    const sessionId = `task-${task.id}-${runId}`;
    for await (const ev of runAgent({ ...gateway, model: task.model }, composed.messages, {
      workspace: null, signal: sig, sessionId, unattended: true,
    })) {
      if (ev.type === 'text') { output += ev.delta; appendText(assistant, ev.delta); }
      else if (ev.type === 'reasoning') reasoning += ev.delta;
      else if (ev.type === 'tool_start') {
        appendTool(assistant, { type: 'tool-call', id: ev.id, name: ev.name, summary: ev.summary, args: ev.args });
      } else if (ev.type === 'tool_done') {
        setToolResult(assistant, ev.id, ev.ok, ev.output);
      } else if (ev.type === 'error') {
        ok = false;
        errText = errText ? errText + '\n' + ev.message : ev.message;
      }
    }
    if (sig.aborted) {
      ok = false;
      errText = (errText ? errText + '\n' : '') + '任务超时（15 分钟），已中止';
    }
  } catch (e) {
    ok = false;
    errText = (e as Error).name === 'TimeoutError' ? '任务超时（15 分钟），已中止' : (e as Error).message;
  }
  if (ok && !output.trim()) { ok = false; output = '模型没有返回内容'; }
  assistant.reasoning = reasoning || undefined;
  assistant.error = errText || undefined;

  // 一次执行 = 一条运行记录 + 一个任务会话，靠 runId 对上
  upsertSession({
    id: `task-${task.id}-${runId}`,
    title: task.name || task.prompt.slice(0, 24),
    messages: viewMessages,
    updatedAt: Date.now(),
    source: 'task',
    taskId: task.id,
    runId,
  });
  const seconds = (Date.now() - t0) / 1000;
  addRun({ id: runId, taskId: task.id, at: Date.now(), ok, output: output || errText, seconds });
  touchTask(task.id, Date.now());
  // 定时任务本来就没人盯着，跑完弹通知才有意义
  const label = task.name || task.prompt.slice(0, 20);
  notifyDone(ok ? `定时任务「${label}」已完成` : `定时任务「${label}」执行失败`);
  return { ok, output: output || errText, seconds, runId };
}

/** 启动调度：每 30 秒轮询，同一分钟同一任务只跑一次 */
export function startScheduler(gateway: { baseUrl: string; apiKey: string }): void {
  const fired = new Set<string>(); // key = taskId|YYYY-MM-DDTHH:mm
  const inflight = new Set<string>(); // 正在执行的任务：跑超过一分钟也不重叠下一轮
  setInterval(() => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    for (const task of listTasks().filter((t) => t.enabled)) {
      if (task.repeat === 'once' && task.lastRun) continue; // 单次任务跑过就不再触发
      const key = `${task.id}|${minuteKey}`;
      if (fired.has(key)) continue;
      if (!cronMatches(task.cron, now)) continue;
      if (task.repeat === 'biweekly' && !biweeklyDue(task, now)) continue;
      // 有效期检查
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (task.startDate && dateStr < task.startDate) continue;
      if (task.endDate && dateStr > task.endDate) continue;
      if (inflight.has(task.id)) continue; // 上一轮还没跑完，不并发重叠
      fired.add(key);
      inflight.add(task.id);
      void runTask(task, gateway)
        .catch(() => {})
        .finally(() => inflight.delete(task.id));
    }
    // 清理过期 key：只留当前分钟的（key 带分钟戳，直接按后缀裁）
    for (const key of [...fired]) {
      if (!key.endsWith(`|${minuteKey}`)) fired.delete(key);
    }
  }, 30_000);
}
