import { useCallback, useEffect, useRef, useState } from 'react';
import { type AgentEvent, type Session, type SessionPermission, type SessionSummary } from '@paw/shared';
import { delSession, getSession, getSessions, putSessions } from '../api/client';
import { loadSessions, saveSessions } from '../lib/store';
import { applyEventsToMessage, mergeSessions } from '../lib/session-sync';

/**
 * 会话状态：SQLite 拉/推 + localStorage 缓存 + 增删 + 流式事件应用。
 *
 * 数据安全规则（防止残缺缓存反写库）：
 * - localStorage 缓存里的附件/图片正文是清空的，只配展示，绝不能推回 SQLite；
 * - 只有「来自服务端成功拉取的会话」或「本次页面新建的会话」允许推送；
 * - 启动拉取失败 → 留在本地缓存模式（可用但不推库），拉空列表也如实清空；
 * - 只推内容真正变更过的会话（引用对比），不是每次全量上传。
 */
/**
 * 当前会话只记在 sessionStorage，不落 localStorage：
 * - 冷启动（新窗口）→ 空 → 直接是新对话，符合「打开就是新对话」的预期；
 * - 页面刷新 → 还在 → 不丢正在聊的上下文；
 * - 关掉窗口 → 自动清空。
 * 之前用 localStorage 存「最近一个会话」，结果一打开就停在昨天那个
 * 定时任务会话（标题=任务名、内容是空的），看着就像串台。
 */
