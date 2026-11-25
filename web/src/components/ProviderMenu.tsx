import { useEffect, useRef } from 'react';
import { Check, ChevronDown, Globe2 } from 'lucide-react';
import type { SearchProvider } from '../api/client';

/** 侧栏底部的搜索引擎切换（受控组件） */
export default function ProviderMenu({
  provider, hasKey, open, onToggle, onClose, onSwitch,
}: {
  provider: SearchProvider;
  hasKey: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSwitch: (p: SearchProvider) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);
  return (
    <div className="side-bottom">
      <div className="provider-wrap" ref={wrapRef}>
        <button className="provider-btn" onClick={onToggle}>
          <Globe2 size={14} />
          <span>搜索引擎</span>
          <span className="provider-name">{provider === 'ddg' ? 'DuckDuckGo' : 'DeepSeek'}</span>
          <ChevronDown size={13} />
        </button>
        {open && (
          <div className="popup popup-up">
            {(['deepseek', 'ddg'] as SearchProvider[]).map((p) => (
              <button key={p} className={'popup-item' + (p === provider ? ' selected' : '')} onClick={() => onSwitch(p)}>
                <span>{p === 'ddg' ? 'DuckDuckGo（免费）' : 'DeepSeek'}</span>
                {p === provider && <Check size={13} />}
              </button>
            ))}
            {provider === 'deepseek' && !hasKey && <div className="popup-hint">未检测到 DeepSeek key</div>}
          </div>
        )}
      </div>
    </div>
  );
}
