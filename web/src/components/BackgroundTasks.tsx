// 顶栏「后台任务」徽标 + 下拉面板：轮询 /api/jobs 展示 Agent 起的后台进程，
// 跑完时窗口不在前台就弹系统通知。对标 Claude Code 的 Background Tasks。
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { getBackgroundJobs, killBackgroundJob, notifyBackground, type BgJobView } from '../api/client';

const POLL_MS = 2500;
const KEEP_MS = 10 * 60 * 1000; // 已结束的任务在面板保留 10 分钟，之后不再展示

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** 单个任务的状态：图标 + 退出码文案 */
function JobState({ j }: { j: BgJobView }) {
  if (j.status === 'running') return <span className="bgtask-state running"><Loader2 size={13} /></span>;
  const ok = j.status === 'exited' && j.exitCode === 0;
  if (ok) return <span className="bgtask-state ok"><Check size={13} /></span>;
  return <span className="bgtask-state fail"><X size={13} /></span>;
}

function ExitTag({ j }: { j: BgJobView }) {
  if (j.status === 'running') return null;
  const ok = j.status === 'exited' && j.exitCode === 0;
  return <span className={'bgtask-exit ' + (ok ? 'ok' : 'fail')}>{j.status === 'killed' ? '已终止' : `exit=${j.exitCode}`}</span>;
}

export default function BackgroundTasks() {
  const [jobs, setJobs] = useState<BgJobView[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<Map<string, string>>(new Map());
  const killing = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const list = await getBackgroundJobs();
      if (!alive) return;
      // running → 结束的瞬间：窗口不在前台才弹系统通知（在前台的话用户自己看得见）
      for (const j of list) {
        const before = prevStatus.current.get(j.id);
        prevStatus.current.set(j.id, j.status);
        if (before === 'running' && j.status !== 'running' && document.hidden) {
          const ok = j.status === 'exited' && j.exitCode === 0;
          const tail = j.cmd.replace(/\s+/g, ' ').slice(0, 80);
          void notifyBackground(ok ? `后台任务完成：${tail}` : `后台任务失败（${j.status === 'killed' ? '已终止' : `exit=${j.exitCode}`}）：${tail}`)
            .catch(() => {});
        }
      }
      setJobs(list);
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const now = Date.now();
  // 只展示在跑的 + 刚结束不久的；跑完太久的历史任务不占面板
  const visible = jobs
    .filter((j) => j.status === 'running' || (j.endedAt && now - j.endedAt < KEEP_MS))
    .sort((a, b) => {
      const ra = a.status === 'running' ? 0 : 1, rb = b.status === 'running' ? 0 : 1;
      if (ra !== rb) return ra - rb;                 // 在跑的排前面
      if (ra === 0) return a.startedAt - b.startedAt; // 在跑的按启动顺序
      return (b.endedAt || 0) - (a.endedAt || 0);     // 结束的按完成时间倒序
    });
  const runningCount = visible.filter((j) => j.status === 'running').length;

  if (!visible.length) return null;

  return (
    <div className="bgtasks-wrap" ref={wrapRef}>
      <button
        className={'bgtasks-chip' + (open ? ' active' : '')}
        onClick={() => setOpen((v) => !v)}
        title="后台任务"
      >
        {runningCount > 0 && <span className="bgtasks-spin"><Loader2 size={13} /></span>}
        <span>{runningCount > 0 ? `${runningCount} 个任务运行中` : `${visible.length} 个后台任务`}</span>
      </button>
      {open && (
        <div className="bgtasks-menu">
          <div className="bgtasks-title">后台任务</div>
          {visible.map((j) => (
            <div className="bgtask-row" key={j.id} title={`${j.cmd}\n${j.cwd}`}>
              <JobState j={j} />
              <div className="bgtask-main">
                <span className="bgtask-cmd">{j.cmd}</span>
                <span className="bgtask-meta">
                  {j.daemon && <span className="bgtask-tag">常驻</span>}
                  <span>{fmtDur((j.endedAt || now) - j.startedAt)}</span>
                  <ExitTag j={j} />
                </span>
              </div>
              {j.status === 'running' && (
                <button
                  className="bgtask-kill"
                  title="终止"
                  disabled={killing.current.has(j.id)}
                  onClick={() => {
                    killing.current.add(j.id);
                    void killBackgroundJob(j.id).finally(() => killing.current.delete(j.id));
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
