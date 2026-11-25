import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Sparkles, X } from 'lucide-react';

interface SkillItem { id: string; name: string; description: string }

/** 技能管理页：卡片列表 + 点开详情弹窗（技能文件就是介绍正文，不再分两个 tab） */
export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [dir, setDir] = useState('');
  const [active, setActive] = useState<SkillItem | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    fetch('/api/skills').then((r) => r.json()).then((d) => {
      setSkills(d.skills || []); setDir(d.dir || '');
    }).catch(() => setSkills([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // Esc 关闭详情弹窗（× 太小不好点时也能关）
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const open = (s: SkillItem) => {
    setActive(s);
    if (!content[s.id]) {
      fetch(`/api/skills/${encodeURIComponent(s.id)}/content`)
        .then((r) => r.json()).then((d) => setContent((prev) => ({ ...prev, [s.id]: d.content || '(读取失败)' })))
        .catch(() => setContent((prev) => ({ ...prev, [s.id]: '(读取失败)' })));
    }
  };

  return (
    <div className="manage-page">
      <header className="topbar">
        <span className="top-title"><Sparkles size={16} /> 技能</span>
        <span className="top-sub">{skills.length} 个技能</span>
      </header>
      <div className="manage-body">
        <div className="manage-toolbar">
          <span className="manage-dir"><FolderOpen size={13} /> {dir}</span>
          <button onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新</button>
        </div>
        <div className="skill-grid">
          {skills.map((s) => (
            <button className="skill-tile" key={s.id} onClick={() => open(s)}>
              <span className="skill-tile-icon"><Sparkles size={18} /></span>
              <span className="skill-tile-name">{s.name}</span>
              <span className="skill-tile-desc">{s.description || '（无描述）'}</span>
              <span className="skill-tile-tag">本地技能</span>
            </button>
          ))}
          {skills.length === 0 && (
            <div className="side-empty">
              还没有技能。往 ~/pawskill 里放带 SKILL.md 的文件夹，或者直接跟 Agent 说
              「把这套流程存成技能」。
            </div>
          )}
        </div>
      </div>

      {active && (
        <div className="modal-backdrop" onClick={() => setActive(null)}>
          <div className="modal skill-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>技能详情</span>
              <button className="skill-detail-close" onClick={() => setActive(null)} title="关闭（Esc）"><X size={18} /></button>
            </div>
            <div className="skill-detail-hero">
              <span className="skill-detail-icon"><Sparkles size={18} /></span>
              <span className="skill-detail-name">{active.name}</span>
              <span className="skill-detail-ver">v1.0.0</span>
            </div>
            <div className="skill-detail-desc">{active.description || '（无描述）'}</div>
            <div className="skill-detail-body">
              <div className="skill-info-row"><span>标识符</span><code>@{active.id}</code></div>
              <div className="skill-info-label">说明</div>
              <div className="skill-info-text">{content[active.id] || '加载中…'}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
