import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment } from '@paw/shared';
import { attachmentKey, inlineMediaSrc } from '../lib/attachments';

const GAP = 8;
const MAX_SIDE = 288;

export default function AttachmentHoverArea({ className, attachments, children }: {
  className: string;
  attachments: Attachment[];
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const image = anchor && attachments.find((a) => a.kind === 'image' && a.content && attachmentKey(a.name, a.size) === anchor.dataset.previewImage);
  const rect = image && anchor.getBoundingClientRect();
  const above = rect ? rect.top - GAP * 2 : 0;
  const below = rect ? window.innerHeight - rect.bottom - GAP * 2 : 0;
  const placeAbove = above >= MAX_SIDE || above >= below;

  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  return <div className={className}
    onPointerOver={(e) => {
      if (e.pointerType === 'touch' || e.buttons || !(e.target instanceof Element)) return;
      const chip = e.target.closest('button') ? null : e.target.closest<HTMLElement>('[data-preview-image]');
      if (chip?.dataset.previewImage !== anchor?.dataset.previewImage) setWidth(0);
      setAnchor(chip);
    }}
    onPointerOut={(e) => {
      if (anchor && !(e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget))) setAnchor(null);
    }}
    onPointerDownCapture={() => setAnchor(null)} onDragStartCapture={() => setAnchor(null)}>
    {children}
    {image && rect && Math.max(above, below) > 0 && createPortal(
      <img key={anchor.dataset.previewImage} className="attachment-hover-preview" src={inlineMediaSrc(image.content, image.mime || 'image/png')}
        alt={image.name} draggable={false}
        onLoad={(e) => setWidth(e.currentTarget.offsetWidth)} onError={() => setAnchor(null)}
        style={{
          visibility: width ? 'visible' : 'hidden',
          maxWidth: Math.min(MAX_SIDE, window.innerWidth - GAP * 2),
          maxHeight: Math.min(MAX_SIDE, placeAbove ? above : below),
          left: Math.max(GAP, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - GAP)),
          top: placeAbove ? rect.top - GAP : rect.bottom + GAP,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }} />, document.body)}
  </div>;
}
