import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from '@paw/shared';
import { addAttachments, clearAttachments, readFiles, removeAttachment } from '../lib/attachments';

/** 附件管理：文件读取/粘贴图片/拖拽 + 增删状态。读取细节在 lib/attachments.ts（编辑框也用它） */
export function useAttachments(onError: (msg: string) => void) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [pending, setPending] = useState(0);
  const generation = useRef(0);
  const addFiles = useCallback(async (files: File[] | FileList | null) => {
    if (!files?.length) return;
    const draft = generation.current;
    setPending((n) => n + 1);
    try {
      const { attachments: loaded, error } = await readFiles(files);
      if (draft !== generation.current) return;
      if (error) onError(error);
      else setAttachments((prev) => addAttachments(prev, loaded));
    } finally {
      if (draft === generation.current) setPending((n) => n - 1);
    }
  }, [onError]);

  // 粘贴图片（WorkBuddy 风格）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (imgs.length) { e.preventDefault(); void addFiles(imgs); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addFiles]);

  return {
    attachments,
    readingFiles: pending > 0,
    addFiles,
    /** 直接追加已构造好的引用（右键「添加到 Paw 对话」：文件 / 文件夹 / 代码片段） */
    addRefs: (refs: Attachment[]) => setAttachments((prev) => addAttachments(prev, refs)),
    /** 用指定附件列表替换当前附件（从队列点「编辑」回填输入框用） */
    setFiles: (atts: Attachment[]) => {
      generation.current++;
      setPending(0);
      setAttachments([...atts]);
    },
    removeFile: (i: number) => setAttachments((prev) => removeAttachment(prev, i)),
    clearFiles: () => {
      generation.current++;
      setPending(0);
      setAttachments(clearAttachments());
    },
  };
}
