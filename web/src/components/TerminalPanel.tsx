import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, RotateCw, Trash2, X } from 'lucide-react';
import { getTerminalInfo, terminalWsUrl, type TerminalInfo } from '../api/client';
import Tips from './Tips';

/** 帧协议与后端 terminal.ts 一致（沿用 kubectl exec v4 通道号） */
const CH_STDIN = 0;
const CH_STDOUT = 1;
const CH_STDERR = 2;
const CH_ERROR = 3;
const CH_RESIZE = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(channel: number, payload: Uint8Array): ArrayBuffer {
  const buf = new Uint8Array(payload.length + 1);
  buf[0] = channel;
  buf.set(payload, 1);
  return buf.buffer;
}

/**
 * 终端配色全部取 GitHub VS Code Theme 的 terminal.* 令牌（见 editor-theme.css），
 * 随 GitHub Light / Dark 切换，不手调近似色。
 */
function readTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--gh-bg', '#ffffff'),
    foreground: v('--gh-term-fg', '#1f2328'),
    cursor: v('--gh-focus', '#0969da'),
    cursorAccent: v('--gh-bg', '#ffffff'),
    selectionBackground: v('--gh-list-active', '#afb8c133'),
    black: v('--gh-term-black', '#24292f'),
    red: v('--gh-term-red', '#cf222e'),
    green: v('--gh-term-green', '#116329'),
    yellow: v('--gh-term-yellow', '#4d2d00'),
    blue: v('--gh-term-blue', '#0969da'),
    magenta: v('--gh-term-magenta', '#8250df'),
    cyan: v('--gh-term-cyan', '#1b7c83'),
    white: v('--gh-term-white', '#6e7781'),
    brightBlack: v('--gh-term-bblack', '#57606a'),
    brightRed: v('--gh-term-bred', '#a40e26'),
    brightGreen: v('--gh-term-bgreen', '#1a7f37'),
    brightYellow: v('--gh-term-byellow', '#633c01'),
    brightBlue: v('--gh-term-bblue', '#218bff'),
    brightMagenta: v('--gh-term-bmagenta', '#a475f9'),
    brightCyan: v('--gh-term-bcyan', '#3192aa'),
    brightWhite: v('--gh-term-bwhite', '#8c959f'),
  };
}

/**
 * 一个终端会话的全部运行时对象。存在模块级 Map 里而不是组件 state：
 * 收起面板只是卸载视图，shell 与滚动历史都留着，再展开原样接回来。
 */
interface TermSession {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  socket: WebSocket | null;
  host: HTMLDivElement;
  observer: ResizeObserver | null;
  disposed: boolean;
  status: 'connecting' | 'open' | 'closed';
  message: string;
}

const sessions = new Map<string, TermSession>();
let seq = 0;
let lastActive = '';

/**
 * 视图订阅者集合（而不是单个回调）。
 * 一个会话在切标签/重挂面板时会经历「先订阅新的、再清理旧的」，
 * 用单槽 notify 会被旧 effect 的 cleanup 抹成 null，状态就再也推不到界面上了。
 */
const watchers = new Set<() => void>();
function notifyAll() { for (const w of watchers) w(); }

function sendResize(s: TermSession) {
  if (s.socket?.readyState === WebSocket.OPEN) {
    s.socket.send(frame(CH_RESIZE, encoder.encode(JSON.stringify({ Width: s.term.cols, Height: s.term.rows }))));
  }
}

function setStatus(s: TermSession, status: TermSession['status'], message = '') {
  s.status = status;
  s.message = message;
  notifyAll();
}

function connect(s: TermSession, cwd: string | null) {
  s.socket?.close();
  setStatus(s, 'connecting');
  const socket = new WebSocket(terminalWsUrl({ cwd, cols: s.term.cols, rows: s.term.rows }));
  socket.binaryType = 'arraybuffer';
  s.socket = socket;

  socket.onopen = () => { setStatus(s, 'open'); sendResize(s); };
  socket.onmessage = (ev) => {
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    if (!bytes.length) return;
    const payload = bytes.subarray(1);
    if (bytes[0] === CH_STDOUT || bytes[0] === CH_STDERR) s.term.write(payload);
    else if (bytes[0] === CH_ERROR) {
      let msg = '会话已结束';
      try { msg = (JSON.parse(decoder.decode(payload)) as { message?: string }).message || msg; } catch { /* 默认 */ }
      s.message = msg;
      notifyAll();
    }
  };
  socket.onerror = () => setStatus(s, 'closed', '终端连接失败，确认 Paw server 在跑');
  socket.onclose = () => {
    if (s.socket === socket) s.socket = null;
    if (s.disposed) return;
    s.term.writeln('\r\n\x1b[2m— 会话已结束，点重连或新建 —\x1b[0m');
    setStatus(s, 'closed', s.message);
  };
}

