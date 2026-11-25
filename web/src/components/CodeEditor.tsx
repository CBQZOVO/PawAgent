import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { saveWorkspaceFile } from '../api/client';
import './../monaco-setup'; // 本地 worker + loader（必须在 Editor 前加载）

/**
 * Monaco 代码编辑器：VS Code / CodeBuddy 同款内核。
 * 光标、Cmd+A 只选代码、编辑态、Cmd+S 保存全是 Monaco 自带的，不再自己攒。
 * path 让 Monaco 按文件缓存 model —— 切 tab 保留光标位置和撤销栈。
 */
export default function CodeEditor({ root, path, ext, content, language, theme, onDirtyChange, onSaved, onAddToChat, readOnly = false }: {
  root: string;
  path: string;
  ext: string;
  content: string;
  language: string;
  theme: 'light' | 'dark';
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存成功后回调：刷新标签脏点、更新状态栏 */
  onSaved?: (size: number) => void;
  /** Monaco 右键菜单里的「添加到 Paw 对话」：有选中就带行号范围，没有就整个文件 */
  onAddToChat?: (start: number | null, end: number | null) => void;
  /** true = 只读预览（文件预览面板用）：不保存、不抢焦点、保留语法高亮和选区 */
  readOnly?: boolean;
}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  /** 当前编辑内容（初始来自服务端）；dirty 时与原文不同 */
  const [draft, setDraft] = useState(content);
  const dirtyRef = useRef(false);

  // 切换文件：重置草稿和脏标记。Monaco 自己按 path 缓存 model。
  useEffect(() => {
    setDraft(content);
    dirtyRef.current = false;
    onDirtyChange?.(false);
    setNotice('');
    // 切到这个文件就让编辑器拿焦点：打开文件即可打字/光标定位（VSCode 行为）
    editorRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 外部重载（Agent 改了文件）：以新内容为准
  useEffect(() => {
    if (!dirtyRef.current) { setDraft(content); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const save = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || saving) return;
    const text = ed.getValue();
    setSaving(true);
    setNotice('');
    try {
      const r = await saveWorkspaceFile(root, path, text);
      if ('error' in r) { setNotice(`保存失败：${r.error}`); return; }
      dirtyRef.current = false;
      onDirtyChange?.(false);
      onSaved?.(r.size);
      setNotice('已保存');
      setTimeout(() => setNotice(''), 1500);
    } finally { setSaving(false); }
  }, [root, path, saving, onDirtyChange, onSaved]);

  const onMount: OnMount = useCallback((ed, monaco) => {
    editorRef.current = ed;
    // Cmd/Ctrl+S 保存：只读预览不注册（没东西可存）
    if (!readOnly) {
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save(); });
    }
    // 右键「添加到 Paw 对话」（选中代码）：读 Monaco 的选区行号（1-based）
    // Monaco 自带右键菜单里加中文项：添加到 Paw 对话。跟 CodeBuddy 同款位置。
    // 只读预览里也保留——选中片段加到对话本来就有用。
    if (onAddToChat) {
      ed.addAction({
        id: 'paw.addToChat',
        label: '添加到 Paw 对话',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 0.5,
        run: (editor) => {
          const sel = editor.getSelection();
          const empty = !sel || sel.isEmpty();
          onAddToChat(empty ? null : sel!.getStartPosition().lineNumber, empty ? null : sel!.getEndPosition().lineNumber);
        },
      });
    }
    // 编辑模式让编辑器拿焦点（打开文件即可打字）；只读预览不抢焦点
    if (!readOnly) ed.focus();
  }, [save, onAddToChat, readOnly]);

  const onChange = useCallback((v: string | undefined) => {
    const next = v ?? '';
    setDraft(next);
    const dirty = next !== content;
    if (dirty !== dirtyRef.current) {
      dirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [content, onDirtyChange]);

  return (
    <div className="ide-monaco">
      <Editor
        path={readOnly ? `preview:${path}` : path}
        language={language}
        value={draft}
        theme={theme === 'dark' ? 'vs-dark' : 'vs'}
        onMount={onMount}
        onChange={onChange}
        loading={<div className="ide-code-empty">编辑器加载中…</div>}
        options={{
          readOnly,
          domReadOnly: readOnly,
          fontFamily: 'SF Mono, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 15,
          lineHeight: 26,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderLineHighlight: 'all', // 光标所在行整行淡色（VSCode 同款）
          renderWhitespace: 'selection',
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          tabSize: 2,
          padding: { top: 6, bottom: 18 },
          wordWrap: 'off',
          overviewRulerBorder: false,
          scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
        }}
      />
      {(notice || saving) && <div className="monaco-save-hint">{saving ? '保存中…' : notice}</div>}
    </div>
  );
}
