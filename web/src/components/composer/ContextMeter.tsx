import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Minimize2 } from 'lucide-react';
import { CONTEXT_WINDOW_TOKENS, type ContextCategory, type ContextReading, type ViewMessage } from '@paw/shared';
import { getContextReading } from '../../api/client';
import { toChatMessages } from '../../lib/store';
import Tips from '../Tips';

interface Props {
  sessionId: string;
  turn?: ViewMessage;
  messages?: ViewMessage[];
  live?: ContextReading;
  disabled?: boolean;
  onCompact?: () => void;
  onHandoff?: () => void;
}

const CATEGORY_ITEMS: ReadonlyArray<{ key: keyof ContextCategory; label: string }> = [
  { key: 'system', label: '系统提示' },
  { key: 'user', label: '用户消息' },
  { key: 'assistant', label: '助手回复' },
  { key: 'tool', label: '工具结果' },
  { key: 'tools', label: '工具定义' },
  { key: 'images', label: '图片' },
];

function formatTokenCount(n: number): string {
  return n < 1000 ? String(n) : `${Number((n / 1000).toFixed(1))}K`;
}

export default function ContextMeter({ sessionId, turn, messages, live, disabled, onCompact, onHandoff }: Props) {
  const [saved, setSaved] = useState<ContextReading | null>();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const turnId = turn?.id;
  const since = turn?.ts;
  useEffect(() => {
    if (live || !turnId || since == null) return;
    const ctrl = new AbortController();
    getContextReading(sessionId, turnId, since, ctrl.signal)
      .then(reading => { if (!ctrl.signal.aborted) setSaved(reading); })
      .catch(() => { if (!ctrl.signal.aborted) setSaved(null); });
    return () => ctrl.abort();
  }, [sessionId, turnId, since, live]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const reading = live ?? saved;
  // 没有洞察样本的旧会话，按实际参与历史重建的正文估算，并在提示中说明口径。
  const used = useMemo(() => {
    if (reading) return reading.tokens;
    if (!turnId) return 0;
    if (saved === undefined) return null;
    const encoder = new TextEncoder();
    return toChatMessages(messages ?? []).reduce((sum, m) => sum + 4 + Math.ceil(encoder.encode(JSON.stringify(m)).length / 3), 0);
  }, [reading, turnId, saved, messages]);
  const percent = (used ?? 0) / CONTEXT_WINDOW_TOKENS * 100;
  const fraction = percent > 0 && percent < 0.1 ? '<0.1' : Number(percent.toFixed(1));
  const count = formatTokenCount(used ?? 0);
  const note = reading?.estimated ? '（估算）' : !reading && turnId ? '（按历史正文估算）' : '';
  const label = used === null ? '正在读取上下文用量' : `${fraction}% · ${count} / ${CONTEXT_WINDOW_TOKENS / 1000}K 上下文已使用${note}`;
  const canAct = !!sessionId && !!messages?.length && !disabled;

  const breakdown = useMemo(() => {
    const cat = reading?.byCategory;
    if (!cat) return null;
    const total = CATEGORY_ITEMS.reduce((sum, item) => sum + Math.max(0, cat[item.key] || 0), 0);
    if (total <= 0) return null;
    return {
      total,
      rows: CATEGORY_ITEMS.map((item) => {
        const value = Math.max(0, cat[item.key] || 0);
        const share = (value / total) * 100;
        const pctLabel = value > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
        return { ...item, value, share, pctLabel };
      }),
    };
  }, [reading?.byCategory]);

  return (
    <div className="context-meter-wrap" ref={wrapRef}>
      <Tips label={label}>
        <button
          type="button"
          className="context-meter"
          role="meter"
          aria-label="上下文用量"
          aria-valuemin={0}
          aria-valuemax={CONTEXT_WINDOW_TOKENS}
          aria-valuenow={used === null ? undefined : Math.min(used, CONTEXT_WINDOW_TOKENS)}
          aria-valuetext={label}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">
            <circle className="context-meter-track" cx="10" cy="10" r="7.5" />
            {percent > 0 && <circle className="context-meter-fill" cx="10" cy="10" r="7.5" pathLength="100"
              strokeDasharray={`${Math.min(100, percent)} 100`} transform="rotate(-90 10 10)" />}
          </svg>
        </button>
      </Tips>
      {open && (
        <div className="context-meter-menu" role="menu">
          <div className="context-meter-stat">{label}</div>
          {breakdown && (
            <div className="context-meter-breakdown">
              {breakdown.rows.map((row) => (
                <div className="context-meter-row" key={row.key}>
                  <span className="context-meter-row-label">{row.label}</span>
                  <span className="context-meter-row-bar">
                    <span className="context-meter-row-fill" style={{ width: `${Math.min(100, row.share)}%` }} />
                  </span>
                  <span className="context-meter-row-val">
                    {formatTokenCount(row.value)}
                    <small>{row.pctLabel}</small>
                  </span>
                </div>
              ))}
              {reading?.estimated === false && (
                <div className="context-meter-note">总量为网关实测，分项按本地估算占比</div>
              )}
            </div>
          )}
          {onCompact && (
            <button
              type="button"
              className="context-meter-action"
              disabled={!canAct}
              onClick={() => { setOpen(false); onCompact(); }}
            >
              <Minimize2 size={13} />
              <span><strong>原地压缩</strong><small>/compact 压缩当前历史</small></span>
            </button>
          )}
          {onHandoff && (
            <button
              type="button"
              className="context-meter-action highlight"
              disabled={!canAct}
              onClick={() => { setOpen(false); onHandoff(); }}
            >
              <ArrowRightLeft size={13} />
              <span><strong>交接到新会话</strong><small>/handoff 提炼交接单并新开会话</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
