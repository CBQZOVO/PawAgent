// 消息流"粘底"滚动：只有用户本来就在底部时才自动跟随新内容；
// 往上翻就立刻停止跟随，露出"回到底部"按钮，绝不把正在读的内容顶走。
// 流式 token 每秒几十次，用 rAF 合并成每帧一次 scrollTop 赋值（不用 smooth，会排队卡住）。
import { useCallback, useEffect, useRef, useState } from 'react';

/** 距底多少像素内算"在底部"（触摸板惯性/气泡高度误差的容差） */
const NEAR_BOTTOM = 80;

export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  /** 是否跟随底部。用户主动上翻 → false，点按钮/自己滚回来 → true */
  const stick = useRef(true);
  const raf = useRef(0);
  const [away, setAway] = useState(false);

  /** 滚到底（下一帧，等 DOM 把新内容铺好） */
  const pin = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = ref.current;
      if (!el || !stick.current) return;
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  // 内容变化：跟随者在底部就贴底；不跟随的人一动不动
  useEffect(() => {
    if (!stick.current) return;
    pin();
  }, [dep, pin]);

  // 内容高度变化（图片加载、代码高亮、工具卡展开、切会话后正文异步渲染撑高）也要贴底：
  // 这些撑高晚于 dep 变化那一帧，只靠上面的 pin 会停在半路。rAF 已在 pin 里节流。
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) pin(); });
    const observeAll = () => { for (const n of Array.from(el.children)) ro.observe(n); };
    observeAll();
    // 切会话时子节点整批换掉，重新观察
    const mo = new MutationObserver(observeAll);
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [pin]);

  // 卸载时取消挂起的帧
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  /** 用户/程序滚动：按距底距离判定，不区分 scroll 来源（简单且不会互相打架） */
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    stick.current = near;
    setAway(!near);
  }, []);

  /** 点"回到底部"：恢复跟随并用平滑动画（用户主动动作，动画是加分不是干扰） */
  const toBottom = useCallback(() => {
    const el = ref.current;
    stick.current = true;
    setAway(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /** 切会话/清空时强制回到跟随态（否则上个会话"翻到中间"会带进新会话） */
  const reset = useCallback(() => {
    stick.current = true;
    setAway(false);
    pin();
  }, [pin]);

  return { ref, away, onScroll, toBottom, reset };
}
