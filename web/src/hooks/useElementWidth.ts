import { useEffect, useRef, useState } from 'react';

/** 元素内容宽度（ResizeObserver 实时跟随，布局/窗口/侧栏变化都能感知） */
export function useElementWidth<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const fit = () => setWidth(el.clientWidth);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return [ref, width] as const;
}