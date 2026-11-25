// 附件状态管理的纯函数（便于单测覆盖各种增删组合）
import type { Attachment } from '@paw/shared';

export const MAX_ATTACHMENTS = 10;

export function attachmentKey(name: string, size: number) {
  return JSON.stringify([name, size]);
}

export function inlineMediaSrc(content: string, mime: string) {
  if (content.startsWith('data:') || content.startsWith('blob:')) return content;
  return `data:${mime};base64,${content}`;
}

/** 追加附件（自动去重：同名+同大小视为同一个，避免重复粘贴重复添加） */
export function addAttachments(prev: Attachment[], incoming: Attachment[]): Attachment[] {
  const seen = new Set(prev.map((a) => `${a.name}|${a.size}`));
  const fresh = incoming.filter((a) => {
    const k = `${a.name}|${a.size}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...prev, ...fresh].slice(0, MAX_ATTACHMENTS);
}

/** 删除指定下标的附件 */
export function removeAttachment(prev: Attachment[], index: number): Attachment[] {
  if (index < 0 || index >= prev.length) return prev;
  return prev.filter((_, i) => i !== index);
}

/** 清空全部 */
export function clearAttachments(): Attachment[] {
  return [];
}

/** 生成消息里的引用文本（WorkBuddy 格式：图片 @image#N:名，文件 @"名"） */
export function attachmentRefs(atts: Attachment[]): string {
  let imgIdx = 0;
  return atts.map((a) => a.kind === 'image' ? `@image#${++imgIdx}:${a.name}` : `@"${a.name}"`).join(' ');
}

// ── 读文件（输入框、编辑框、拖拽共用）────────────────────────────────
// 只有图片需要 base64（模型要 image_url part）；其它一律按文本读。
// 不靠扩展名白名单猜——白名单永远会漏，.sh 就漏过一次，模型收到的是一串 base64。

/** 二进制嗅探：前 2KB 出现 NUL 或 C0 控制字符就当二进制（\t\n\r\f\v 不算） */
function looksBinary(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 2000));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readOne(f: File): Promise<Attachment> {
  const isSvg = /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
  const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
  let name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  let mime = f.type || 'text/plain';
  let content: string;
  let size = f.size;

  if (isSvg) {
    // 模型厂商不接受 SVG → canvas 渲染成 PNG（2x 缩放）
    try {
      const svgText = await f.text();
      const pngUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = 2;
          const cv = document.createElement('canvas');
          cv.width = (img.width || 300) * scale;
          cv.height = (img.height || 300) * scale;
          cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
      });
      content = pngUrl;
      mime = 'image/png';
      name = name.replace(/\.svg$/i, '.png');
      size = Math.round(pngUrl.length * 0.75);
    } catch {
      content = await f.text();
      return { name, content: content.slice(0, 200000), size, mime: 'text/plain', kind: 'file' as const };
    }
  } else if (isImage || (/\.pdf$/i.test(f.name) && f.size <= 64 * 1024 * 1024)) {
    // 图片给视觉模型；PDF 只用于右侧面板内联预览，composeChatMessages 不会把正文发给模型。
    content = await new Promise<string>((res, reject) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = r.onabort = () => reject(new Error(`读取「${f.name}」失败`));
      r.readAsDataURL(f);
    });
  } else {
    const asText = await f.text();
    content = looksBinary(asText)
      ? `[二进制文件：${f.name}，${humanSize(f.size)}，无法作为文本读取]`
      : asText;
  }

  // Electron 33 移除了 File.path，桌面端改由 preload 暴露 webUtils.getPathForFile；
  // 兼容旧版 Electron 的 File.path。纯浏览器没有本机路径，附件正文不再进模型：文件附件只给模型“文件名、类型、大小、路径”和工具提示；模型需要内容时调用 document_text / document_outline / read_file。文本附件不会再把几百 MB 内容塞进上下文。
  const desktop = (window as unknown as {
    pawDesktop?: { getPathForFile?: (file: File) => string | undefined };
  }).pawDesktop;
  const localPath = desktop?.getPathForFile?.(f) ?? (f as File & { path?: string }).path;
  return {
    name,
    content: isImage || content.startsWith('data:') ? content : content.slice(0, 200000), // 图片/PDF base64 绝不截断
    size, mime, kind: (isImage ? 'image' : 'file') as 'image' | 'file',
    ...(localPath ? { localPath } : {}),
  };
}

/** 读一批文件；图片超 8MB 直接给错误（模型处理不了，不浪费一次请求） */
export async function readFiles(files: File[] | FileList): Promise<{ attachments: Attachment[]; error?: string }> {
  const list = Array.from(files);
  const tooBig = list.find((f) => f.type.startsWith('image/') && f.size > 8 * 1024 * 1024);
  if (tooBig) {
    return { attachments: [], error: `图片「${tooBig.name}」超过 8MB，模型处理不了，请压缩后再传` };
  }
  try {
    return { attachments: await Promise.all(list.map(readOne)) };
  } catch {
    return { attachments: [], error: '附件读取失败，请重新选择文件。' };
  }
}
