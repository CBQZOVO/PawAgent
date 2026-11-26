// 组装发给网关的聊天消息：历史引用改写 → 技能注入 → 附件 → 图片转文字，顺序固定。
// 抽成纯函数的原因：原来三段内联代码各自「找最后一条 user 消息」，技能段写入后
// 附件段又从原始 messages 重新复制，导致技能正文被覆盖丢失（用户却看到加载成功）。
import { appendFileSync } from 'node:fs';
import { formatHandoffBlock, type Attachment, type ChatMessage, type HandoffContext } from '@paw/shared';
import { nameKey } from './attachments.js';

export interface ComposeInput {
  messages: ChatMessage[];
  /** 用户选中的技能（SKILL.md 全文已读出） */
  skillBlocks: { id: string; content: string }[];
  /** 用户为这条消息指定的系统连接（已拼好的 <selected_connection> 块） */
  connectionBlock?: string;
  /** 交接会话单（若消息尚未内联 <handoff_context> 时兜底注入） */
  handoff?: HandoffContext;
  attachments: Attachment[];
  /** 非读图模型时由视觉模型生成的描述（与图片附件顺序一一对应） */
  imageDescriptions?: string[];
  /** 模型是否真能读 image_url part */
  canSeeImages: boolean;
  /**
   * 本会话已落盘附件的「原名 → 本机路径（列表按落盘时间升序）」索引（key 见 attachments.ts 的 nameKey）。
   * 历史消息里的 @"原名" 占位按出现顺序依次消费，避免同名文件（如多张 image.png）全部指到最后一张。
   */
  persistedPaths?: Record<string, string | string[]>;
}

export interface ComposeResult {
  messages: ChatMessage[];
  /** 需要走 image_url part 的图片 data URL（非读图模型时为空） */
  imageUrls: string[];
}

/** 对最后一条 user 消息的 content 做变换；没有 user 消息则原样返回 */
function withLastUser(messages: ChatMessage[], fn: (content: string) => string): ChatMessage[] {
  const li = [...messages].reverse().findIndex((m) => m.role === 'user');
  if (li < 0) return messages;
  const idx = messages.length - 1 - li;
  const next = [...messages];
  next[idx] = { ...next[idx], content: fn(next[idx].content) };
  return next;
}

/**
 * 历史消息里的 @"原名" / @image:原名 只是前端存的占位，不带内容也不带路径。
 * 把能对上落盘文件的引用改写成真实本机路径（最后一条 user 消息除外，它走本轮附件逻辑）。
 * 改写只在组装时进行，不回写会话存储——每轮都从同一个索引重新改写，幂等。
 */
function rewriteHistoryRefs(messages: ChatMessage[], persisted: Record<string, string | string[]>): ChatMessage[] {
  const keys = Object.keys(persisted);
  if (!keys.length) return messages;
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  // 按 key 维护消费游标：同名文件（例如多次粘贴的 image.png）按历史出现顺序依次对应各次落盘文件
  const cursors = new Map<string, number>();
  const pick = (name: string): string | undefined => {
    const k = nameKey(name);
    const entry = persisted[k];
    if (!entry) return undefined;
    if (typeof entry === 'string') return entry;
    if (!entry.length) return undefined;
    const idx = cursors.get(k) ?? 0;
    cursors.set(k, idx + 1);
    return entry[Math.min(idx, entry.length - 1)];
  };
  const sub = (text: string) => text
    .replace(/@"([^"]+)"/g, (raw, name: string) => {
      const p = pick(name);
      return p ? `@"${p}"` : raw;
    })
    .replace(/@image(?:#\d+)?:([^\s]+)/g, (raw, name: string) => {
      const p = pick(name);
      return p ? `@"${p}"` : raw;
    });
  return messages.map((m, i) => (i !== lastUser && m.role === 'user' ? { ...m, content: sub(m.content) } : m));
}

/**
 * 文件附件只给模型清单，不把原文塞进 prompt。
 * 用户要内容时由模型调用 document_text / document_outline / read_file；
 * 这样几百 MB 的附件不会变成上下文，二进制也不会被误当文本。
 * 显式引用（name 带目录、行号或占位说明）是用户圈定的小片段，仍按原文注入。
 */
