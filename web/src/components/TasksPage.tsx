import { useState } from 'react';
import TaskPanel from './TaskPanel';
import RunLogPanel from './RunLogPanel';
import type { TaskRunWithName } from '../api/client';

/**
 * 定时任务 · 运行记录 共用页面：顶部双 tab。
 * 复用 TaskPanel / RunLogPanel 的全部逻辑，只把外壳换成嵌入式（embedded）。
 */
export default function TasksPage({ initialTab = 'tasks', onRunInChat, onOpenSession }: {
  initialTab?: 'tasks' | 'runs';
  onRunInChat: (t: import('@paw/shared').ScheduledTask) => void;
  onOpenSession?: (run: TaskRunWithName) => void;
}) {
  const [tab, setTab] = useState<'tasks' | 'runs'>(initialTab);
  return (
    <div className="tools-page">
      <div className="tools-tabs">
        <button className={'tools-tab' + (tab === 'tasks' ? ' active' : '')} onClick={() => setTab('tasks')}>定时任务</button>
        <button className={'tools-tab' + (tab === 'runs' ? ' active' : '')} onClick={() => setTab('runs')}>运行记录</button>
      </div>
      <div className="tools-body">
        {/* 两个都常驻：切 tab 不丢筛选/展开状态 */}
        <div style={{ display: tab === 'tasks' ? undefined : 'none' }}>
          <TaskPanel embedded onClose={() => {}} onRunInChat={onRunInChat} />
        </div>
        <div style={{ display: tab === 'runs' ? undefined : 'none' }}>
          <RunLogPanel embedded onClose={() => {}} onOpenSession={onOpenSession} />
        </div>
      </div>
    </div>
  );
}
