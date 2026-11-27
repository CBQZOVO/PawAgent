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

const CATEGORY_ITEMS: ReadonlyArray<{ key: keyof ContextCategory; label: string; color: string }> = [
  { key: 'system', label: '系统提示词', color: '#34a853' },
  { key: 'agentTools', label: '工具及子智能体', color: '#f59e0b' },
  { key: 'dialog', label: '对话消息', color: '#a855f7' },
  { key: 'mcp', label: '连接器及MCP', color: '#22d3ee' },
  { key: 'skills', label: '技能', color: '#3b82f6' },
  { key: 'toolResult', label: '工具结果', color: '#fb7185' },
  { key: 'images', label: '图片', color: '#ec4899' },
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
      rows: CATEGORY_ITEMS.map((item) => ({
        ...item,
        value: Math.max(0, cat[item.key] || 0),
      })),
    };
  }, [reading?.byCategory]);

  const cappedPercent = Math.min(100, Math.max(0, percent));

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
              strokeDasharray={`${cappedPercent} 100`} transform="rotate(-90 10 10)" />}
          </svg>
        </button>
      </Tips>
      {open && (
        <div className="context-meter-menu" role="menu">
          <div className="context-meter-title">上下文用量</div>
          <div className="context-meter-stat">
            <span className="context-meter-big">{used === null ? '…' : `${fraction}%`}</span>
            {used !== null && (
              <span className="context-meter-used">已使用 {count} / {CONTEXT_WINDOW_TOKENS / 1000}K{note}</span>
            )}
          </div>
          <div className="context-meter-segbar" aria-hidden="true">
            {breakdown && cappedPercent > 0 ? breakdown.rows.filter((r) => r.value > 0).map((r) => (
              <span
                key={r.key}
                style={{ width: `${(r.value / breakdown.total) * cappedPercent}%`, background: r.color }}
              />
            )) : cappedPercent > 0 ? <span className="fill" style={{ width: `${cappedPercent}%` }} /> : null}
          </div>
          {breakdown && (
            <div className="context-meter-legend">
              {breakdown.rows.map((row) => (
                <div className="context-meter-legend-row" key={row.key}>
                  <span className="context-meter-dot" style={{ background: row.color }} />
                  <span className="context-meter-legend-label">{row.label}</span>
                  <span className="context-meter-legend-val">
                    {row.value > 0 ? `~${formatTokenCount(row.value)}` : '0'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="context-meter-note">
            {!turnId && !reading ? '尚无本轮用量记录'
              : reading?.estimated ? '按上一轮请求口径估算 · 下一轮对话生效'
              : reading ? '总量为网关实测，分项按本地估算占比'
              : '按历史正文估算'}
          </div>
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