function fileAttachmentBlock(a: Attachment): string {
  if (/\.har$/i.test(a.name)) {
    const hint = a.localPath ? `使用 analyze_har 分析本地文件：${a.localPath}` : '请用户提供服务端可读的 HAR 文件路径，再调用 analyze_har。';
    return `<file name="${a.name}" size="${a.size}">正文未注入对话。${hint} 不要读取或转发原始报文。</file>`;
  }
  const explicitRef = !/^[^/\\]+$/.test(a.name) || a.content.startsWith('（');
  if (explicitRef) return `<file name="${a.name}" mime="${a.mime}" size="${a.size}">\n${a.content}\n</file>`;
  const path = a.localPath ? ` local_path="${a.localPath}"` : '';
  const tool = /\.(pptx?|docx|xlsx?|csv|txt|md|html?|pdf)$/i.test(a.name)
    ? '用户要读原文且没有特殊格式要求时，直接调用 document_text 解析后阅读，不需要使用文档 SKILL；需要 JSON 结果用 document_parse output=json，需要按页/标题组织时调用 document_outline。'
    : /\.(png|jpe?g|bmp|gif|webp)$/i.test(a.name)
      ? '需要看图片内容时调用 read_image 按路径读取。'
      : '需要内容时调用 read_file。';
  return `<file name="${a.name}" mime="${a.mime}" size="${a.size}"${path}>已附加，正文未注入对话。${tool}</file>`;
}

export function composeChatMessages(input: ComposeInput): ComposeResult {
  let messages = [...input.messages];

  // 0. 历史 @ 引用改写成落盘后的真实路径（最后一条 user 消息除外，它走下面的本轮附件逻辑）
  messages = rewriteHistoryRefs(messages, input.persistedPaths ?? {});

  // 1. 技能全文注入最后一条 user 消息开头（基于上一步结果，不重置）
  if (input.skillBlocks.length) {
    const blocks = input.skillBlocks.map((s) => `<skill name="${s.id}">\n${s.content}\n</skill>`);
    messages = withLastUser(messages, (c) =>
      `<selected_skills>\nThe user selected these skills. Follow their instructions strictly.\n${blocks.join('\n\n')}\n</selected_skills>\n\n` + c);
  }

  // 2. 用户指定了系统连接：告诉模型这条消息优先用哪个连接调接口
  if (input.connectionBlock) {
    messages = withLastUser(messages, (c) => `${input.connectionBlock}\n\n` + c);
  }

  // 2.5 交接上下文：若历史消息尚未内联 <handoff_context>，幂等补入最后一条 user 消息开头
  if (input.handoff?.summary?.trim() && !messages.some((m) => m.content.includes('<handoff_context'))) {
    const block = formatHandoffBlock(input.handoff);
    if (block) messages = withLastUser(messages, (c) => `${block}\n\n` + c);
  }

  // 3. 附件：正文里的 `@"文件名"` 占位符**原位**替换 ——
  //    引用一律用落盘后的真实本机路径（图片另带 @image#N 编号，与 image part 顺序一一对应）；
  //    chip 可能夹在文字中间，只有原位替换位置才对；替换不掉的追加到末尾兜底。
  const imageUrls: string[] = [];
  let imgIdx = 0;
  // 按文件名建队列：同一轮附带多张同名附件（如两张 image.png）时按出现顺序依次配对，不互相覆盖
  const byName = new Map<string, Attachment[]>();
  for (const a of input.attachments) {
    const list = byName.get(a.name);
    if (list) list.push(a);
    else byName.set(a.name, [a]);
  }
  const used = new Set<Attachment>();
  // 图片占位符 + image part 必须成对入列：编号就是 image part 的顺序
  const imageRef = (a: Attachment): string => {
    imageUrls.push(a.content); // data:image/...;base64,...
    return `@image#${++imgIdx}:${a.localPath ?? a.name}`;
  };
  const fileRef = (a: Attachment): string => `@"${a.localPath ?? a.name}"\n${fileAttachmentBlock(a)}`;
  messages = withLastUser(messages, (c) => {
    if (!input.attachments.length) return c;
    const inline = c.replace(/@"([^"]+)"/g, (m, name: string) => {
      const list = byName.get(name);
      const a = list?.shift();
      if (!a) return m;
      used.add(a);
      return a.kind === 'image' ? imageRef(a) : fileRef(a);
    });
    const rest = input.attachments.filter((a) => !used.has(a));
    if (!rest.length) return inline;
    const tail = rest.map((a) => a.kind === 'image' ? imageRef(a) : fileRef(a)).join('\n\n');
    return `${inline}\n\n${tail}`;
  });

  // 4. 非读图模型：把视觉模型识别的文字追加进正文，图片不再传 image_url part
  if (imageUrls.length && !input.canSeeImages && input.imageDescriptions?.length) {
    const descText = `\n\n[图片内容（由视觉模型识别）：\n${input.imageDescriptions.join('\n')}\n]`;
    messages = withLastUser(messages, (c) => c + descText);
    imageUrls.length = 0;
  }

  // 调试：仅在显式开启 PAW_DEBUG=1 时将最终 content 落盘，避免默认同步写 /tmp 阻塞事件循环及暴露提示词
  if (process.env.PAW_DEBUG === '1') {
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const debugContent = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
      appendFileSync('/tmp/paw-compose.log', `${new Date().toISOString().slice(11, 23)} atts=${(input.attachments || []).length}\n${debugContent}\n---\n`);
    } catch { /* 调试日志失败不影响主流程 */ }
  }
  return { messages, imageUrls };
}
