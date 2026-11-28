import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe2 } from 'lucide-react';
import type { SearchProvider } from '../api/client';

const LABELS: Record<SearchProvider, string> = { deepseek: 'DeepSeek', kimi: 'Kimi', ddg: 'DuckDuckGo' };

/** 侧栏底部的搜索引擎切换（受控组件） */
export default function ProviderMenu({
  provider, hasKey, hasKimiKey, open, onToggle, onClose, onSwitch, onSaveKey,
}: {
  provider: SearchProvider;
  hasKey: boolean;
  hasKimiKey: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSwitch: (p: SearchProvider) => void;
  onSaveKey: (keyType: 'deepseekKey' | 'kimiKey', key: string) => Promise<void>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setEditing(false); setDraft(''); setError('');
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  const keyType = provider === 'deepseek' ? 'deepseekKey' : provider === 'kimi' ? 'kimiKey' : null;
  const hasCurrentKey = provider === 'deepseek' ? hasKey : provider === 'kimi' ? hasKimiKey : true;
  const closeEditor = () => { setEditing(false); setDraft(''); setError(''); };
  const save = async () => {
    if (!keyType || !draft.trim()) return;
    setSaving(true); setError('');
    try {
      await onSaveKey(keyType, draft.trim());
      closeEditor();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="side-bottom">
      <div className="provider-wrap" ref={wrapRef}>
        <button className="provider-btn" onClick={onToggle}>
          <Globe2 size={14} />
          <span>搜索引擎</span>
          <span className="provider-name">{LABELS[provider]}</span>
          <ChevronDown size={13} />
        </button>
        {open && (
          <div className="popup popup-up search-popup">
            {(['deepseek', 'kimi', 'ddg'] as SearchProvider[]).map((p) => (
              <button
                key={p}
                className={'popup-item' + (p === provider ? ' selected' : '')}
                onClick={() => { onSwitch(p); closeEditor(); }}
              >
                <span>{p === 'ddg' ? 'DuckDuckGo（免费）' : LABELS[p]}</span>
                {p === provider && <Check size={13} />}
              </button>
            ))}
            {keyType && (editing || !hasCurrentKey) && (
              <div className="search-key-setup">
                {!editing ? (
                  <>
                    <div className="search-key-hint">未配置 {LABELS[provider]} API Key，联网搜索不可用</div>
                    <button type="button" className="search-key-link" onClick={() => setEditing(true)}>
                      配置 Key →
                    </button>
                  </>
                ) : (
                  <div className="search-key-form">
                    <label>{LABELS[provider]} API Key</label>
                    <input
                      type="password"
                      value={draft}
                      onChange={(e) => { setDraft(e.target.value); setError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                      placeholder="sk-..."
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {error && <div className="search-key-error">{error}</div>}
                    <div className="search-key-actions">
                      <button type="button" onClick={closeEditor}>取消</button>
                      <button type="button" className="primary" onClick={() => void save()} disabled={saving || !draft.trim()}>
                        {saving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {keyType && hasCurrentKey && !editing && (
              <div className="search-key-ok">
                <Check size={12} />
                <span>{LABELS[provider]} Key 已配置</span>
                <button type="button" className="search-key-edit" onClick={() => setEditing(true)}>更换</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
