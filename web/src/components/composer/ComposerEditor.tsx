import { useImperativeHandle, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Attachment } from '@paw/shared';
import { dropCursor } from 'prosemirror-dropcursor';
import { closeHistory, history, redo, undo } from 'prosemirror-history';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import { extractSkillRefs } from '../../lib/skill-refs';
import { attachmentKey } from '../../lib/attachments';
import AttachmentHoverArea from '../AttachmentHoverArea';
import { attachmentNode, documentKeys, draftText, parseDraft, schema } from './attachmentDocument';

export interface ComposerFocus { focus: () => void }

export interface ComposerEditorProps {
  value: string;
  attachments: Attachment[];
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  onRemoveAttachment: (index: number) => void;
  onSkillPaste?: (ids: string[]) => void;
  onDropFiles: (files: FileList) => void;
  onRestoreAttachment: (att: Attachment) => void;
  submitWithModifier?: boolean;
  compactCompletion?: boolean;
  placeholder: string;
  disabled: boolean;
  focusRef?: RefObject<ComposerFocus | null> | null;
}

function initialState(props: ComposerEditorProps) {
  const doc = parseDraft(props.value, props.attachments);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, doc.content.size),
    plugins: [history(), dropCursor({ color: 'var(--brand)', width: 2 })],
  });
}

const SLASH_COMMANDS = [
  { cmd: '/compact', insert: '/compact', desc: '压缩当前会话上下文' },
  { cmd: '/handoff', insert: '/handoff ', desc: '提炼交接单并开启新会话（可附下一步目标）' },
  { cmd: '/btw', insert: '/btw ', desc: '只读旁路提问（不调工具、不入主会话）' },
] as const;

