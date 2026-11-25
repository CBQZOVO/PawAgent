import { FileText, Image, X } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Schema, type Node } from 'prosemirror-model';
import { splitAttachmentPlaceholders, type Attachment } from '@paw/shared';
import { attachmentKey } from '../../lib/attachments';

const icons = {
  file: renderToStaticMarkup(<FileText size={14} aria-hidden />),
  image: renderToStaticMarkup(<Image size={14} aria-hidden />),
  remove: renderToStaticMarkup(<X size={12} aria-hidden />),
};

export const schema = new Schema({ nodes: {
  doc: { content: 'inline*', whitespace: 'pre' },
  text: { group: 'inline' },
  attachment: {
    group: 'inline', inline: true, atom: true, selectable: true, draggable: true,
    attrs: { name: {}, size: {}, kind: {} },
    leafText: (node) => `@"${node.attrs.name}"`,
    toDOM(node) {
      const chip = document.createElement('span');
      chip.className = 'attachment-token';
      chip.contentEditable = 'false';
      if (node.attrs.kind === 'image') chip.dataset.previewImage = attachmentKey(node.attrs.name, node.attrs.size);
      else chip.title = node.attrs.name;
      chip.innerHTML = node.attrs.kind === 'image' ? icons.image : icons.file;
      const label = document.createElement('span');
      label.textContent = node.attrs.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除 ${node.attrs.name}`);
      remove.innerHTML = icons.remove;
      chip.append(label, remove);
      return chip;
    },
  },
} });

export function attachmentNode({ name, size, kind }: Attachment) {
  return schema.nodes.attachment.create({ name, size, kind });
}

export function documentKeys(doc: Node) {
  const keys = new Set<string>();
  doc.forEach((n) => { if (n.type === schema.nodes.attachment) keys.add(attachmentKey(n.attrs.name, n.attrs.size)); });
  return keys;
}

export function parseDraft(value: string, files: Attachment[]) {
  const segments = splitAttachmentPlaceholders(value, files) ?? (value ? [{ kind: 'text' as const, text: value }] : []);
  return schema.nodes.doc.create(null, segments.map((s) => s.kind === 'text' ? schema.text(s.text) : attachmentNode(s.att)));
}

export function draftText(doc: Node) {
  return doc.textBetween(0, doc.content.size, '');
}
