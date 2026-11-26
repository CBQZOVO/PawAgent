// 自定义部件的宿主容器：分级沙箱 iframe + postMessage Bridge。
// 部件永远不进 Paw 主窗口的 JS 上下文；业务请求由宿主代发，部件只传相对路径。
import { useEffect, useRef, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import { WIDGET_BRIDGE_PROTOCOL, type WidgetBlock, type WidgetBridgeEnvelope, type WidgetInitPayload } from '@paw/shared';
import { resolveBusinessPage, type WidgetInfo } from '../api/client';
import { safeWidgetApiPath } from '../lib/widget-path';

export interface WidgetOpenPagePayload {
  path?: string;
  query?: Record<string, string>;
  title?: string;
  mode?: 'browser_panel' | 'modal';
}

/** App 注入给部件的宿主能力；所有回调按卡片实例归属，不靠部件自己报 id */
export interface WidgetHostApi {
  widgets: WidgetInfo[];
  sessionId?: string;
  onSendMessage(text: string): void;
  onSaveState(blockId: string, state: unknown): void;
  onOpenPanel(block: WidgetBlock, messageId?: string): void;
  onClosePanel(): void;
  onOpenBusinessPage(block: WidgetBlock, payload: WidgetOpenPagePayload): void;
}

interface BridgeRequest {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: 'text' | 'json' | 'arraybuffer';
  connectionCode?: string;
}

/** 与 dsh / Mano 的 Bridge budget 对齐：单卡片硬预算，超限直接回错而不是拖死页面 */
const WIDGET_CALL_TIMEOUT_MS = 15_000;
const WIDGET_MAX_CONCURRENT_CALLS = 8;
const WIDGET_MAX_PAYLOAD_CHARS = 64 * 1024;

const post = (
  win: Window | null,
  instanceId: string,
  type: string,
  payload?: unknown,
  requestId?: string | number,
) => {
  // 受限沙箱下 iframe 是 opaque origin，postMessage 只能用 '*'；
  // 串台防护靠 ev.source + protocol + from + instanceId（见下方 message 监听）。
  win?.postMessage({
    protocol: WIDGET_BRIDGE_PROTOCOL,
    channel: 'paw-widget',
    instanceId,
    from: 'host',
    requestId,
    type,
    payload,
  } satisfies WidgetBridgeEnvelope, '*');
};

function withQuery(url: string, rawPath?: string, query?: Record<string, unknown>): string {
  const out = new URL(url, location.href);
  if (typeof rawPath === 'string') {
    const qIdx = rawPath.indexOf('?');
    if (qIdx >= 0) {
      const hashIdx = rawPath.indexOf('#', qIdx);
      const rawQuery = hashIdx >= 0 ? rawPath.slice(qIdx + 1, hashIdx) : rawPath.slice(qIdx + 1);
      for (const [k, v] of new URLSearchParams(rawQuery)) out.searchParams.append(k, v);
    }
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) out.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  return out.toString();
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 部件只能用它自己绑定的连接；显式白名单允许插件放开到指定连接 */
function allowedConnection(spec: WidgetInfo | undefined, block: WidgetBlock, requested?: string): string | undefined {
  const bound = block.connectionCode || spec?.defaultConnection;
  if (!requested || requested === bound) return bound;
  const list = spec?.allowedConnections;
  if (Array.isArray(list) && list.includes(requested)) return requested;
  return undefined;
}

export default function WidgetFrame({ block, spec, mode = 'inline', host, messageId }: {
  block: WidgetBlock;
  spec?: WidgetInfo;
  mode?: 'inline' | 'panel';
  host: WidgetHostApi;
  messageId?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const abortRef = useRef(new AbortController());
  const pendingRef = useRef(new Set<symbol>());
  const theme = localStorage.getItem('paw-editor-theme') === 'dark' ? 'dark' : 'light';
  const latest = useRef({ block, spec, mode, host, messageId, theme });
  latest.current = { block, spec, mode, host, messageId, theme };
  const [height, setHeight] = useState(() => spec?.defaultHeight ?? 240);

  useEffect(() => () => abortRef.current.abort(), []);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const env = ev.data as WidgetBridgeEnvelope | null;
      const frame = iframeRef.current;
      if (!env || typeof env !== 'object' || ev.source !== frame?.contentWindow) return;
      if (env.channel === 'paw-widget' && env.protocol !== WIDGET_BRIDGE_PROTOCOL) {
        console.warn(`[widget] 丢弃不支持的 Bridge 协议版本：${String(env.protocol)}`);
        return;
      }
      if (env.protocol !== WIDGET_BRIDGE_PROTOCOL || env.from !== 'widget') return;
      // ready 时部件还不知道 instanceId（init 尚未下发），只按 frame source 认定；
      // 其他消息必须带正确 instanceId，防止同页多卡片串台。
      if (env.instanceId !== latest.current.block.id && !(env.type === 'ready' && !env.instanceId)) return;
      const { block: cur, spec: s, mode: m, host: h, messageId: mid, theme: t } = latest.current;
      const payload = (env.payload ?? {}) as BridgeRequest & Record<string, unknown>;

      if (env.type === 'ready') {
        readyRef.current = true;
        const init: WidgetInitPayload = {
          instanceId: cur.id,
          sessionId: h.sessionId,
          messageId: mid,
          connectionCode: cur.connectionCode || s?.defaultConnection,
          theme: t,
          mode: m,
          data: cur.data,
          dataRef: cur.dataRef,
          options: cur.options,
          state: cur.state,
        };
        post(frame?.contentWindow ?? null, cur.id, 'init', init);
        return;
      }
      if (env.type === 'resize') {
        const raw = Number(payload.height);
        if (!Number.isFinite(raw)) return;
        const cap = Math.min(s?.maxHeight ?? 800, 2000);
        setHeight(Math.min(Math.max(raw, 80), cap));
        return;
      }
      if (env.type === 'send_message') {
        const text = String(payload.text ?? '').trim();
        if (text) h.onSendMessage(text);
        return;
      }
      if (env.type === 'save_state') {
        h.onSaveState(cur.id, payload.state);
        return;
      }
      if (env.type === 'open_panel') { h.onOpenPanel(cur, mid); return; }
      if (env.type === 'close_panel') { h.onClosePanel(); return; }
      if (env.type === 'open_business_page') {
        h.onOpenBusinessPage(cur, {
          path: typeof payload.path === 'string' ? payload.path : undefined,
          query: (payload.query ?? undefined) as Record<string, string> | undefined,
          title: typeof payload.title === 'string' ? payload.title : undefined,
          mode: payload.mode === 'modal' ? 'modal' : 'browser_panel',
        });
        return;
      }
      if (env.type !== 'api_call' && env.type !== 'connection_call') return;
      const requestId = env.requestId;
      if (requestId === undefined || requestId === null) return;

      const isConn = env.type === 'connection_call';
      const resultType = isConn ? 'connection_result' : 'api_result';
      const reply = (value: Record<string, unknown>) => {
        if (abortRef.current.signal.aborted) return;
        post(frame?.contentWindow ?? null, cur.id, resultType, value, requestId);
      };
      let payloadSize = Number.MAX_SAFE_INTEGER;
      try { payloadSize = JSON.stringify(payload).length; } catch { /* 结构化克隆的循环引用，按超限处理 */ }
      if (payloadSize > WIDGET_MAX_PAYLOAD_CHARS) {
        reply({ ok: false, status: 0, error: '请求体过大' });
        return;
      }
      if (pendingRef.current.size >= WIDGET_MAX_CONCURRENT_CALLS) {
        reply({ ok: false, status: 0, error: '并发请求过多' });
        return;
      }
      const token = Symbol();
      pendingRef.current.add(token);
      void (async () => {
        try {
          const path = safeWidgetApiPath(payload.path);
          if (!path) throw new Error('部件请求了非法路径');
          const method = String(payload.method || 'GET').toUpperCase();
          let url: string;
          let base: string;
          if (isConn) {
            const code = allowedConnection(s, cur, payload.connectionCode);
            if (!code) throw new Error('部件未绑定系统连接，无法请求业务接口');
            base = `/api/connections/${encodeURIComponent(code)}/proxy`;
            url = withQuery(base + path, payload.path, payload.query);
          } else {
            if (!s?.pluginName) throw new Error('部件未关联插件，无法请求插件接口');
            base = `/api/plugin-api/${encodeURIComponent(s.pluginName)}`;
            url = withQuery(base + path, payload.path, payload.query);
          }
          // 纵深防御：即使 path 校验被绕过，也必须落在宿主路由前缀内
          const parsed = new URL(url, location.href);
          if (parsed.origin !== location.origin || !(parsed.pathname === base || parsed.pathname.startsWith(base + '/'))) {
            throw new Error('部件请求路径越界');
          }
          const headers: Record<string, string> = { ...(payload.headers || {}) };
          const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
          let body: BodyInit | undefined;
          if (payload.body !== undefined && payload.body !== null && method !== 'GET' && method !== 'HEAD') {
            if (payload.body instanceof ArrayBuffer) {
              body = payload.body;
              if (!hasCt) headers['Content-Type'] = 'application/octet-stream';
            } else if (typeof payload.body === 'string') {
              body = payload.body;
              if (!hasCt) headers['Content-Type'] = 'text/plain; charset=utf-8';
            } else {
              body = JSON.stringify(payload.body);
              if (!hasCt) headers['Content-Type'] = 'application/json';
            }
          }
          const signal = AbortSignal.any([abortRef.current.signal, AbortSignal.timeout(WIDGET_CALL_TIMEOUT_MS)]);
          const res = await fetch(url, { method, headers, body, signal });
          const responseType = payload.responseType === 'arraybuffer' ? 'arraybuffer' : (payload.responseType || 'text');
          let content: unknown;
          if (responseType === 'arraybuffer' && res.ok) content = toBase64(await res.arrayBuffer());
          else {
            const text = await res.text();
            content = responseType === 'json' && text ? JSON.parse(text) : text;
          }
          reply({ ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', data: content });
        } catch (e) {
          const err = e as Error;
          const message = err.name === 'TimeoutError' ? `请求超时（${WIDGET_CALL_TIMEOUT_MS}ms）`
            : err.name === 'AbortError' ? '部件已卸载或重新加载' : err.message;
          reply({ ok: false, status: 0, error: message });
        } finally {
          pendingRef.current.delete(token);
        }
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 流式增量 / 状态变化在部件 ready 后推送；ready 前的初始值由 init 一次带齐
  useEffect(() => {
    if (!readyRef.current) return;
    post(iframeRef.current?.contentWindow ?? null, block.id, 'update', {
      data: block.data, options: block.options, theme, status: block.status,
    });
  }, [block.id, block.data, block.options, block.status, theme]);

  // 若部件声明了 sso: true 且绑定了系统连接，挂载前先向服务端解析免密 URL
  const ssoCode = spec?.sso ? (block.connectionCode || spec.defaultConnection) : undefined;
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(() => (spec && !ssoCode ? spec.url : null));
  const [ssoError, setSsoError] = useState<string | null>(null);
  useEffect(() => {
    if (!spec) { setResolvedUrl(null); setSsoError(null); return; }
    if (!ssoCode) { setResolvedUrl(spec.url); setSsoError(null); return; }
    let cancelled = false;
    setResolvedUrl(null);
    setSsoError(null);
    const targetPath = typeof block.options?.path === 'string' ? block.options.path : undefined;
    void resolveBusinessPage(ssoCode, { path: targetPath, title: block.title || spec.title })
      .then((r) => { if (!cancelled) setResolvedUrl(r.url); })
      .catch((e) => { if (!cancelled) setSsoError((e as Error).message || '页面地址解析失败'); });
    return () => { cancelled = true; };
  }, [spec?.url, spec?.title, ssoCode, block.title, block.options?.path]);

  if (!spec) {
    return <div className="widget-missing">部件「{block.widgetId}」未注册或插件已停用</div>;
  }
  if (ssoError) {
    return <div className="widget-missing">部件加载失败：{ssoError}</div>;
  }
  if (!resolvedUrl) {
    return <div className="widget-missing">正在准备部件…</div>;
  }
  const sandbox = spec.sameOrigin
    ? 'allow-scripts allow-forms allow-same-origin'
    : 'allow-scripts allow-forms';
  return (
    <iframe
      ref={iframeRef}
      className="widget-frame"
      title={block.title || spec.title || '自定义部件'}
      src={resolvedUrl}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      style={mode === 'panel' ? undefined : { height }}
    />
  );
}

/** 消息流里的部件卡片：顶栏 + 分级沙箱主体；panel 部件只留摘要，避免占满聊天列 */
export function WidgetCard({ block, host, messageId }: { block: WidgetBlock; host: WidgetHostApi; messageId?: string }) {
  const spec = host.widgets.find((w) => w.key === block.widgetId);
  const [reloadSeq, setReloadSeq] = useState(0);
  const effectivePlacement = block.placement ?? spec?.placement ?? 'inline';
  return (
    <div className="widget-card">
      <div className="widget-card-head">
        <span className="widget-card-title">{block.title || spec?.title || '自定义部件'}</span>
        {block.status === 'streaming' && <span className="widget-card-status">更新中…</span>}
        {spec && (
          <>
            <button className="widget-card-act" title="重新加载" onClick={() => setReloadSeq((v) => v + 1)}>
              <RotateCw size={12} />
            </button>
            <button className="widget-card-act" title="在右侧展开" onClick={() => host.onOpenPanel(block, messageId)}>
              <Maximize2 size={12} />
            </button>
          </>
        )}
      </div>
      {effectivePlacement === 'panel' ? (
        <div className="widget-teaser">
          <span>此部件在右侧面板展示完整内容</span>
          <button onClick={() => host.onOpenPanel(block, messageId)}>查看 →</button>
        </div>
      ) : (
        <WidgetFrame key={`${block.id}:${reloadSeq}`} block={block} spec={spec} host={host} messageId={messageId} />
      )}
    </div>
  );
}
