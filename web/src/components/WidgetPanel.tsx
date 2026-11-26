// 右侧部件面板：与 BrowserPanel 并列的展示位，部件仍跑在 WidgetFrame 的沙箱 iframe 里。
import { Maximize2, Minimize2, X } from 'lucide-react';
import type { WidgetBlock } from '@paw/shared';
import WidgetFrame, { type WidgetHostApi } from './WidgetFrame';

export default function WidgetPanel({ block, host, width, full, onToggleFull, onClose, messageId }: {
  block: WidgetBlock;
  host: WidgetHostApi;
  messageId?: string;
  width: number;
  full: boolean;
  onToggleFull(): void;
  onClose(): void;
}) {
  const spec = host.widgets.find((w) => w.key === block.widgetId);
  return (
    <aside className={`widget-panel${full ? ' full' : ''}`} style={full ? undefined : { width }}>
      <div className="widget-panel-head">
        <span className="widget-panel-title">{block.title || spec?.title || '自定义部件'}</span>
        <button className="widget-card-act" title={full ? '还原' : '全屏'} onClick={onToggleFull}>
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button className="widget-card-act" title="关闭" onClick={() => { host.onClosePanel(); onClose(); }}>
          <X size={14} />
        </button>
      </div>
      <div className="widget-panel-body">
        <WidgetFrame key={block.id} block={block} spec={spec} mode="panel" host={host} messageId={messageId} />
      </div>
    </aside>
  );
}
