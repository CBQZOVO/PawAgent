import { extOf, fileBadgeStyle } from '../lib/file-preview';

/** 聊天里的文件类型徽章（Seti/Material 配色彩色小方块 + 类型缩写），文件夹/图片仍用各自图标 */
export default function FileBadge({ name, size = 12 }: { name: string; size?: number }) {
  const b = fileBadgeStyle(extOf(name));
  return (
    <span className="file-badge" style={{
      backgroundColor: b.color, color: b.fg,
      fontSize: Math.round(size * 0.58), minWidth: Math.round(size * 1.7), height: Math.round(size * 1.15),
    }}>{b.label}</span>
  );
}
