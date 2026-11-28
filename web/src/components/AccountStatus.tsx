import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';
import { logoutGateway } from '../api/client';
import { gatewayLabel } from '../lib/gateways';

/** 侧栏底部：当前登录网关与退出登录 */
export default function AccountStatus({ baseUrl, onLogout }: {
  baseUrl?: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const label = gatewayLabel(baseUrl);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const logout = async () => {
    setBusy(true); setError('');
    try {
      await logoutGateway();
      onLogout();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-wrap" ref={wrapRef}>
      <button className="account-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <UserRound size={15} />
        <span className="account-name" title={baseUrl || ''}>{label}</span>
        <span className="account-badge">已登录</span>
        <ChevronDown size={13} className={open ? 'tg-chevron open' : 'tg-chevron'} />
      </button>
      {open && (
        <div className="popup popup-up account-popup">
          <div className="account-info">
            <div className="account-info-title">当前网关</div>
            <div className="account-info-url" title={baseUrl || ''}>{baseUrl || '—'}</div>
          </div>
          {error && <div className="account-error">{error}</div>}
          <button type="button" className="popup-item account-logout" onClick={() => void logout()} disabled={busy}>
            <LogOut size={14} />
            <span>{busy ? '退出中…' : '退出登录'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
