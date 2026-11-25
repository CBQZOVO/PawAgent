// IDE 内置终端：把真实交互式 shell 通过 WebSocket 交给前端 xterm。
//
// 帧协议照搬 Heimdall（沿用 kubectl exec v4 的通道编号）：
// 每条二进制消息首字节是通道号，其余是负载。前后端只需实现一次编解码。
//
// 与 Heimdall 的关键差别：这是本机 IDE 给自己用的终端，**不做任何命令限制**。
// 不收窄 PATH、不用 restricted shell、不清洗环境变量——用户的 zsh/bash 配置、
// alias、nvm/pyenv、SSH agent 全部原样可用，管道重定向 sudo 一律放行。
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';

export const CH_STDIN = 0;
export const CH_STDOUT = 1;
export const CH_STDERR = 2;
export const CH_ERROR = 3;
export const CH_RESIZE = 4;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** 只是挡住畸形数值把 PTY 弄崩，不是安全限制 */
const MAX_COLS = 1000;
const MAX_ROWS = 1000;
/** 单帧上限 1MB：一次按键很小，但要允许粘贴大段文本 */
const MAX_FRAME = 1 << 20;

const encoder = new TextEncoder();

function frame(channel: number, payload: Uint8Array): Buffer {
  const buf = Buffer.allocUnsafe(payload.length + 1);
  buf[0] = channel;
  buf.set(payload, 1);
  return buf;
}

function clampSize(n: unknown, def: number, max: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def;
}

/** 用户默认 shell：$SHELL 优先，其次 macOS 常见路径，最后 /bin/sh */
export function defaultShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return '/bin/sh';
}

/** 会话数上限：本机 IDE 开十几个终端很正常，给个宽松上限防手滑开爆 */
const MAX_SESSIONS = 24;
const live = new Set<{ kill: () => void }>();

/**
 * 挂到已有的 http server 上（Hono 的 serve 返回的就是 node http.Server）。
 * 只接管 /api/terminal 的 upgrade，其余路径原样交回，不影响 SSE 与静态资源。
 */
export function attachTerminal(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/terminal') return; // 不是终端：不处理，交给其他监听者
    // 只允许本机来源：服务本身已经只监听回环，这里再挡一层跨站 WebSocket 劫持
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const cols = clampSize(url.searchParams.get('cols'), DEFAULT_COLS, MAX_COLS);
    const rows = clampSize(url.searchParams.get('rows'), DEFAULT_ROWS, MAX_ROWS);
    const shell = url.searchParams.get('shell') || defaultShell();
    const cwdParam = url.searchParams.get('cwd') || '';
    const cwd = cwdParam && existsSync(cwdParam) ? cwdParam : os.homedir();

    if (live.size >= MAX_SESSIONS) {
      ws.send(frame(CH_ERROR, encoder.encode(JSON.stringify({ message: `终端会话已达上限（${MAX_SESSIONS}），先关掉几个` }))));
      ws.close(1013, '会话过多');
      return;
    }

    let term: pty.IPty;
    try {
      term = pty.spawn(shell, ['-i'], {
        name: 'xterm-256color',
        cols, rows, cwd,
        // 完整继承环境：用户自己的 PATH / alias / nvm / ssh-agent 都要在
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' } as Record<string, string>,
      });
    } catch (e) {
      ws.send(frame(CH_ERROR, encoder.encode(JSON.stringify({ message: `启动 shell 失败：${(e as Error).message}` }))));
      ws.close(1011, '启动失败');
      return;
    }

    const handle = { kill: () => { try { term.kill(); } catch { /* 已退出 */ } } };
    live.add(handle);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      live.delete(handle);
      handle.kill();
    };

    // shell → 浏览器。PTY 只有一条流，stderr 已并入 stdout。
    term.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(frame(CH_STDOUT, encoder.encode(data)));
    });
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        // 退出码非 0 时给一条状态帧，前端显示原因；正常 exit 不打扰
        if (exitCode !== 0) {
          ws.send(frame(CH_ERROR, encoder.encode(JSON.stringify({ message: `shell 退出（code ${exitCode}）` }))));
        }
        ws.close(1000, '');
      }
      cleanup();
    });

    // 浏览器 → shell
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
      if (buf.length === 0) return;
      const channel = buf[0];
      const payload = buf.subarray(1);
      if (channel === CH_STDIN) {
        term.write(payload.toString('utf-8'));
      } else if (channel === CH_RESIZE) {
        try {
          const size = JSON.parse(payload.toString('utf-8')) as { Width?: number; Height?: number };
          const c = clampSize(size.Width, cols, MAX_COLS);
          const r = clampSize(size.Height, rows, MAX_ROWS);
          term.resize(c, r);
        } catch { /* 畸形尺寸帧忽略 */ }
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // 进程收尾：不留孤儿 shell
  const killAll = () => { for (const h of live) h.kill(); live.clear(); };
  process.on('SIGTERM', killAll);
  process.on('SIGINT', killAll);
  process.on('exit', killAll);
}

/** 供 /api/terminal/info 用：告诉前端默认 shell 与工作目录，省得前端猜 */
export function terminalInfo(cwd?: string | null) {
  const shell = defaultShell();
  return {
    shell,
    shellName: path.basename(shell),
    cwd: cwd && existsSync(cwd) ? cwd : os.homedir(),
    sessions: live.size,
    maxSessions: MAX_SESSIONS,
  };
}