export default function ComposerEditor(props: ComposerEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [candidates, setCandidates] = useState<typeof SLASH_COMMANDS[number][]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeIdxRef = useRef(0);
  activeIdxRef.current = activeIdx;
  const dismissed = useRef(false);
  const matchingCommands = (v: EditorView) => {
    const { doc, selection } = v.state;
    const text = doc.textContent;
    if (!latest.current.compactCompletion || !v.editable || v.composing || !v.hasFocus()
      || doc.childCount !== 1 || !doc.firstChild?.isText || !selection.empty || selection.to !== doc.content.size
      || !text.startsWith('/') || text.includes(' ')) return [];
    const list = SLASH_COMMANDS.filter((c) => c.cmd !== text && c.cmd.startsWith(text));
    return list;
  };
  const syncCandidates = (v: EditorView) => {
    const list = dismissed.current ? [] : matchingCommands(v);
    setCandidates(list);
    setActiveIdx((prev) => (list.length ? Math.min(prev, list.length - 1) : 0));
  };
  const complete = (v: EditorView, pick?: typeof SLASH_COMMANDS[number]) => {
    const list = matchingCommands(v);
    const chosen = pick ?? list[activeIdxRef.current] ?? list[0];
    if (!chosen) return;
    v.dispatch(closeHistory(v.state.tr).insertText(chosen.insert, 0, v.state.doc.content.size));
    setCandidates([]);
  };
  const emitted = useRef(props.value);
  const removed = useRef(new Map<string, Attachment>());
  useImperativeHandle(props.focusRef, () => ({ focus: () => editor.current?.focus() }), []);

  useLayoutEffect(() => {
    const view = new EditorView(host.current, {
      state: initialState(latest.current),
      editable: () => !latest.current.disabled,
      attributes: (state) => ({
        class: 'composer-input', role: 'textbox', 'aria-multiline': 'true',
        'aria-label': latest.current.submitWithModifier ? '编辑消息' : '消息输入',
        'aria-disabled': String(latest.current.disabled),
        'data-placeholder': state.doc.content.size ? '' : latest.current.placeholder,
      }),
      dispatchTransaction(tr) {
        const prev = view.state.doc;
        if (tr.getMeta('uiEvent') === 'drop') closeHistory(tr);
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) dismissed.current = false;
        syncCandidates(view);
        if (!tr.docChanged) return;
        const p = latest.current;
        const before = documentKeys(prev);
        const after = documentKeys(view.state.doc);
        // 按倒序删除，多个附件被同一次选区删除时下标仍然有效。
        for (let i = p.attachments.length - 1; i >= 0; i--) {
          const file = p.attachments[i];
          const key = attachmentKey(file.name, file.size);
          if (before.has(key) && !after.has(key)) {
            removed.current.set(key, file);
            p.onRemoveAttachment(i);
          }
        }
        for (const key of after) {
          const file = removed.current.get(key);
          if (file && !before.has(key) && !p.attachments.some((a) => attachmentKey(a.name, a.size) === key)) p.onRestoreAttachment(file);
        }
        emitted.current = draftText(view.state.doc);
        p.onChange(emitted.current);
      },
      handleClickOn(v, _pos, node, nodePos) {
        if (!v.editable || node.type !== schema.nodes.attachment) return false;
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, nodePos)));
        v.focus();
        return true;
      },
      handleDOMEvents: {
        focus(v) { syncCandidates(v); return false; },
        blur() { setCandidates([]); return false; },
        compositionstart() { setCandidates([]); return false; },
        mousedown(_v, e) {
          if (!(e.target instanceof Element) || !e.target.closest('.attachment-token button')) return false;
          e.preventDefault();
          return true;
        },
        click(v, e) {
          const chip = e.target instanceof Element && e.target.closest('.attachment-token button')?.parentElement;
          if (!chip || !v.editable) return false;
          const pos = v.posAtDOM(chip, 0);
          v.dispatch(closeHistory(v.state.tr).delete(pos, pos + 1));
          v.focus();
          return true;
        },
        drop(v, e) {
          if (!e.dataTransfer?.files.length) return false;
          e.preventDefault();
          e.stopPropagation();
          if (v.editable) {
            const at = v.posAtCoords({ left: e.clientX, top: e.clientY });
            if (at) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at.pos)));
            latest.current.onDropFiles(e.dataTransfer.files);
          }
          return true;
        },
        paste(v, e) {
          if (!e.clipboardData || !v.editable) return false;
          e.preventDefault();
          e.stopPropagation();
          if (e.clipboardData.files.length) latest.current.onDropFiles(e.clipboardData.files);
          else {
            let text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
            if (latest.current.onSkillPaste) {
              const parsed = extractSkillRefs(text);
              if (parsed.skillIds.length) latest.current.onSkillPaste(parsed.skillIds);
              text = parsed.text;
            }
            if (text) {
              const { from, to } = v.state.selection;
              const content = parseDraft(text, [...latest.current.attachments, ...removed.current.values()]).content;
              v.dispatch(closeHistory(v.state.tr).replaceWith(from, to, content).scrollIntoView());
            }
          }
          return true;
        },
        beforeinput(v, e) {
          if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return false;
          e.preventDefault();
          if (v.editable) v.dispatch(v.state.tr.insertText('\n').scrollIntoView());
          return true;
        },
      },
      handleKeyDown(v, e) {
        if (!v.editable || v.composing || e.isComposing || e.keyCode === 229 || (e.target as Element).closest('button')) return false;
        const mod = e.metaKey || e.ctrlKey;
        const list = !mod && !e.shiftKey && !e.altKey && !dismissed.current ? matchingCommands(v) : [];
        if (list.length) {
          if (e.key === 'Escape') {
            dismissed.current = true;
            setCandidates([]);
            return true;
          }
          if (e.key === 'ArrowDown') {
            setActiveIdx((i) => (i + 1) % list.length);
            return true;
          }
          if (e.key === 'ArrowUp') {
            setActiveIdx((i) => (i - 1 + list.length) % list.length);
            return true;
          }
          if (e.key === 'Tab' || e.key === 'Enter') {
            if (!e.repeat) complete(v);
            return true;
          }
        }
        if (mod && e.key.toLowerCase() === 'z') return (e.shiftKey ? redo : undo)(v.state, v.dispatch);
        if (e.ctrlKey && e.key.toLowerCase() === 'y') return redo(v.state, v.dispatch);
        if (e.key === 'Enter') {
          if (!e.shiftKey && (!latest.current.submitWithModifier || mod)) {
            if (!e.repeat) latest.current.onSend(draftText(v.state.doc));
          } else v.dispatch(v.state.tr.insertText('\n').scrollIntoView());
          return true;
        }
        const sel = v.state.selection;
        if ((e.key === 'Backspace' || e.key === 'Delete') && !sel.empty) {
          v.dispatch(closeHistory(v.state.tr).deleteSelection().scrollIntoView());
          return true;
        }
        if (!sel.empty || mod || e.altKey || e.shiftKey) return false;
        const back = e.key === 'Backspace' || e.key === 'ArrowLeft';
        if (!back && e.key !== 'ArrowRight' && e.key !== 'Delete') return false;
        const near = back ? sel.$from.nodeBefore : sel.$from.nodeAfter;
        if (near?.type !== schema.nodes.attachment) return false;
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, sel.from - (back ? 1 : 0))).scrollIntoView());
        return true;
      },
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);

  useLayoutEffect(() => {
    const v = editor.current!;
    if (props.value !== emitted.current) {
      v.updateState(initialState(props));
      emitted.current = props.value;
      removed.current.clear();
    } else v.setProps({}); // 刷新 disabled 和 placeholder。
    const present = documentKeys(v.state.doc);
    const added = props.attachments.filter((a) => !present.has(attachmentKey(a.name, a.size)));
    if (added.length) {
      // 文件读完才插入。工具栏、粘贴、拖放、IDE 引用都在这里得到同一种节点。
      const at = v.state.selection.to;
      const tr = closeHistory(v.state.tr).insert(at, added.map(attachmentNode));
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + added.length)));
    }
    syncCandidates(v);
  }, [props.value, props.attachments, props.disabled, props.placeholder, props.compactCompletion]);

  return <>
    {candidates.length > 0 && (
      <div className="slash-menu" role="listbox" aria-label="快捷命令">
        {candidates.map((c, idx) => (
          <button
            key={c.cmd}
            className={'compact-candidate' + (idx === activeIdx ? ' active' : '')}
            type="button"
            tabIndex={-1}
            onMouseEnter={() => setActiveIdx(idx)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { if (editor.current) complete(editor.current, c); }}
          >
            <strong>{c.cmd}</strong> {c.desc}
          </button>
        ))}
      </div>
    )}
    <AttachmentHoverArea className="composer-input-wrap" attachments={props.attachments}>
      <div ref={host} />
    </AttachmentHoverArea>
  </>;
}
