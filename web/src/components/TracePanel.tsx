import { useEffect } from 'react';
import { Activity, CheckCircle2, Clock, ShieldOff, X, XCircle } from 'lucide-react';
import type { TurnTrace } from '@paw/shared';

function fmtMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${s}s` : `${m}m`;
}

function fmtTokens(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n < 1000 ? String(n) : `${Number((n / 1000).toFixed(1))}K`;
}

/** 轻量轮次轨迹面板：点击助手消息底部耗时徽标打开，展示单轮耗时分解与工具时间线 */
export default function TracePanel({
  trace,
  loading,
  onClose,
}: {
  trace: TurnTrace | null;
  loading?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="trace-backdrop" onClick={onClose}>
      <div className="trace-modal" role="dialog" aria-label="轮次执行轨迹" onClick={(e) => e.stopPropagation()}>
        <div className="trace-head">
          <div className="trace-title">
            <Activity size={15} />
            <span>本轮执行轨迹</span>
            {trace?.model && <span className="trace-model">{trace.model}</span>}
          </div>
          <button type="button" className="trace-close" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {loading ? (
          <div className="trace-empty">正在读取轨迹数据…</div>
        ) : !trace ? (
          <div className="trace-empty">当前轮次暂无轨迹记录（旧会话或尚未落盘）。</div>
        ) : (
          <div className="trace-body">
            <div className="trace-grid">
              <div className="trace-metric">
                <small>总耗时</small>
                <strong>{fmtMs(trace.totalMs)}</strong>
              </div>
              <div className="trace-metric">
                <small>首字响应</small>
                <strong>{fmtMs(trace.firstTextMs)}</strong>
              </div>
              <div className="trace-metric">
                <small>模型耗时（估算）</small>
                <strong>{fmtMs(trace.modelMs)}</strong>
              </div>
              <div className="trace-metric">
                <small>工具耗时（并集）</small>
                <strong>{fmtMs(trace.toolMs)}</strong>
              </div>
              {trace.approvalWaitMs > 0 && (
                <div className="trace-metric">
                  <small>等待确认</small>
                  <strong>{fmtMs(trace.approvalWaitMs)}</strong>
                </div>
              )}
              <div className="trace-metric">
                <small>模型轮次</small>
                <strong>{trace.rounds} 轮</strong>
              </div>
              <div className="trace-metric">
                <small>Token（输入 / 输出）</small>
                <strong>
                  {trace.usage ? `${fmtTokens(trace.usage.prompt)} / ${fmtTokens(trace.usage.completion)}` : '—'}
                </strong>
              </div>
            </div>

            <div className="trace-section-title">工具调用明细 ({trace.tools.length})</div>
            {trace.tools.length === 0 ? (
              <div className="trace-no-tools">本轮未调用工具</div>
            ) : (
              <div className="trace-tool-list">
                {trace.tools.map((t, idx) => (
                  <div className="trace-tool-row" key={`${t.id}-${idx}`}>
                    {t.ok ? (
                      <CheckCircle2 size={13} className="trace-ic ok" />
                    ) : t.rejectedByUser ? (
                      <ShieldOff size={13} className="trace-ic warn" />
                    ) : (
                      <XCircle size={13} className="trace-ic err" />
                    )}
                    <span className="trace-tool-name">{t.name}</span>
                    {t.rejectedByUser && <span className="trace-tool-tag">已拒绝</span>}
                    <span className="trace-tool-ms">
                      <Clock size={11} /> {fmtMs(t.ms)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
