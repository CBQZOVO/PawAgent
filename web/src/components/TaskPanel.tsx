import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronRight, Clock, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
import type { ScheduledTask, TaskRun } from '@paw/shared';
import { getModels, getSkills, getTaskRuns, getTasks, putTask, delTask, type ModelInfo } from '../api/client';
import ModelMenu from './ModelMenu';

const uid = () => Math.random().toString(36).slice(2, 10);
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const REPEATS: { key: ScheduledTask['repeat']; label: string }[] = [
  { key: 'interval', label: '间隔' }, { key: 'once', label: '单次' },
  { key: 'daily', label: '每天' }, { key: 'weekly', label: '每周' },
  { key: 'biweekly', label: '每双周' }, { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
];

interface SkillItem { id: string; name: string; description: string }

/** 从可视化规则生成 5 段 cron */
function buildCron(f: TaskForm): string {
  const [h, m] = f.time.split(':').map(Number);
  const min = String(m ?? 0), hour = String(h ?? 9);
  switch (f.repeat) {
    case 'once': return `${min} ${hour} * * *`; // 单次由调度器保证只跑一次（lastRun）
    case 'daily': return `${min} ${hour} * * *`;
    case 'weekly': return `${min} ${hour} * * ${f.weekdays.length ? f.weekdays.join(',') : '*'}`;
    case 'biweekly': return `${min} ${hour} * * ${f.weekdays.length ? f.weekdays.join(',') : '1'}`; // 隔周由调度器按锚点周判断
    case 'monthly': return `${min} ${hour} ${f.dayOfMonth || 1} * *`;
    case 'yearly': return `${min} ${hour} ${f.dayOfYear || 1} ${f.month || 1} *`;
    // cron 分钟段 0-59：*/N 只在 N 整除分钟时触发，N 上限 59（每 90 分钟请用单次+手动）
    case 'interval': return `*/${Math.min(59, Math.max(1, f.intervalMinutes || 60))} * * * *`;
  }
}

interface TaskForm {
  name: string; prompt: string; model: string; skillIds: string[];
  repeat: ScheduledTask['repeat']; time: string;
  weekdays: number[]; dayOfMonth: number; month: number; dayOfYear: number;
  intervalMinutes: number; startDate: string; endDate: string; wecomPush: boolean;
  enabled: boolean; // 编辑已停用的任务时保留停用状态，不能一保存就复活
}
const emptyForm = (): TaskForm => ({
  name: '', prompt: '', model: 'hy4flash', skillIds: [],
  repeat: 'weekly', time: '17:00', weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 20, month: 11, dayOfYear: 20, intervalMinutes: 60,
  startDate: '', endDate: '', wecomPush: false, enabled: true,
});

/** 定时任务面板（WorkBuddy 风格）：任务列表 + 可视化编辑 */
export default function TaskPanel({ onClose, onRunInChat, embedded = false }: {
  onClose: () => void;
  onRunInChat: (t: ScheduledTask) => void;
  /** true = 嵌在 TasksPage 的双 tab 里，不要模态框外壳 */
  embedded?: boolean;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [editing, setEditing] = useState<TaskForm | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editBase, setEditBase] = useState<ScheduledTask | null>(null); // 编辑时的原任务（保留 createdAt/lastRun）
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [showRepeat, setShowRepeat] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [showModel, setShowModel] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Record<string, TaskRun[]>>({});
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const skillWrapRef = useRef<HTMLDivElement>(null);

  const refresh = () => getTasks().then(setTasks).catch(() => {});
  useEffect(() => {
    void refresh();
    void getModels().then((d) => setModels(d.models));
    void getSkills().then(setSkills);
  }, []);

  useEffect(() => {
    if (!showSkills) return;
    const onDown = (e: MouseEvent) => {
      if (skillWrapRef.current && !skillWrapRef.current.contains(e.target as Node)) {
        setShowSkills(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showSkills]);

  const filteredSkills = skills.filter((s) => {
    const q = skillSearch.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  const openNew = () => { setEditId(null); setEditBase(null); setEditing(emptyForm()); };
  const openEdit = (t: ScheduledTask) => {
    setEditId(t.id);
    setEditBase(t);
    setEditing({
      name: t.name, prompt: t.prompt, model: t.model, skillIds: t.skillIds || [],
      repeat: t.repeat, time: t.time, weekdays: t.weekdays || [], dayOfMonth: t.dayOfMonth || 1,
      month: t.month || 1, dayOfYear: t.dayOfYear || 1, intervalMinutes: t.intervalMinutes || 60,
      startDate: t.startDate || '', endDate: t.endDate || '', wecomPush: !!t.wecomPush,
      enabled: t.enabled,
    });
  };

  const save = async () => {
    if (!editing || saving) return;
    setSaving(true);
    setError('');
    try {
      const t: ScheduledTask = {
        id: editId || uid(), name: editing.name || '未命名任务',
        prompt: editing.prompt, model: editing.model, skillIds: editing.skillIds,
        repeat: editing.repeat, time: editing.time, weekdays: editing.weekdays,
        dayOfMonth: editing.dayOfMonth, month: editing.month, dayOfYear: editing.dayOfYear,
        intervalMinutes: editing.intervalMinutes,
        startDate: editing.startDate || undefined, endDate: editing.endDate || undefined,
        wecomPush: editing.wecomPush, cron: buildCron(editing),
        enabled: editing.enabled,
        // 编辑时保留创建时间（双周锚点、列表排序都依赖它）和上次运行时间（单次任务靠它判重）
        createdAt: editBase?.createdAt ?? Date.now(),
        lastRun: editBase?.lastRun,
      };
      await putTask(t); // 失败会抛错：留在编辑器，草稿不丢
      setEditing(null); setEditId(null); setEditBase(null);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const showHistory = (t: ScheduledTask) => {
    if (runs[t.id]) return; // 已加载
    void getTaskRuns(t.id).then((list) => setRuns((prev) => ({ ...prev, [t.id]: list })));
  };
  const runNow = (t: ScheduledTask) => onRunInChat(t);
  const toggle = (t: ScheduledTask) => { void putTask({ ...t, enabled: !t.enabled }).then(refresh); };
  const remove = (id: string) => { void delTask(id).then(refresh); };

  const repeatLabel = (t: ScheduledTask) => {
    switch (t.repeat) {
      case 'weekly': case 'biweekly': return `${t.repeat === 'biweekly' ? '每双周' : '每周'} ${(t.weekdays || []).map((d) => WEEKDAYS[d]).join('')}`;
      case 'monthly': return `每月 ${t.dayOfMonth}日`;
      case 'yearly': return `每年 ${t.month}月${t.dayOfYear}日`;
      case 'interval': return `每 ${t.intervalMinutes} 分钟`;
      case 'once': return '单次';
      default: return '每天';
    }
  };

  const content = (
    <>
      {!embedded && (
        <div className="modal-head">
          <span><Clock size={15} /> {editing ? (editId ? '编辑定时任务' : '新建定时任务') : '定时任务'}</span>
          <button onClick={() => editing ? setEditing(null) : onClose()} title="关闭"><X size={15} /></button>
        </div>
      )}
      <div className={embedded ? 'embedded-body' : 'modal-body'}>
          {error && <div className="error-bar" style={{ margin: '0 0 12px' }}>⚠️ {error}</div>}

          {editing ? (
            <div className="task-editor">
              <input className="task-title-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="任务名称，如：报工" />
              <div className="task-compose">
                <textarea value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} rows={4}
                  placeholder="输入要定时执行的任务内容，如：使用 XX 技能完成报工…" />
                <div className="task-compose-bar">
                  {/* 技能选择 */}
                  <div className="skill-wrap" ref={skillWrapRef}>
                    <button className={'attach-btn' + (editing.skillIds.length ? ' active' : '')} onClick={() => setShowSkills((v) => !v)} title="选择技能"><Sparkles size={15} /></button>
                    {showSkills && (
                      <div className="skill-menu down">
                        <input autoFocus value={skillSearch} onChange={(e) => setSkillSearch(e.target.value)} placeholder="搜索技能…" />
                        <div className="skill-list">
                          {filteredSkills.map((s) => (
                            <button key={s.id} className={'skill-opt' + (editing.skillIds.includes(s.id) ? ' selected' : '')}
                              onClick={() => setEditing({ ...editing, skillIds: editing.skillIds.includes(s.id) ? editing.skillIds.filter((x) => x !== s.id) : [...editing.skillIds, s.id] })}>
                              <span><strong>{s.name}</strong><small>{s.description.slice(0, 45)}</small></span>
                              {editing.skillIds.includes(s.id) && <Check size={13} />}
                            </button>
                          ))}
                          {filteredSkills.length === 0 && <div className="popup-hint">没有匹配的技能</div>}
                        </div>
                        {editing.skillIds.length > 0 && (
                          <button className="skill-clear" onClick={() => { setEditing({ ...editing, skillIds: [] }); setShowSkills(false); }}>清除已选</button>
                        )}
                      </div>
                    )}
                  </div>
                  {editing.skillIds.map((id) => <span className="skill-chip-mini" key={id}>{id}</span>)}
                  <span style={{ flex: 1 }} />
                  {/* 模型选择：复用主输入栏的 ModelMenu */}
                  <ModelMenu
                    model={editing.model} models={models} open={showModel} search={modelSearch} refreshing={false}
                    onToggle={() => setShowModel((v) => !v)} onClose={() => setShowModel(false)}
                    onSearch={setModelSearch}
                    onSelect={(id) => { setEditing({ ...editing, model: id }); setShowModel(false); setModelSearch(''); }}
                  />
                </div>
              </div>

              <div className="task-settings">
                {/* 重复规则级联 */}
                <div className="task-field task-repeat-field">
                  <button className="task-field-btn" onClick={() => setShowRepeat((v) => !v)}>
                    重复：{repeatLabel({ ...editing, cron: '' } as ScheduledTask)} <ChevronDown size={13} />
                  </button>
                  {showRepeat && (
                    <div className="repeat-menu">
                      <div className="repeat-level">
                        {REPEATS.map((r) => (
                          <button key={r.key} className={'repeat-opt' + (editing.repeat === r.key ? ' sel' : '')}
                            onClick={() => setEditing({ ...editing, repeat: r.key })}>
                            {r.label}{['weekly', 'monthly', 'yearly'].includes(r.key) && <ChevronRight size={12} />}
                          </button>
                        ))}
                      </div>
                      {editing.repeat === 'weekly' || editing.repeat === 'biweekly' ? (
                        <div className="repeat-level">
                          {WEEKDAYS.map((d, i) => (
                            <button key={d} className={'repeat-opt' + (editing.weekdays.includes(i) ? ' sel' : '')}
                              onClick={() => setEditing({ ...editing, weekdays: editing.weekdays.includes(i) ? editing.weekdays.filter((x) => x !== i) : [...editing.weekdays, i] })}>
                              {d}{editing.weekdays.includes(i) && <Check size={12} />}
                            </button>
                          ))}
                        </div>
                      ) : editing.repeat === 'monthly' ? (
                        <div className="repeat-level scroll">
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                            <button key={d} className={'repeat-opt' + (editing.dayOfMonth === d ? ' sel' : '')} onClick={() => setEditing({ ...editing, dayOfMonth: d })}>{d}日</button>
                          ))}
                        </div>
                      ) : editing.repeat === 'yearly' ? (
                        <div className="repeat-level"><div className="year-months">
                          {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                            <button key={mo} className={'repeat-opt mini' + (editing.month === mo ? ' sel' : '')} onClick={() => setEditing({ ...editing, month: mo })}>{mo}月</button>
                          ))}
                        </div><div className="year-days">
                          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                            <button key={d} className={'repeat-opt mini' + (editing.dayOfYear === d ? ' sel' : '')} onClick={() => setEditing({ ...editing, dayOfYear: d })}>{d}</button>
                          ))}
                        </div></div>
                      ) : editing.repeat === 'interval' ? (
                        <div className="repeat-level"><label className="interval-input">每 <input type="number" min={1} max={59} value={editing.intervalMinutes} onChange={(e) => setEditing({ ...editing, intervalMinutes: Number(e.target.value) })} /> 分钟</label></div>
                      ) : null}
                    </div>
                  )}
                </div>
                {/* 时间 */}
                <label className="task-field"><Clock size={13} /> 时间
                  <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
                </label>
                {/* 有效期 */}
                <label className="task-field"><CalendarDays size={13} /> 有效期
                  <input type="date" value={editing.startDate} onChange={(e) => setEditing({ ...editing, startDate: e.target.value })} title="起始日期" />
                  <span>~</span>
                  <input type="date" value={editing.endDate} onChange={(e) => setEditing({ ...editing, endDate: e.target.value })} title="截止日期（留空=长期有效）" />
                </label>
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setEditing(null)}>取消</button>
                <button className="btn-primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '确定'}</button>
              </div>
            </div>
          ) : (
            <>
              <button className="btn-primary" onClick={openNew}><Plus size={14} /> 新建任务</button>
              <div className="task-list">
                {tasks.length === 0 && <div className="side-empty">还没有定时任务</div>}
                {tasks.map((t) => (
                  <div className="task-item" key={t.id}>
                    <div className="task-item-head">
                      <span className={'task-dot' + (t.enabled ? ' on' : '')} onClick={() => toggle(t)} title={t.enabled ? '停用' : '启用'} />
                      <span className="task-name" onClick={() => openEdit(t)}>{t.name}</span>
                      <code className="task-cron">{repeatLabel(t)} {t.time}</code>
                      <button onClick={() => openEdit(t)} title="编辑">编辑</button>
                      <button onClick={() => runNow(t)} title="立即运行"><Play size={12} /></button>
                      <button onClick={() => remove(t.id)} title="删除"><Trash2 size={12} /></button>
                    </div>
                    <div className="task-meta" onClick={() => showHistory(t)} title="点击查看执行历史">
                      {t.model} · {t.prompt.slice(0, 70)}{t.skillIds?.length ? ` · 技能: ${t.skillIds.join(',')}` : ''}
                      {t.lastRun && <span className="history-toggle"> · 执行历史 ▾</span>}
                    </div>
                    {runs[t.id] && (
                      <div className="task-history">
                        {runs[t.id].length === 0 && <div className="task-run">暂无执行记录</div>}
                        {runs[t.id].map((r) => (
                          <div key={r.id} className={'task-run ' + (r.ok ? 'ok' : 'fail')}>
                            <button className="task-run-head" onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}>
                              {new Date(r.at).toLocaleString()} · {r.seconds.toFixed(1)}s {expandedRun === r.id ? '▴' : '▾'}
                            </button>
                            {expandedRun === r.id
                              ? <pre className="task-run-full">{r.output}</pre>
                              : <div className="task-run-preview">{r.output.slice(0, 100)}…</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
      </div>
    </>
  );

  if (embedded) return <div className="task-panel-embedded">{content}</div>;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-panel" onClick={(e) => e.stopPropagation()}>{content}</div>
    </div>
  );
}
