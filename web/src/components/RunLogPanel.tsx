import { useEffect, useState } from 'react';
import { History, RefreshCw, X } from 'lucide-react';
import { getAllTaskRuns, type TaskRunWithName } from '../api/client';

/** 聊天页右侧可折叠的运行记录面板：显示所有定时任务的执行历史 */
export default function RunLogPanel({ onClose, onOpenSession, embedded = false }: {
  onClose: () => void;
  onOpenSession?: (run: TaskRunWithName) => void;
  /** true = 嵌在 TasksPage 的双 tab 里，不要浮层外壳/关闭按钮 */
  embedded?: boolean;
}) {
  const [runs, setRuns] = useState<TaskRunWithName[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    void getAllTaskRuns().then(setRuns).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // 按日期分组
  const grouped: Record<string, TaskRunWithName[]> = {};
  for (const r of runs) {
    const d = new Date(r.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (grouped[key] ||= []).push(r);
  }

  return (
    <aside className={embedded ? 'runlog-embedded' : 'runlog-panel'}>
      {!embedded && (
        <div className="runlog-head">
          <span><History size={14} /> 运行记录</span>
          <span className="runlog-actions">
            <button onClick={load} title="刷新"><RefreshCw size={13} className={loading ? 'spin' : ''} /></button>
            <button onClick={onClose} title="关闭"><X size={14} /></button>
          </span>
        </div>
      )}
      <div className="runlog-body">
        {runs.length === 0 && <div className="side-empty">还没有运行记录</div>}
        {Object.entries(grouped).map(([date, list]) => (
          <div className="runlog-day" key={date}>
            <div className="runlog-date">{date}</div>
            {list.map((r) => (
              <div className={'runlog-item ' + (r.ok ? 'ok' : 'fail')} key={r.id}
                onClick={() => { onOpenSession?.(r); setOpenId(openId === r.id ? null : r.id); }}>
                <div className="runlog-item-top">
                  <span className="runlog-task">{r.taskName}</span>
                  <span className="runlog-time">{new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="runlog-out">{r.output.slice(0, 90).replace(/\s+/g, ' ')}</div>
                <div className="runlog-meta">{r.ok ? '✓ 成功' : '✗ 失败'} · {r.seconds.toFixed(1)}s</div>
                {openId === r.id && <pre className="task-run-full">{r.output}</pre>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
