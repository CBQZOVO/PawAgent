// read_image 工具：按本机路径读一张图，返回详细文字描述。
//
// 为什么需要：图片只在它所属的那条 user 消息上作为 image part 发给模型。后续**轮次**的历史里
// 这条消息只剩 @"文件名" 文本占位，不再带图——用户说「刚才那张图」时模型其实看不到它。
// 用户发来的图片会先落盘，并把本会话的图片路径清单随消息给模型（见 attachments.ts +
// chat-input.ts），模型要回看就调这个工具。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PawPlugin, ToolSchema } from '@paw/kernel';
import { resolveToolPath } from '../workspace.js';
import { describeImage, READ_IMAGE_PROMPT } from '../vision.js';
import type { ServerToolExecCtx } from './types.js';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};
const MAX_BYTES = 8 * 1024 * 1024;

export const READ_IMAGE_SCHEMA: ToolSchema = {
  name: 'read_image',
  description: 'Read a local image and get a detailed description in Chinese, including every visible piece of text. Use it to re-view an image from earlier in this conversation (the @"..." reference already contains the real local path), or any image you cannot see directly.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or path relative to workspace root' },
      question: { type: 'string', description: '要重点关注什么，例如「报错文案」「分组结构」「表格里的数字」' },
      summary: { type: 'string', description: '用简体中文简述要看图的什么，20字以内' },
    },
    required: ['path'],
  },
};

export const imagePlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'image',
  tools: [
    {
      schema: READ_IMAGE_SCHEMA,
      meta: { readOnly: true, prunable: true },
      execute: async (args, _id, ctx) => {
        const abs = await resolveToolPath(String(args.path), ctx.workspace);
        const st = await stat(abs).catch(() => null);
        if (!st?.isFile()) throw new Error(`图片不存在：${abs}`);
        if (st.size > MAX_BYTES) throw new Error(`图片超过 8MB（${(st.size / 1024 / 1024).toFixed(1)}MB），视觉模型处理不了，请压缩后再读`);
        const mime = MIME_BY_EXT[path.extname(abs).slice(1).toLowerCase()];
        if (!mime) throw new Error(`不支持的图片格式（${path.extname(abs) || '无扩展名'}），仅支持 png/jpg/gif/webp/bmp`);
        if (!ctx.gateway) throw new Error('缺少网关配置，无法调用视觉模型');

        const dataUrl = `data:${mime};base64,${(await readFile(abs)).toString('base64')}`;
        const focus = typeof args.question === 'string' && args.question.trim()
          ? `\n\n用户特别关注：${args.question.trim()}`
          : '';
        return await describeImage(dataUrl, ctx.gateway, ctx.signal, {
          prompt: READ_IMAGE_PROMPT + focus, mainModel: ctx.gateway.model,
        });
      },
    },
  ],
};
