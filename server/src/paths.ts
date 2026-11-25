// 用户数据目录：~/.paw
//
// **不要**把它放在 app 包里。重新打包安装是 `rm -rf /Applications/Paw.app` + 整包复制，
// 数据放在包内等于每次升级都清空——2026-11-21 就是这么丢了两次会话（先 21:41 一次、
// 再 22:12 一次），用户的工作区和历史全没了。
//
// db、工作区配置、搜索配置都放这里；包内只留代码。
// 首次启动会把旧位置（包内 server/data、server/*.json）的文件搬过来，搬完就不再读旧位置。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 包内 server 目录（HERE = server/dist，编译产物会放在 server/dist/<file>.js） */
const SERVER_DIR = path.resolve(HERE, '..');

/** ~/.paw（测试可用 PAW_DATA_DIR 指到临时目录，别碰真实数据） */
export const DATA_DIR = process.env.PAW_DATA_DIR
  ? path.resolve(process.env.PAW_DATA_DIR)
  : path.join(os.homedir(), '.paw');
mkdirSync(DATA_DIR, { recursive: true });

/**
 * 取数据文件的路径；`~/.paw` 里没有时，从候选旧位置搬一份过来（只搬一次）。
 * @param name 文件名（如 `paw.db`）
 * @param legacyDirs 旧位置所在目录（按优先级）
 */
export function dataFile(name: string, legacyDirs: string[] = []): string {
  const target = path.join(DATA_DIR, name);
  if (!existsSync(target)) {
    for (const dir of legacyDirs) {
      const src = path.join(dir, name);
      try {
        if (existsSync(src)) { copyFileSync(src, target); break; }
      } catch { /* 搬不动就当没有，下面用新文件 */ }
    }
  }
  return target;
}

/** 旧版放数据的地方（打包前 server/data、server/*.json） */
export const LEGACY_DIRS = [path.join(SERVER_DIR, 'data'), SERVER_DIR, path.resolve(process.cwd(), 'data')];
