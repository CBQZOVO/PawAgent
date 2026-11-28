// 首次启动未配置 GATEWAY_KEY 时显示：验证通过后保存到 ~/.paw/gateway-config.json，以后自动读取。
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, KeyRound, Loader2 } from 'lucide-react';
import { saveToken, type TokenStatus } from '../api/client';
import { PRESET_GATEWAYS, CUSTOM_GATEWAY as CUSTOM, matchGateway } from '../lib/gateways';

export default function TokenGate({ status, onDone }: {
  status: TokenStatus;
  onDone: () => void;
}) {
  const savedUrl = status.baseUrl || '';
  const matched = matchGateway(savedUrl);
  const [platform, setPlatform] = useState(matched?.url ?? (savedUrl ? CUSTOM : PRESET_GATEWAYS[0].url));
  const [gatewayUrl, setGatewayUrl] = useState(matched ? '' : savedUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const isCustom = platform === CUSTOM;
  const targetUrl = isCustom ? gatewayUrl.trim() : platform;
  const platformLabel = isCustom
    ? '自定义网关…'
    : (PRESET_GATEWAYS.find((p) => p.url === platform)?.label ?? '自定义网关…');

  const submit = async () => {
    const key = token.trim();
    if (!key) { setError('请输入 API Key'); return; }
    if (isCustom && !/^https?:\/\/[^/\s]+/i.test(targetUrl)) {
      setError('GATEWAY_URL 必须以 http:// 或 https:// 开头');
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await saveToken(key, targetUrl);
      if (r.ok) onDone();
      else setError(r.error || '登录失败');
    } catch (e) {
      setError('网络错误：' + (e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="token-gate">
      <div className="token-gate-card">
        <div className="token-gate-icon"><KeyRound size={28} /></div>
        <h1>登录模型平台</h1>
        <p className="token-gate-desc">
          选择平台并填写该平台的 <code>API Key</code>。<br />
          验证通过后写入 <code>{status.file}</code>，以后启动自动读取。
        </p>

        <div className="token-gate-field token-gate-picker" ref={pickerRef}>
          <label>模型平台</label>
          <div className="token-gate-select-wrap">
            <button
              type="button"
              className="token-gate-select"
              onClick={() => setPickerOpen((v) => !v)}
              aria-expanded={pickerOpen}
            >
              <span>{platformLabel}</span>
              <ChevronDown size={15} className={pickerOpen ? 'tg-chevron open' : 'tg-chevron'} />
            </button>
            {pickerOpen && (
              <div className="token-gate-options">
                {PRESET_GATEWAYS.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    className={'popup-item' + (p.url === platform ? ' selected' : '')}
                    onClick={() => { setPlatform(p.url); setError(''); setPickerOpen(false); }}
                  >
                    <span>{p.label}</span>
                    {p.url === platform && <Check size={13} />}
                  </button>
                ))}
                <div className="token-gate-option-sep" />
                <button
                  type="button"
                  className={'popup-item' + (isCustom ? ' selected' : '')}
                  onClick={() => { setPlatform(CUSTOM); setError(''); setPickerOpen(false); }}
                >
                  <span>自定义网关…</span>
                  {isCustom && <Check size={13} />}
                </button>
              </div>
            )}
          </div>
          {!isCustom && <div className="token-gate-hint">接口地址：{platform}</div>}
        </div>

        {isCustom && (
          <div className="token-gate-field">
            <label htmlFor="paw-gateway-url">GATEWAY_URL</label>
            <input
              id="paw-gateway-url"
              type="url"
              value={gatewayUrl}
              onChange={(e) => { setGatewayUrl(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder="https://example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <div className="token-gate-field">
          <label htmlFor="paw-token">API Key</label>
          <input
            id="paw-token"
            type="password"
            value={token}
            onChange={(e) => { setToken(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="sk-..."
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <button className="token-gate-btn" onClick={() => void submit()} disabled={busy}>
          {busy ? <><Loader2 size={15} className="spin" /> 登录中…</> : '登录'}
        </button>

        {error && <div className="token-gate-error"><div>{error}</div></div>}
      </div>
      <div className="token-gate-foot">Paw · 本地桌面助手</div>
    </div>
  );
}
