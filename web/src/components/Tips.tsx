import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 气泡与按钮的间距 */
const GAP = 8;
/** 气泡大致高度（单行），只用来判断上方够不够放 */
const EST_H = 32;

/**
 * 轻量悬浮提示：hover/focus 时在按钮旁边显示气泡。
 *
 * 用 fixed 定位 + portal 渲染到 body，避免被侧栏 overflow 裁掉。
 * 但光 portal 不够——标签栏、状态栏的按钮就贴着窗口边缘，气泡往上弹会直接
 * 出到视口外，只剩一个黑色三角。所以这里做两件事：
 *   1. 上方空间不够就翻到下方；
 *   2. 左右贴边时把气泡拉回视口内（渲染后按真实宽度校正）。
 */
export default function Tips({ label, children }: { label: string; children: ReactNode }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top - EST_H - GAP < 4; // 上方放不下就翻到下方
    setPos({
      x: r.left + r.width / 2,
      y: below ? r.bottom + GAP : r.top - GAP,
      below,
    });
  };
  const hide = () => setPos(null);

  // 贴边校正：拿到真实宽度后把气泡拉回视口内（只越界时 set，不会循环）
  useLayoutEffect(() => {
    if (!pos || !bubbleRef.current) return;
    const half = bubbleRef.current.offsetWidth / 2;
    const minX = half + 8;
    const maxX = window.innerWidth - half - 8;
    // 文案比视口还宽时两边都放不下，直接居中（正常文案不会走到这）
    const x = minX > maxX ? window.innerWidth / 2 : Math.min(Math.max(pos.x, minX), maxX);
    if (x !== pos.x) setPos({ ...pos, x });
  }, [pos]);

  return (
    <span
      ref={wrapRef}
      className="tips-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos && createPortal(
        <span
          ref={bubbleRef}
          className={'tips-bubble' + (pos.below ? ' below' : '')}
          style={{ left: pos.x, top: pos.y }}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}
