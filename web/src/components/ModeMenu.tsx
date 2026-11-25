import { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Code2 } from 'lucide-react';

export type PawMode = 'agent' | 'ide';

const MODES: { id: PawMode; name: string; desc: string; icon: typeof Bot }[] = [
  { id: 'agent', name: 'Agent', desc: '对话为主，全屏聊天', icon: Bot },
  { id: 'ide', name: 'IDE', desc: '文件树 + 代码 + 侧边聊天', icon: Code2 },
];

/**
 * Agent / IDE 模式下拉。
 *
 * 默认形态是带说明的大菜单（菜单朝上，给输入框旁用）；
 * topbar 用 down+end：菜单朝下、右对齐（Gemini/Antigravity 顶栏同款）。
 */
export default function ModeMenu({ mode, onChange, compact, down, end }: {
  mode: PawMode;
  onChange: (m: PawMode) => void;
  compact?: boolean;
  /** 菜单朝下弹（顶栏） */
  down?: boolean;
  /** 菜单右对齐（贴着顶栏右缘） */
  end?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const cur = MODES.find((m) => m.id === mode) || MODES[0];
  const Icon = cur.icon;
  return (
    <div className={'mode-wrap' + (compact ? ' compact' : '')} ref={wrapRef}>
      <button
        className={'mode-trigger' + (mode === 'ide' ? ' ide' : '')}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="切换模式：Agent 对话为主，IDE 带文件树和编辑器"
      >
        {!compact && <Icon size={14} />}
        <span>{cur.name}</span>
        <ChevronDown size={11} className={open ? 'rot' : ''} />
      </button>
      {open && (
        <div className={'mode-menu' + (compact ? ' compact down' : down ? ' down' : ' popup-up') + (end ? ' end' : '')}>
          {MODES.map((m) => {
            const MIcon = m.icon;
            return (
              <button key={m.id} className={'mode-opt' + (m.id === mode ? ' selected' : '')}
                onClick={(e) => { e.stopPropagation(); onChange(m.id); setOpen(false); }}>
                <MIcon size={15} />
                <span className="mode-opt-text">
                  <strong>{m.name}</strong>
                  {!compact && <small>{m.desc}</small>}
                </span>
                {m.id === mode && <Check size={13} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
