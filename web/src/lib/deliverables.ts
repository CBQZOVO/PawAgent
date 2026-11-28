// 从助手消息中提取本轮产出的文件清单（供消息底部产物卡片与右侧文件面板共用）。
// 覆盖两类来源：
//   1. 明确的写文件工具（write_file / edit_file / generate_image），跳过 /tmp 等临时脚本；
//   2. 助手正文中提到的本机绝对路径文件（如 run_command 跑 Python 脚本生成的 .docx / .xlsx / .zip / .pdf）。
import { messageTools, type ViewMessage } from '@paw/shared';

export interface DeliverableCandidate {
  path: string;
  name: string;
  source: 'tool' | 'text';
}

/** 临时脚本/系统目录，不作为面向用户的最终产物展示 */
const EPHEMERAL_PATH_RE = /^(?:\/(?:tmp|private\/tmp|var|dev|etc|usr|System|bin|sbin|proc|sys)\/|[A-Za-z]:\\(?:Windows|Temp)\\)/i;

/** 正文路径提取：只认常见可交付文档/压缩包/图片/数据/代码扩展名，避免误抓路由或版本号 */
const DELIVERABLE_EXT_RE = /\.(?:docx?|xlsx?|pptx?|pdf|csv|tsv|zip|tar\.gz|tgz|rar|7z|png|jpe?g|webp|gif|svg|bmp|md|markdown|txt|json|html?|xml|yaml|yml|xmind|mp3|mp4|wav|py|ts|tsx|js|jsx|java|go|rs|swift|sh|sql)$/i;

/** 匹配反引号内的绝对路径（允许文件名含空格） */
const BACKTICK_ABS_PATH_RE = /`((?:\/(?:Users|home|Volumes|mnt|opt|srv|data)\/[^`\r\n]+?|[A-Za-z]:\\[^`\r\n]+?))`/g;
/** 匹配正文里裸露的绝对路径（不含空白与常见标点） */
const BARE_ABS_PATH_RE = /(?:^|[\s(>「【：:])((?:\/(?:Users|home|Volumes|mnt|opt|srv|data)\/[^\s`"'<>|*?()（）\[\]【】,，。;；:：]+?|[A-Za-z]:\\[^\s`"'<>|*?()（）\[\]【】,，。;；:：]+?))(?=$|[\s)<」】,，。;；])/g;

function cleanPath(raw: string): string {
  return raw.trim().replace(/[.,;:!?。，；：！？]+$/, '');
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function isEphemeralPath(p: string): boolean {
  return EPHEMERAL_PATH_RE.test(p.trim());
}

/** 从一条助手消息中提取去重后的产物候选列表 */
export function extractMessageDeliverables(m: ViewMessage): DeliverableCandidate[] {
  if (m.role !== 'assistant') return [];
  const byKey = new Map<string, DeliverableCandidate>();
  const add = (rawPath: string, source: 'tool' | 'text') => {
    const p = cleanPath(rawPath);
    if (!p || isEphemeralPath(p)) return;
    if (/^https?:\/\//i.test(p)) return;
    if (source === 'text' && !DELIVERABLE_EXT_RE.test(p)) return;
    const key = p.replace(/\\/g, '/');
    if (!byKey.has(key)) {
      byKey.set(key, { path: p, name: baseName(p), source });
    }
  };

  // 1. 优先提取正文中提到的本机产出文件（往往是用户最关心的最终交付物，如 修改稿3.docx / export.zip）
  const texts = m.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && !!b.text.trim())
    .map((b) => b.text);
  const finalText = texts.length ? texts[texts.length - 1] : '';
  if (finalText) {
    for (const m1 of finalText.matchAll(BACKTICK_ABS_PATH_RE)) {
      if (m1[1]) add(m1[1], 'text');
    }
    for (const m2 of finalText.matchAll(BARE_ABS_PATH_RE)) {
      if (m2[1]) add(m2[1], 'text');
    }
  }

  // 2. 再补充本轮明确写入/修改/生成的工具文件
  for (const t of messageTools(m)) {
    if (t.ok === false) continue;
    if (t.name === 'write_file' || t.name === 'edit_file' || t.name === 'generate_image') {
      const p = t.args?.path;
      if (typeof p === 'string' && p.trim()) add(p, 'tool');
    }
  }

  return [...byKey.values()];
}

export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  const gb = mb / 1024;
  return `${Math.round(gb * 10) / 10} GB`;
}
