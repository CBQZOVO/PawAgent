import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface CtxItem {
  /** separator=true 时画一条分组线，其余字段忽略 */
  separator?: boolean;
  label: string;
  icon?: ReactNode;
  /** 右侧灰字（快捷键 / 文件名 / 行号范围） */
  hint?: string;
  onClick: () => void;
  /** 置灰不可点（如「关闭其他」在只有一个 tab 时） */
  disabled?: boolean;
}

/**
 * 轻量右键菜单：fixed + portal，避免被文件树 / 代码区的 overflow 裁掉。
 * 靠近窗口右/下边缘时自动往回收，不会出到屏幕外。
 */
export default function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => it.separator
        ? <div key={i} className="ctx-sep" role="separator" />
        : <button key={i} className="ctx-item" role="menuitem" disabled={it.disabled}
            onClick={() => { if (!it.disabled) { it.onClick(); onClose(); } }}>
            {it.icon}
            <span>{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
      )}
    </div>,
    document.body,
  );
}
