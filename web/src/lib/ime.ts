// 输入法（IME）组字守卫。
//
// 问题：用中文输入法时，按 Enter 本来是「确认候选词」，但浏览器照样会派发一个 Enter keydown，
// 代码里 `if (e.key === 'Enter') send()` 就把它当发送了——一句话没打完就发出去。
//
// 三层判断，缺一层都会在某些输入法上漏：
// 1. `nativeEvent.isComposing`：Chrome / Safari 组字期间为 true
// 2. `keyCode === 229`：部分 IME（尤其 macOS 拼音 + WebKit）只给这个标记，isComposing 反而是 false
// 3. compositionend 之后的冷却窗：有些输入法 commit 完还会补一个 Enter keydown，
//    那时 isComposing 已经变回 false，只能靠时间窗吃掉（人工按发送的间隔远大于 60ms）
import { useRef } from 'react';

/** compositionend 之后的冷却窗（毫秒） */
const COMMIT_GRACE_MS = 60;

/**
 * 这一下按键是不是输入法的组字行为。
 * @param native 原生 KeyboardEvent（React 事件里是 e.nativeEvent）
 * @param composing 是否正处在 compositionstart..compositionend 之间
 * @param graceUntil 冷却窗截止时间戳（compositionend 时设置）
 */
export function isImeComposing(
  native: KeyboardEvent | undefined,
  composing: boolean,
  graceUntil: number,
): boolean {
  if (composing) return true;
  if (Date.now() < graceUntil) return true;
  if (!native) return false;
  return native.isComposing === true || native.keyCode === 229;
}

export function useImeGuard() {
  const composing = useRef(false);
  const until = useRef(0);

  return {
    /** 绑到 textarea / input 上 */
    handlers: {
      onCompositionStart: () => { composing.current = true; },
      onCompositionEnd: () => {
        composing.current = false;
        until.current = Date.now() + COMMIT_GRACE_MS;
      },
    },
    /** 这一下 Enter 是不是输入法在选词/确认候选 —— true 就忽略，别当发送 */
    isComposing: (e: React.KeyboardEvent) => isImeComposing(e.nativeEvent, composing.current, until.current),
  };
}
