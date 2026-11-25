import { useRef } from 'react';

/**
 * 通用列宽拖拽把手：mousedown 后跟手改宽度，双击还原默认。
 * 拖动期间给 body 加 paw-resizing（全局 col-resize + 禁选中），
 * 松手落 localStorage。所有竖向分隔线共用这一套手感。
 *
 * 注意：opts 每次渲染都是新对象（max 常是依赖容器宽度的函数）。
 * 这里用 ref 存最新 opts，拖拽回调一律从 ref 读——绝不把 opts 关进 useCallback，
 * 否则拖动中读到的是按下那一刻的旧上限，宽度会被错误地钉死在边界上。
 */
export function useColumnResize(
  current: number,
  onChange: (w: number) => void,
  opts: { min: number; max: number | (() => number); storeKey?: string; defaultWidth?: number; invert?: boolean;
    startWidth?: () => number },
) {
  const stateRef = useRef<{ startX: number; startW: number } | null>(null);
  const latest = useRef(current);
  latest.current = current;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stateRef.current = { startX: e.clientX, startW: optsRef.current.startWidth?.() ?? latest.current };
    document.body.classList.add('paw-resizing');
    const onMove = (ev: MouseEvent) => {
      const st = stateRef.current;
      if (!st) return;
      const o = optsRef.current;
      const cap = typeof o.max === 'function' ? o.max() : o.max;
      const delta = (ev.clientX - st.startX) * (o.invert ? -1 : 1);
      const next = Math.round(Math.min(cap, Math.max(o.min, st.startW + delta)));
      latest.current = next;
      changeRef.current(next);
    };
    const onUp = () => {
      stateRef.current = null;
      document.body.classList.remove('paw-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const o = optsRef.current;
      if (o.storeKey) localStorage.setItem(o.storeKey, String(latest.current));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const onDoubleClick = () => {
    const o = optsRef.current;
    if (o.defaultWidth === undefined) return;
    latest.current = o.defaultWidth;
    changeRef.current(o.defaultWidth);
    if (o.storeKey) localStorage.setItem(o.storeKey, String(o.defaultWidth));
  };

  return { onMouseDown, onDoubleClick };
}

/** 读持久化列宽（越界回默认） */
export function storedWidth(key: string, def: number, min: number, max: number): number {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}