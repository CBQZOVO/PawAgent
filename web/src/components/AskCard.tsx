// ask_user 的内联提问卡片。
//
// 交互形态参考 fathom 的 AskSheet（选项 + 自由输入），但不做成浮层翻页：
// 一次最多 4 题，全部平铺更省一次点击，也不会在切会话时丢掉浮层状态。
// 提交后卡片转只读——答案记在 content block 的 answer 上，刷新后仍是「已答复」。

import { useState } from 'react';
import { Check, HelpCircle } from 'lucide-react';
import type { AskQuestion } from '@paw/shared';
import { containsMermaidBlock } from '../lib/markdown-mermaid';
import Markdown from './Markdown';

/** 用户什么都没选就点「跳过」时发出去的话，让模型知道该自己拿主意 */
const SKIP_TEXT = '（这组问题我跳过了，你按自己认为最合理的方式继续，把假设写清楚就行）';

/** 兜底把历史或异常对象型 option 转为可读文本，避免渲染 [object Object] */
function formatOption(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const label = String(obj.label ?? obj.title ?? obj.text ?? obj.name ?? obj.value ?? '').trim();
    const desc = String(obj.description ?? obj.desc ?? obj.detail ?? '').trim();
    if (label && desc && desc !== label) return `${label} — ${desc}`;
    if (label) return label;
    if (desc) return desc;
  }
  const s = String(raw ?? '').trim();
  return s === '[object Object]' ? '' : s;
}

/** 若选项包含「标题 — 说明」格式，拆成主副文案便于排版 */
function splitOptionText(s: string): { title: string; desc?: string } {
  const idx = s.indexOf(' — ');
  if (idx > 0) return { title: s.slice(0, idx), desc: s.slice(idx + 3) };
  return { title: s };
}

export default function AskCard({ questions, answer, onSubmit }: {
  questions: AskQuestion[];
  answer?: string;
  onSubmit: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [free, setFree] = useState<Record<number, string>>({});
  // 提交后立刻锁住：answer 要等上层 setSessions 回写才出现，这中间的空档
  // 用户连点两下就会把同一问答发两遍。
  const [sent, setSent] = useState(false);

  const answered = typeof answer === 'string';

  /** 把每题的选择和自由输入拼成一段可读文本，作为下一条用户消息发出去 */
  const buildAnswer = () => {
    const parts: string[] = [];
    questions.forEach((q, i) => {
      const opts = picked[i] ?? [];
      const ft = (free[i] ?? '').trim();
      const seg: string[] = [];
      if (opts.length) seg.push(opts.join('、'));
      if (ft) seg.push(`自定义：${ft}`);
      // 「问题」和「回答」分行：两个都以「？」「：」结尾时挤在一行会变成「？：」，读着别扭
      if (seg.length) parts.push(`${i + 1}. ${q.question}\n   答：${seg.join('；')}`);
    });
    return parts.join('\n');
  };

  if (answered) {
    // 只留一行标记，不再把答案抄一遍：
    // 答复本身已经作为下一条用户消息发出去了，卡片再复制一份就是同一段话显示两次。
    return (
      <div className="askcard done">
        <div className="askcard-head">
          <HelpCircle size={14} />
          <span>已确认 {questions.length} 项</span>
          <Check size={13} className="askcard-ok" />
        </div>
      </div>
    );
  }

  const answeredCount = questions.filter((_, i) => (picked[i] ?? []).length > 0 || (free[i] ?? '').trim()).length;
  const hasAnswer = answeredCount > 0;

  const pick = (i: number, opt: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[i] ?? [];
      if (multi) {
        return { ...prev, [i]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] };
      }
      return { ...prev, [i]: cur.includes(opt) ? [] : [opt] };
    });
  };

  const submit = (skip = false) => {
    if (sent) return;
    setSent(true);
    onSubmit(skip ? SKIP_TEXT : (buildAnswer() || SKIP_TEXT));
  };

  return (
    <div className="askcard">
      <div className="askcard-head">
        <HelpCircle size={15} />
        <span>需要你确认 {questions.length} 项</span>
        <span className="askcard-progress">已答 {answeredCount}/{questions.length}</span>
      </div>
      {questions.map((q, i) => {
        const multi = !!q.multiple;
        const sel = picked[i] ?? [];
        const opts = (q.options || []).map(formatOption).filter(Boolean);
        return (
          <div className="askcard-item" key={i}>
            <div className="askcard-q">
              <span className="askcard-idx">{i + 1}</span>
              {containsMermaidBlock(q.question)
                ? <div className="askcard-q-text askcard-q-markdown"><Markdown>{q.question}</Markdown></div>
                : <span className="askcard-q-text">{q.question}</span>}
              <span className="askcard-tag">{multi ? '多选' : '单选'}</span>
            </div>
            {opts.length > 0 && (
              <div className="askcard-opts">
                {opts.map((o, oi) => {
                  const on = sel.includes(o);
                  const { title, desc } = splitOptionText(o);
                  return (
                    <button key={`${oi}-${o}`} type="button" className={`askcard-opt${on ? ' on' : ''}`}
                      onClick={() => pick(i, o, multi)}>
                      <span className={`askcard-check${multi ? ' multi' : ''}${on ? ' on' : ''}`}>
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="askcard-opt-body">
                        <span className="askcard-opt-title">{title}</span>
                        {desc && <span className="askcard-opt-desc">{desc}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <input
              className="askcard-free"
              placeholder="也可以直接输入补充说明（可与上方选项一起提交）"
              value={free[i] ?? ''}
              onChange={(e) => setFree((prev) => ({ ...prev, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
              }}
            />
          </div>
        );
      })}
      <div className="askcard-actions">
        <span className="askcard-tip">选择后点击提交，或在输入框回车</span>
        <button type="button" className="askcard-btn ghost" disabled={sent} onClick={() => submit(true)}>跳过</button>
        <button type="button" className="askcard-btn primary" disabled={!hasAnswer || sent} onClick={() => submit()}>提交</button>
      </div>
    </div>
  );
}
