import { X } from 'lucide-react';

/** 破坏性操作的确认弹窗（回退对话 / 删除这类），样式跟 WorkBuddy 的确认框一致 */
export default function ConfirmDialog({ title, body, confirmText, cancelText = '取消', onCancel, onConfirm }: {
  title: string;
  body: string;
  confirmText: string;
  cancelText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <button className="confirm-close" onClick={onCancel} aria-label="关闭"><X size={18} /></button>
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-text">{body}</p>
        <div className="confirm-actions">
          <button className="btn-ghost" onClick={onCancel}>{cancelText}</button>
          <button className="btn-solid" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
