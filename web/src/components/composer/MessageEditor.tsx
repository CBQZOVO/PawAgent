import { useLayoutEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import type { Attachment } from '@paw/shared';
import { addAttachments, MAX_ATTACHMENTS, readFiles } from '../../lib/attachments';
import ComposerEditor, { type ComposerFocus } from './ComposerEditor';

interface Props {
  text: string;
  attachments: Attachment[];
  onCancel: () => void;
  onSubmit?: (text: string, attachments: Attachment[]) => Promise<boolean>;
}

export default function MessageEditor({ text, attachments, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = useState(text);
  const [files, setFiles] = useState(attachments);
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const focusRef = useRef<ComposerFocus>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl + Enter';
  useLayoutEffect(() => { focusRef.current?.focus(); }, []);

  async function attach(list: FileList) {
    if (sending || reading || !list.length) return;
    setReading(true);
    setError('');
    try {
      const result = await readFiles(list);
      if (result.error) setError(result.error);
      else {
        const unique = addAttachments([], result.attachments).filter((a) => !files.some((f) => f.name === a.name && f.size === a.size));
        if (files.length + unique.length > MAX_ATTACHMENTS || result.attachments.length > MAX_ATTACHMENTS) {
          setError(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件`);
        } else {
          setFiles((prev) => addAttachments(prev, unique));
        }
      }
    } catch {
      setError('附件读取失败，请重新选择文件。');
    } finally {
      setReading(false);
    }
  }

  async function submit(value: string) {
    if (!onSubmit || sending || reading || (!value.trim() && !files.length)) return;
    setSending(true);
    setError('');
    try {
      if (await onSubmit(value.trim(), files)) onCancel();
      else setError('当前无法重新发送，请稍后重试。');
    } catch {
      setError('重新发送失败，请稍后重试。');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="user-edit"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !sending) {
          e.stopPropagation();
          onCancel();
        }
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        if (!e.clipboardData.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void attach(e.clipboardData.files);
      }}>
      <ComposerEditor value={draft} attachments={files} onChange={setDraft} onSend={submit}
        onRemoveAttachment={(index) => setFiles((prev) => prev.filter((_, i) => i !== index))}
        onRestoreAttachment={(a) => setFiles((prev) => addAttachments(prev, [a]))} onDropFiles={attach}
        placeholder="编辑消息…" focusRef={focusRef} disabled={sending} submitWithModifier />
      {error && <p className="user-edit-error" role="alert">{error}</p>}
      <div className="user-edit-foot">
        <span className="user-edit-hint">重新发送会回退此后的对话和文件更改。</span>
        <div className="user-edit-actions">
          <input ref={picker} type="file" multiple hidden onChange={(e) => {
            if (e.target.files) void attach(e.target.files);
            e.target.value = '';
          }} />
          <button className="attach-btn" title="添加附件" disabled={reading || sending} onClick={() => picker.current?.click()}><Paperclip size={15} /></button>
          <button className="ue-cancel" disabled={sending} onClick={onCancel}>取消</button>
          <button className="ue-send" title={`重新发送（${shortcut}）`} onClick={() => void submit(draft)}
            disabled={!onSubmit || reading || sending || (!draft.trim() && !files.length)}>
            {reading ? '读取附件中…' : sending ? '正在重发…' : '重新发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
