// ask_user：模型缺关键信息时结构化提问，并**暂停本轮**等用户答复。
//
// 移植自 fathom（src/fathom/agent/stream.py 的 ASK_USER_TOOL / normalize_questions），
// 只保留骨架：上限 4 题、每题选项上限 6 个、允许自由输入。
//
// 注意：这个工具**不走 executeTool**——它是控制信号，由 agent/loop.ts 提前拦截：
// 命中即 yield ask 事件并结束本轮，用户答复作为下一条 user 消息进入下一轮。
// 这里只负责 schema 和参数归一化。

import type { AskQuestion, ToolSchema } from '@paw/shared';

export const ASK_USER_SCHEMA: ToolSchema = {
  name: 'ask_user',
  description: [
    '缺少关键信息、且猜错代价明显时，向用户结构化提问并暂停本轮（一次最多 4 题）。',
    '用于：需求有歧义、需要在几个方案里选、要用户提供凭据/地址/账号这类只有他知道的东西。',
    '不要用它确认鸡毛蒜皮的小事，也不要问你自己查得到的东西。',
    '每题尽量给 options（前端渲染成按钮），用户也可以自由输入。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '要问的问题（最多 4 个）',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '问题本身，一句话说清' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '可选项字符串数组（每项必须是纯字符串，不要传对象）。前端渲染成选项行，用户仍可自由输入',
            },
            multiple: { type: 'boolean', description: '是否允许选多项（默认单选）' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

/** 把模型给的单个 option 归一为可读字符串，兼容 { label, description } / { text } / { value } 等对象格式，杜绝 [object Object] */
function normalizeOption(o: unknown): string {
  if (o === null || o === undefined) return '';
  if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') {
    const s = String(o).trim();
    return s === '[object Object]' ? '' : s;
  }
  if (typeof o === 'object' && !Array.isArray(o)) {
    const obj = o as Record<string, unknown>;
    const pickStr = (keys: string[]) => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      }
      return '';
    };
    const label = pickStr(['label', 'title', 'text', 'name', 'option', 'value', 'id']);
    const desc = pickStr(['description', 'desc', 'detail', 'subtitle', 'hint']);
    if (label && desc && desc !== label) return `${label} — ${desc}`;
    if (label) return label;
    if (desc) return desc;
    const vals = Object.values(obj)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map((v) => String(v).trim())
      .filter(Boolean);
    return vals.join(' — ');
  }
  return '';
}

/**
 * 把模型给的 questions 归一化：最多 4 条、丢掉空项、选项最多 6 个。
 * 模型经常把 questions 写成字符串数组、把 options 写成对象数组（{ label, description }）或塞进脏字段，
 * 这里统一收口，让下游（loop 的 ask 事件、前端卡片）只处理一种干净形状。
 */
export function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    if (typeof q === 'string') {
      const text = q.trim();
      if (text) out.push({ question: text, options: [] });
      continue;
    }
    if (!q || typeof q !== 'object') continue;
    const r = q as Record<string, unknown>;
    const text = String(r.question ?? r.title ?? r.text ?? '').trim();
    if (!text) continue;
    const seen = new Set<string>();
    const options: string[] = [];
    for (const item of Array.isArray(r.options) ? r.options : []) {
      const s = normalizeOption(item);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      options.push(s);
      if (options.length >= 6) break;
    }
    const multiple = Boolean(r.multiple ?? r.multiSelect ?? r.multi_select);
    out.push({ question: text, options, multiple });
  }
  return out;
}
