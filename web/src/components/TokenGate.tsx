// 首次启动未配置 GATEWAY_KEY 时显示：验证通过后保存到 ~/.paw/gateway-config.json，以后自动读取。
import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { saveToken, type TokenStatus } from '../api/client';

export default function TokenGate({ status, onDone }: {
  status: TokenStatus;
  onDone: () => void;
}) {
  const [gatewayUrl, setGatewayUrl] = useState(status.baseUrl || 'https://api.inspurai.cc');
  const [showCustomGateway, setShowCustomGateway] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const key = token.trim();
    if (!key) { setError('请输入 GATEWAY_KEY'); return; }
    const customUrl = showCustomGateway ? gatewayUrl.trim() : '';
    if (showCustomGateway && !/^https?:\/\/[^/\s]+/i.test(customUrl)) {
      setError('GATEWAY_URL 必须以 http:// 或 https:// 开头');
      return;
    }
    setBusy(true); setError('');
    try {
      const r = await saveToken(key, customUrl || undefined);
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
        <h1>登录模型网关</h1>
        <p className="token-gate-desc">
          首次使用需要填写 <code>GATEWAY_KEY</code>。<br />
          登录成功后写入 <code>{status.file}</code>，以后启动自动读取。
        </p>

        {showCustomGateway && (
          <div className="token-gate-field">
            <label htmlFor="paw-gateway-url">GATEWAY_URL</label>
            <input
              id="paw-gateway-url"
              type="url"
              value={gatewayUrl}
              onChange={(e) => { setGatewayUrl(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder="https://api.inspurai.cc"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <div className="token-gate-field">
          <label htmlFor="paw-token">GATEWAY_KEY</label>
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

        {error && (
          <div className="token-gate-error">
            <div>{error}</div>
            {!showCustomGateway && (
              <button
                type="button"
                className="token-gate-custom-link"
                onClick={() => setShowCustomGateway(true)}
              >
                自定义网关？
              </button>
            )}
          </div>
        )}
      </div>
      <div className="token-gate-foot">Paw · 本地桌面助手</div>
    </div>
  );
}