const ACTIVE_KEY = 'paw-active-session';
function readActive(): string {
  try { return sessionStorage.getItem(ACTIVE_KEY) || ''; } catch { return ''; }
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveIdState] = useState<string>(readActive);
  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    try { if (id) sessionStorage.setItem(ACTIVE_KEY, id); else sessionStorage.removeItem(ACTIVE_KEY); } catch { /* 隐私模式 */ }
  }, []);
  // ready=true 表示已成功从服务端拿到列表（可推送）；false=本地缓存模式
  const [ready, setReady] = useState(false);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const createdRef = useRef(new Set<string>());   // 本次页面新建的会话 id
  const pushableRef = useRef(new Set<string>());  // 内容完整、允许推送的会话 id
  const dirtyRef = useRef(new Set<string>());     // 内容有变化、待推送的会话 id
  const snapshotRef = useRef(new Map(loadSessions().map((s) => [s.id, s]))); // 上次已知版本
  const loadedRef = useRef(new Set<string>());    // 消息正文已加载的会话 id
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mergedRef = useRef<Session[]>([]);

  // 启动：从 SQLite（经 API）拉会话。成功→合并（服务端为真相源）；失败→本地缓存模式
  useEffect(() => {
    getSessions()
      .then((list) => {
        for (const s of list) pushableRef.current.add(s.id);
        setSessions((prev) => {
          const merged = mergeSessions(list, prev, createdRef.current);
          mergedRef.current = merged;
          // 合并结果即新的基线，避免刚拉下来的数据被当作“变更”推回去
          snapshotRef.current = new Map(merged.map((s) => [s.id, s]));
          return merged;
        });
        // 刷新时恢复上次看的会话；冷启动本来就是空 → 保持新对话。
        // 不主动挑「最近一个有内容的」：那就又变成替用户打开历史会话了。
        setActiveIdState((prevId) => {
          const pool = mergedRef.current;
          if (prevId && pool.some((s) => s.id === prevId)) return prevId;
          try { sessionStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
          return '';
        });
        setReady(true);
      })
      .catch(() => { /* 后端不可用：留在本地缓存模式，绝不反写 */ });
  }, []);

  // 内容变更检测：引用对比标记 dirty（初始基线在启动合并时建立，不会误标）
  useEffect(() => {
    for (const s of sessions) {
      if (snapshotRef.current.get(s.id) !== s) dirtyRef.current.add(s.id);
      snapshotRef.current.set(s.id, s);
    }
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of [...dirtyRef.current]) if (!ids.has(id)) dirtyRef.current.delete(id);
    for (const id of [...snapshotRef.current.keys()]) if (!ids.has(id)) snapshotRef.current.delete(id);
  }, [sessions]);

  // 推送：防抖 + 只推 dirty ∩ 可推送；失败保留 dirty，下次变更重试
  useEffect(() => {
    if (!ready) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const byId = new Map(sessionsRef.current.map((s) => [s.id, s]));
      const payload = [...dirtyRef.current]
        // 只推「正文完整」的会话：列表摘要的 messages 是空数组，推回去会把库里的历史抹掉
        .filter((id) => pushableRef.current.has(id) && loadedRef.current.has(id))
        .map((id) => byId.get(id))
        .filter((s): s is Session => !!s);
      if (!payload.length) return;
      void putSessions(payload)
        .then(() => {
          for (const s of payload) {
            snapshotRef.current.set(s.id, s);
            // 推送期间没有新变更才清除标记，否则留给下一轮
            if (sessionsRef.current.find((x) => x.id === s.id) === s) dirtyRef.current.delete(s.id);
          }
        })
        .catch(() => { /* 推送失败保留 dirty */ });
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [sessions, ready]);

  // 本地缓存：节流写入（流式期间不每个 token 同步写 localStorage），pagehide 兜底
  useEffect(() => {
    if (cacheTimer.current) return;
    cacheTimer.current = setTimeout(() => {
      cacheTimer.current = null;
      saveSessions(sessionsRef.current);
    }, 1200);
  }, [sessions]);
  useEffect(() => {
    const flush = () => {
      if (cacheTimer.current) { clearTimeout(cacheTimer.current); cacheTimer.current = null; }
      saveSessions(sessionsRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  /** 打开会话时按需加载消息正文（列表接口只给摘要） */
  const ensureLoaded = useCallback(async (id: string): Promise<Session | null> => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (!s) return null;
    if (loadedRef.current.has(id)) return s;
    try {
      const full = await getSession(id);
      if (!full) return s;
      // 加载期间该会话已经被改动（发消息/流式应用）→ 不能用服务端快照覆盖内存里的新消息。
      // 但也不能直接把 loadedRef 置位了事：置位后推送过滤器放行它，若内存里还是
      // messages 为空的摘要版，下一次推送就会把空消息全量写回 SQLite——整段历史被抹掉。
      const cur = sessionsRef.current.find((x) => x.id === id);
      if (cur && cur !== s) {
        loadedRef.current.add(id);
        // 内存版还没有任何消息、服务端有完整正文 → 只补消息，其余字段（标题等）用内存的
        if (cur.messages.length === 0 && full.messages.length > 0) {
          const merged = { ...cur, messages: full.messages };
          snapshotRef.current.set(id, merged);
          setSessions((prev) => prev.map((x) => x.id === id ? merged : x));
          return merged;
        }
        return cur;
      }
      loadedRef.current.add(id);
      // 摘要→完整不算用户修改：同步基线，不标 dirty
      snapshotRef.current.set(id, full);
      dirtyRef.current.delete(id);
      setSessions((prev) => prev.map((x) => x.id === id ? full : x));
      return full;
    } catch {
      return s; // 拉不到详情就用摘要版（messages 可能为空）
    }
  }, []);

  /** 新建会话并登记为「本次创建」：内容在内存里是完整的，允许推送。返回会话 id */
  const createSession = useCallback((init: {
    title: string;
    source?: 'task';
    taskId?: string;
    workspace?: string;
    handoffFrom?: Session['handoffFrom'];
    /** 初始工具权限（全局许可只在新会话创建时带入） */
    permission?: SessionPermission;
  }): string => {
    const sid = Math.random().toString(36).slice(2, 10);
    const s: Session = {
      id: sid, title: init.title, messages: [], updatedAt: Date.now(),
      source: init.source, taskId: init.taskId, workspace: init.workspace,
      handoffFrom: init.handoffFrom,
      ...(init.permission ? { permission: init.permission } : {}),
    };
    createdRef.current.add(sid);
    pushableRef.current.add(sid);
    loadedRef.current.add(sid);
    setSessions((prev) => [s, ...prev]);
    return sid;
  }, []);

  const deleteSession = useCallback((id: string) => {
    void delSession(id).catch(() => {});
    dirtyRef.current.delete(id);
    snapshotRef.current.delete(id);
    pushableRef.current.delete(id);
    loadedRef.current.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    // 删掉的正好是当前会话 → 回到新对话（并清掉刷新恢复用的记录）
    setActiveIdState((prev) => {
      if (prev !== id) return prev;
      try { sessionStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
      return '';
    });
  }, []);

  /** 把一批流式事件应用到指定会话的某条 assistant 消息（帧级合并降低高频 token 渲染压力）。
   *  msgId 缺省才落「最后一条」——点了停止立刻重发时，旧流迟到的状态
   *  不能写进新一轮的消息，所以发送方都显式传 assistantMsg.id。 */
  const applyEvents = useCallback((sid: string, events: AgentEvent[], msgId?: string) => {
    if (!events.length) return;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const msgs = [...s.messages];
      const idx = msgId ? msgs.findIndex((m) => m.id === msgId) : msgs.length - 1;
      const hit = msgs[idx];
      if (idx < 0 || !hit || hit.role !== 'assistant') return s;
      msgs[idx] = applyEventsToMessage(hit, events);
      return { ...s, messages: msgs, updatedAt: Date.now() };
    }));
  }, []);

  const applyEvent = useCallback((sid: string, ev: AgentEvent, msgId?: string) => {
    applyEvents(sid, [ev], msgId);
  }, [applyEvents]);

  /** 追加用户+助手消息到会话（发送前），返回会话 id */
  const appendMessages = useCallback((sid: string, user: Session['messages'][number], assistant: Session['messages'][number], title: string) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? {
      ...s,
      title: s.messages.length === 0 ? title : s.title,
      messages: [...s.messages, user, assistant],
      updatedAt: Date.now(),
    } : s));
  }, []);

  /** 同步服务端已落库的权限变更：直接更新内存与基线快照，不标 dirty，避免 800ms PUT 回写冲突 */
  const syncSessionPermission = useCallback((sid: string, permission: SessionPermission) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const next: Session = { ...s, permission };
      snapshotRef.current.set(sid, next);
      return next;
    }));
  }, []);

  /** 导入会话后把服务端返回的新摘要并入列表并登记为可推送，不标 dirty */
  const applyImportedSessions = useCallback((imported: SessionSummary[]) => {
    if (!imported.length) return;
    const fresh: Session[] = imported.map((s) => ({ ...s, messages: [] }));
    for (const s of fresh) {
      pushableRef.current.add(s.id);
      snapshotRef.current.set(s.id, s);
    }
    setSessions((prev) => {
      const existing = new Set(prev.map((x) => x.id));
      const added = fresh.filter((s) => !existing.has(s.id));
      return [...added, ...prev].sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);

  return {
    sessions, setSessions, activeId, setActiveId, ready, ensureLoaded,
    createSession, deleteSession, applyEvent, applyEvents, appendMessages,
    syncSessionPermission, applyImportedSessions,
  };
}