function createSession(cwd: string | null): TermSession {
  const id = `t${++seq}`;
  const host = document.createElement('div');
  host.className = 'term-host';

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    lineHeight: 1.35,
    fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, monospace",
    theme: readTheme(),
    scrollback: 8000,
    macOptionIsMeta: true,        // macOS：Option 当 Meta，readline/emacs 快捷键可用
    rightClickSelectsWord: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const s: TermSession = {
    id, title: `终端 ${seq}`, term, fit, socket: null, host,
    observer: null, disposed: false, status: 'closed', message: '',
  };
  sessions.set(id, s);

  term.onData((data) => {
    if (s.socket?.readyState === WebSocket.OPEN) s.socket.send(frame(CH_STDIN, encoder.encode(data)));
  });

  // 容器尺寸为 0（面板收起 / 动画中）时 xterm 的 fit 会抛，吞掉等下一次
  let lastW = 0, lastH = 0;
  const safeFit = () => {
    if (s.disposed || !host.isConnected) return;
    if (!host.clientWidth || !host.clientHeight) return;
    if (host.clientWidth === lastW && host.clientHeight === lastH) return;
    lastW = host.clientWidth; lastH = host.clientHeight;
    try { fit.fit(); } catch { /* 布局未就绪 */ }
    sendResize(s);
  };
  s.observer = new ResizeObserver(safeFit);
  s.observer.observe(host);

  lastActive = id;
  connect(s, cwd);
  return s;
}

function destroySession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  s.disposed = true;
  sessions.delete(id);
  s.observer?.disconnect();
  s.socket?.close(1000, '关闭终端');
  s.term.dispose();
  s.host.remove();
  if (lastActive === id) lastActive = [...sessions.keys()].pop() ?? '';
}

// GitHub Light/Dark 切换 → 所有终端（含未挂载的）同步换色
const themeObserver = new MutationObserver(() => {
  const theme = readTheme();
  for (const s of sessions.values()) s.term.options.theme = theme;
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-editor-theme'] });

/**
 * IDE 内置终端面板：真实交互式 shell（PTY），命令全放开、不做任何限制。
 * 多标签、可重连、随 GitHub 主题换色；收起面板不杀会话，展开原样接回。
 */
export default function TerminalPanel({ cwd, onClose, height, onResize }: {
  cwd: string | null;
  onClose: () => void;
  height: number;
  onResize: (h: number) => void;
}) {
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [activeId, setActiveId] = useState(lastActive);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => { void getTerminalInfo(cwd).then(setInfo); }, [cwd]);

  // 订阅会话状态变化（连接中/已连接/断开/错误消息）
  useEffect(() => {
    watchers.add(bump);
    return () => { watchers.delete(bump); };
  }, [bump]);

  /** 挂载视图：把活动会话的 host 放进容器，其余隐藏（实例与滚动历史都留着） */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (sessions.size === 0) createSession(cwdRef.current);
    const id = sessions.has(activeId) ? activeId : ([...sessions.keys()].pop() ?? '');
    if (id !== activeId) { setActiveId(id); return; } // 等下一轮用新 id 挂载
    lastActive = id;
    for (const s of sessions.values()) {
      if (s.id === id) {
        if (s.host.parentElement !== body) body.appendChild(s.host);
        s.host.style.display = 'block';
      } else {
        s.host.style.display = 'none';
      }
    }
    const cur = sessions.get(id);
    if (cur) requestAnimationFrame(() => { try { cur.fit.fit(); } catch { /* 未就绪 */ } sendResize(cur); });
  }, [activeId]);

  const list = [...sessions.values()];
  const active = sessions.get(activeId);
  const statusLabel = { connecting: '连接中', open: '已连接', closed: '已断开' }[active?.status ?? 'closed'];

  // 顶部横条拖动改高度
  const onGripDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let last = startH;
    document.body.classList.add('paw-resizing-v');
    const move = (ev: MouseEvent) => {
      last = Math.round(Math.min(window.innerHeight - 220, Math.max(140, startH + (startY - ev.clientY))));
      onResize(last);
    };
    const up = () => {
      document.body.classList.remove('paw-resizing-v');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('paw-term-height', String(last));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  return (
    <div className="term-panel" style={{ height, flexBasis: height }}>
      <div className="term-grip" title="拖动调整终端高度" onMouseDown={onGripDown} />
      <div className="term-bar">
        <div className="term-tabs">
          {list.map((s) => (
            <div key={s.id} className={'term-tab' + (s.id === activeId ? ' active' : '')} onClick={() => setActiveId(s.id)}>
              <span>{s.title}</span>
              <span className="term-tab-close" role="button" aria-label="关闭终端"
                onClick={(e) => { e.stopPropagation(); destroySession(s.id); bump(); }}><X size={11} /></span>
            </div>
          ))}
          <Tips label="新建终端">
            <button className="term-icon-btn" aria-label="新建终端"
              onClick={() => { const s = createSession(cwdRef.current); setActiveId(s.id); bump(); }}><Plus size={14} /></button>
          </Tips>
        </div>
        <span className={'term-status ' + (active?.status ?? 'closed')}>{statusLabel}</span>
        <span className="term-cwd" title={info?.cwd || ''}>
          {info?.shellName || 'shell'} · {(info?.cwd || '').split('/').filter(Boolean).pop() || '~'}
        </span>
        <Tips label="重连当前终端">
          <button className="term-icon-btn" aria-label="重连" disabled={!active}
            onClick={() => { if (active) { active.term.writeln('\x1b[2m— 重连 —\x1b[0m'); connect(active, cwdRef.current); bump(); } }}><RotateCw size={14} /></button>
        </Tips>
        <Tips label="清屏（保留滚动历史）">
          <button className="term-icon-btn" aria-label="清屏" disabled={!active} onClick={() => active?.term.clear()}><Trash2 size={14} /></button>
        </Tips>
        <Tips label="收起终端（会话保留）">
          <button className="term-icon-btn" aria-label="收起终端" onClick={onClose}><X size={15} /></button>
        </Tips>
      </div>
      {active?.message && <div className="term-message">{active.message}</div>}
      <div className="term-body" ref={bodyRef} />
    </div>
  );
}