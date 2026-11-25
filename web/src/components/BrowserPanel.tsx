import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Plus, RotateCw, X } from 'lucide-react';

/** React 内置的 HTMLWebViewElement 只有 HTMLElement 成员，Electron 的导航方法要自己补 */
type WebviewElement = HTMLWebViewElement & {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
};

interface BrowserTab {
  id: string;
  dedupeKey: string;
  url: string;
  title: string;
  partition?: string;
  history: string[];
  index: number;
}

export interface BrowserRequest {
  id: number;
  url: string;
  key?: string;
  title?: string;
  partition?: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const desktop = () => (window as unknown as {
  pawDesktop?: {
    isDesktop?: boolean;
    openExternal?: (url: string) => void;
    onOpenUrl?: (cb: (url: string) => void) => () => void;
  };
}).pawDesktop;

/** 只放行 http/https，阻止 javascript:/file: 这类地址；裸域名补 https，本机地址补 http */
export function normalizeBrowserUrl(raw?: string | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `${local ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function titleFromUrl(url: string): string {
  if (!url) return '新标签页';
  try { return new URL(url).hostname || url; } catch { return url; }
}

/**
 * webview 必须用稳定 ref：内联 ref 每次父组件重渲染都会先回调 null 再重新绑定，
 * 重新绑定时再设一次 src 就会触发“跳转→setTabs→重渲染→重载→再跳转”的死循环。
 */
function WebviewPane({ id, bind, partition }: {
  id: string;
  bind: (id: string, el: WebviewElement | null) => void;
  partition?: string;
}) {
  const setRef = useCallback((el: HTMLWebViewElement | null) => bind(id, el as WebviewElement | null), [id, bind]);
  return <webview ref={setRef} className="bp-view" allowpopups partition={partition} />;
}

/** 内置浏览器面板：桌面端用 webview（不受目标站点 X-Frame-Options 限制），浏览器模式用 iframe */
export default function BrowserPanel({ request, width, onClose }: {
  request: BrowserRequest | null;
  width: number;
  onClose: () => void;
}) {
  const isDesktop = !!desktop()?.isDesktop;
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeId, setActiveId] = useState('');
  const [address, setAddress] = useState('');
  // iframe 没有 webview.reload()；显式刷新时只重建当前 iframe，不往地址栏塞缓存参数
  const [reloadSeq, setReloadSeq] = useState<Record<string, number>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const webRefs = useRef(new Map<string, WebviewElement>());
  const listeners = useRef(new Map<string, [string, EventListener][]>());
  const active = tabs.find((t) => t.id === activeId);

  useEffect(() => { setAddress(active?.url ?? ''); }, [activeId, active?.url]);

  const releaseWebview = useCallback((id: string) => {
    const el = webRefs.current.get(id);
    const entries = listeners.current.get(id);
    if (el && entries) for (const [event, fn] of entries) el.removeEventListener(event, fn);
    listeners.current.delete(id);
    webRefs.current.delete(id);
  }, []);

  /** webview 内部链接跳转：按历史推断是后退/前进还是新页面，避免重复入栈 */
  const commitNavigated = useCallback((id: string, raw: string) => {
    const url = normalizeBrowserUrl(raw);
    if (!url) return;
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id || t.url === url) return t;
      const back = t.index > 0 && t.history[t.index - 1] === url;
      const forward = t.index < t.history.length - 1 && t.history[t.index + 1] === url;
      if (back || forward) return { ...t, url, title: t.title, index: t.index + (back ? -1 : 1) };
      const history = [...t.history.slice(0, t.index + 1), url];
      return { ...t, url, title: t.title, history, index: history.length - 1 };
    }));
  }, []);

  const navigate = useCallback((id: string, raw: string) => {
    const url = normalizeBrowserUrl(raw);
    if (!url) return;
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id || t.url === url) return t;
      const history = [...t.history.slice(0, t.index + 1), url];
      return { ...t, url, title: titleFromUrl(url), history, index: history.length - 1 };
    }));
    // webview 的 src 不绑 React state（内部跳转后再绑会重载页面）；
    // 地址栏/新窗口这类显式导航直接改 DOM 的 src 才真正加载。
    if (isDesktop) webRefs.current.get(id)?.setAttribute('src', url);
  }, [isDesktop]);

  const bindWebview = useCallback((id: string, el: WebviewElement | null) => {
    if (!el) { releaseWebview(id); return; }
    webRefs.current.set(id, el);
    if (listeners.current.has(id)) return;
    const initial = tabsRef.current.find((t) => t.id === id)?.url;
    if (initial) el.setAttribute('src', initial);
    const urlOf = (e: Event) => String((e as Event & { url?: string }).url || '');
    const onNavigate = (e: Event) => commitNavigated(id, urlOf(e));
    const onTitle = (e: Event) => {
      const title = String((e as Event & { title?: string }).title || '').trim();
      if (!title) return;
      setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title } : t));
    };
    const onNewWindow = (e: Event) => {
      e.preventDefault();
      navigate(id, urlOf(e));
    };
    const entries: [string, EventListener][] = [
      ['did-navigate', onNavigate], ['page-title-updated', onTitle], ['new-window', onNewWindow],
    ];
    for (const [event, fn] of entries) el.addEventListener(event, fn);
    listeners.current.set(id, entries);
  }, [commitNavigated, navigate, releaseWebview]);

  useEffect(() => () => {
    for (const id of [...listeners.current.keys()]) releaseWebview(id);
  }, [releaseWebview]);

  // 外部打开链接请求：普通链接按 URL 去重，SSO 页面按 connectionCode+target 去重
  // （换票 URL 每次都不同，不能按最终 URL 判断是不是同一个页面）
  const requestId = request?.id;
  useEffect(() => {
    if (!request) return;
    const url = normalizeBrowserUrl(request.url);
    if (!url) return;
    const dedupeKey = request.key || url;
    const existing = tabsRef.current.find((t) => t.dedupeKey === dedupeKey);
    if (existing) {
      // SSO 换票 URL 每次不同：同 key 再打开时用新票刷新旧 Tab，否则 5 分钟后旧票会失效。
      const refresh = existing.url !== url;
      setTabs((prev) => prev.map((t) => t.id === existing.id ? {
        ...t,
        url,
        title: request.title || t.title,
        history: refresh ? [url] : t.history,
        index: refresh ? 0 : t.index,
      } : t));
      if (refresh && isDesktop) webRefs.current.get(existing.id)?.setAttribute('src', url);
      setActiveId(existing.id);
      return;
    }
    const tab: BrowserTab = {
      id: uid(), dedupeKey, url,
      title: request.title || titleFromUrl(url),
      partition: request.partition,
      history: [url], index: 0,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    // request.id 每次变化才处理；url 变化但 id 不变视为同一请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const newTab = () => {
    const id = uid();
    const tab: BrowserTab = { id, dedupeKey: `blank:${id}`, url: '', title: '新标签页', history: [''], index: 0 };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id);
    releaseWebview(id);
    const next = tabsRef.current.filter((t) => t.id !== id);
    if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? '');
    setTabs(next);
  };

  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeBrowserUrl(address);
    if (!url) { setAddress(active?.url ?? ''); return; }
    if (active) navigate(active.id, url);
    else {
      const id = uid();
      const tab: BrowserTab = { id, dedupeKey: url, url, title: titleFromUrl(url), history: [url], index: 0 };
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
    }
    (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
  };

  const go = (delta: number) => {
    if (!active) return;
    const index = active.index + delta;
    if (index < 0 || index >= active.history.length) return;
    if (isDesktop) {
      const el = webRefs.current.get(active.id);
      if (delta < 0) el?.goBack(); else el?.goForward();
      return;
    }
    setTabs((prev) => prev.map((t) => t.id === active.id
      ? { ...t, url: t.history[index], title: titleFromUrl(t.history[index]), index } : t));
  };

  const openExternal = () => {
    if (!active?.url) return;
    const bridge = desktop();
    if (bridge?.openExternal) bridge.openExternal(active.url);
    else window.open(active.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <aside className="browser-panel" style={{ width, flexBasis: width }}>
      <div className="bp-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={'bp-tab' + (t.id === activeId ? ' active' : '')}
            role="tab" aria-selected={t.id === activeId} title={t.url || '新标签页'}
            onClick={() => setActiveId(t.id)}>
            <Globe size={12} />
            <span className="bp-tab-name">{t.title}</span>
            <button className="bp-tab-close" title="关闭标签" aria-label="关闭标签"
              onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><X size={11} /></button>
          </div>
        ))}
        <button className="bp-tab-add" title="新标签页" aria-label="新标签页" onClick={newTab}><Plus size={14} /></button>
        <button className="bp-panel-close" title="关闭内置浏览器" aria-label="关闭内置浏览器" onClick={onClose}><X size={14} /></button>
      </div>
      <form className="bp-toolbar" onSubmit={submitAddress}>
        <button type="button" className="bp-nav" title="后退" aria-label="后退"
          disabled={!active || active.index <= 0} onClick={() => go(-1)}><ArrowLeft size={14} /></button>
        <button type="button" className="bp-nav" title="前进" aria-label="前进"
          disabled={!active || active.index >= active.history.length - 1} onClick={() => go(1)}><ArrowRight size={14} /></button>
        <button type="button" className="bp-nav" title="刷新" aria-label="刷新"
          disabled={!active?.url} onClick={() => {
            if (!active) return;
            if (isDesktop) webRefs.current.get(active.id)?.reload();
            else setReloadSeq((prev) => ({ ...prev, [active.id]: (prev[active.id] || 0) + 1 }));
          }}><RotateCw size={13} /></button>
        <input className="bp-address" value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="输入网址，或点击回答里的链接" aria-label="地址栏" spellCheck={false} />
        <button type="button" className="bp-nav" title="在系统浏览器打开" aria-label="在系统浏览器打开"
          disabled={!active?.url} onClick={openExternal}><ExternalLink size={13} /></button>
      </form>
      <div className="bp-body">
        {tabs.length === 0 && (
          <div className="bp-home">
            <Globe size={34} strokeWidth={1.2} />
            <p>内置浏览器</p>
            <small>点击回答里的链接，或在这里输入网址。浏览器模式下部分站点会拒绝内嵌，可用右上角在系统浏览器打开。</small>
          </div>
        )}
        {/* 所有 Tab 常驻 DOM：只隐藏非当前页，切换不卸载，页面状态/登录态/滚动位置都保留 */}
        {tabs.map((t) => (
          <div key={t.id} className="bp-view-pane" style={{ display: t.id === activeId ? 'flex' : 'none' }}>
            {!t.url ? (
              <div className="bp-home">
                <Globe size={30} strokeWidth={1.2} />
                <p>新标签页</p>
              </div>
            ) : isDesktop ? (
              <WebviewPane id={t.id} bind={bindWebview} partition={t.partition} />
            ) : (
              <iframe key={`${t.id}:${reloadSeq[t.id] || 0}`} className="bp-view" src={t.url} title={t.title} />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
