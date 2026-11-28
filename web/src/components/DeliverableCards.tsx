import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FolderOpen } from 'lucide-react';
import type { ViewMessage } from '@paw/shared';
import { statFiles, type FileStatInfo } from '../api/client';
import { extractMessageDeliverables, formatFileSize } from '../lib/deliverables';
import { extOf } from '../lib/file-preview';
import FileBadge from './FileBadge';

/**
 * 消息底部产物卡片区（双列网格 + 查看所有产物入口）：
 * 自动汇总本轮写入/修改或脚本生成的真实本地文件，显示类型徽章、文件名与磁盘大小；
 * 点卡片直接在右侧预览面板打开（支持 Office/PDF/Markdown/图片/代码），桌面端 hover 可一键在访达中定位。
 */
export default function DeliverableCards({
  m,
  workspace,
  onPreviewFile,
  onOpenAll,
}: {
  m: ViewMessage;
  workspace?: string | null;
  onPreviewFile?: (path: string) => void;
  onOpenAll?: () => void;
}) {
  const candidates = useMemo(() => extractMessageDeliverables(m), [m]);
  const [stats, setStats] = useState<Record<string, FileStatInfo>>({});

  const pathKey = useMemo(() => candidates.map((c) => c.path).join('\n'), [candidates]);
  useEffect(() => {
    if (!candidates.length) return;
    let cancelled = false;
    void statFiles(candidates.map((c) => c.path), workspace).then((res) => {
      if (!cancelled) setStats(res);
    });
    return () => { cancelled = true; };
  }, [pathKey, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const seenAbs = new Set<string>();
    const out: Array<typeof candidates[number] & { size?: number; absPath: string }> = [];
    for (const c of candidates) {
      const st = stats[c.path];
      // 正文提取的路径必须经磁盘验证真实存在且不是目录，彻底杜绝幻觉/失效卡片
      if (c.source === 'text' && !(st?.exists === true && !st.isDir)) continue;
      // 工具写入的文件若已确认不存在/是目录则隐藏，stat 未返回前先展示
      if (c.source === 'tool' && st && (!st.exists || st.isDir)) continue;
      const absPath = st?.absPath || c.path;
      const norm = absPath.replace(/\\/g, '/');
      if (seenAbs.has(norm)) continue;
      seenAbs.add(norm);
      out.push({ ...c, size: st?.size, absPath });
    }
    return out;
  }, [candidates, stats]);

  if (!items.length) return null;

  const reveal = (window as unknown as { pawDesktop?: { reveal?: (p: string) => void } }).pawDesktop?.reveal;
  const shown = items.slice(0, 6);

  return (
    <div className="deliverable-wrap">
      <div className="deliverable-grid">
        {shown.map((item) => {
          const sizeText = formatFileSize(item.size);
          const ext = extOf(item.name).toUpperCase();
          return (
            <div
              key={item.path}
              className="deliverable-card"
              role="button"
              tabIndex={0}
              title={item.absPath}
              onClick={() => onPreviewFile?.(item.absPath)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPreviewFile?.(item.absPath);
                }
              }}
            >
              <FileBadge name={item.name} size={20} />
              <div className="deliverable-info">
                <div className="deliverable-name">{item.name}</div>
                <div className="deliverable-meta">{sizeText || ext || '文件'}</div>
              </div>
              {reveal && (
                <button
                  type="button"
                  className="deliverable-reveal"
                  title="在访达中显示"
                  aria-label="在访达中显示"
                  onClick={(e) => {
                    e.stopPropagation();
                    reveal(item.absPath);
                  }}
                >
                  <FolderOpen size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {onOpenAll && (
        <button type="button" className="deliverable-all-link" onClick={onOpenAll}>
          <span>查看所有产物 ({items.length})</span>
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}
