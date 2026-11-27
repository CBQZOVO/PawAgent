import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import type { PermissionDecision } from '@paw/shared';

export interface PermissionAskItem {
  id: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  tool: string;
  title: string;
  detail: string;
  options: PermissionDecision[];
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  decision?: PermissionDecision;
}

const DECISION_LABELS: Record<PermissionDecision, { label: string; cls: string }> = {
  allow_once: { label: '允许本次', cls: 'perm-btn primary' },
  allow_session: { label: '本会话始终允许', cls: 'perm-btn secondary' },
  deny: { label: '拒绝', cls: 'perm-btn danger' },
  deny_session: { label: '本会话禁止', cls: 'perm-btn danger-ghost' },
};

const STATUS_TEXT: Record<Exclude<PermissionAskItem['status'], 'pending'>, string> = {
  allowed: '已放行',
  denied: '已拒绝',
  cancelled: '已取消',
};

/** 严格确认模式内联卡片：非模态展示，方便滚动核对上下文后再放行或拒绝 */
export default function PermissionCard({
  ask,
  onDecide,
}: {
  ask: PermissionAskItem;
  onDecide: (id: string, decision: PermissionDecision) => void;
}) {
  const pending = ask.status === 'pending';
  return (
    <div className={`perm-card ${ask.status}`} role="region" aria-label={`权限确认：${ask.title}`}>
      <div className="perm-head">
        {ask.status === 'allowed' ? (
          <ShieldCheck size={15} className="perm-icon ok" />
        ) : ask.status === 'pending' ? (
          <ShieldAlert size={15} className="perm-icon warn" />
        ) : (
          <ShieldOff size={15} className="perm-icon muted" />
        )}
        <span className="perm-title">{ask.title}</span>
        <span className="perm-tool">{ask.tool}</span>
        {ask.status !== 'pending' && <span className={`perm-status ${ask.status}`}>{STATUS_TEXT[ask.status]}</span>}
      </div>
      <pre className="perm-detail">{ask.detail}</pre>
      {pending && (
        <div className="perm-actions">
          {ask.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={DECISION_LABELS[opt].cls}
              onClick={() => onDecide(ask.id, opt)}
            >
              {DECISION_LABELS[opt].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
