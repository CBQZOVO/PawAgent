// 超长工具输出全文落盘：被三档裁剪去掉的中段保留在 ~/.paw/truncated/，
// 裁剪提示里带上绝对路径，模型需要时用 read_file 读回（resolveToolPath 对绝对路径放行）。
// 只在裁剪真正发生时才写、同步写、失败静默降级为原有提示，不影响主流程。
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';

const TRUNCATED_DIR = path.join(DATA_DIR, 'truncated');
/** 滚动保留的份数上限：超出删最旧（文件名以时间戳开头，字典序即时间序） */
const MAX_FILES = 100;

const safeToolName = (name?: string): string =>
  (name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

/** 惰性解析：测试可用 PAW_DATA_DIR 指到临时目录（与 officeDataDir 同一约定） */
function truncatedDir(): string {
  return process.env.PAW_DATA_DIR
    ? path.join(path.resolve(process.env.PAW_DATA_DIR), 'truncated')
    : TRUNCATED_DIR;
}

/** 保存全文并返回拼进裁剪提示的续读说明；失败返回空串（回退到原有提示） */
export function saveTruncatedOutput(full: string, toolName?: string): string {
  try {
    const dir = truncatedDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeToolName(toolName)}.txt`,
    );
    writeFileSync(file, full, 'utf-8');
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
        unlinkSync(path.join(dir, f));
      }
    } catch { /* 清理失败不影响本次保存 */ }
    return `完整输出已保存到 ${file}（自动保留最近 ${MAX_FILES} 份），需要中段内容时用 read_file 读取该文件`;
  } catch {
    return '';
  }
}
