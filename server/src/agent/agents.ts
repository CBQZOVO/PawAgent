// 子代理定义 Paw 宿主适配（加载与格式化在 @paw/kernel）
// 三个来源，同名后覆盖前：server/agents/*.md → ~/pawagent/*.md → <工作区>/.pawagent/*.md
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { formatSubagentsBlock, loadSubagentsFromDirs, type SubagentDef } from '@paw/kernel';
import { getWorkspaceRoot } from '../workspace.js';

export type { SubagentDef };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.resolve(HERE, '../../agents');
const USER_DIR = path.join(os.homedir(), 'pawagent');

export async function loadSubagents(workspace?: string | null): Promise<SubagentDef[]> {
  const ws = workspace === undefined ? await getWorkspaceRoot() : workspace;
  const dirs = [BUILTIN_DIR, USER_DIR, ...(ws ? [path.join(ws, '.pawagent')] : [])];
  return loadSubagentsFromDirs(dirs);
}

export async function loadSubagentsBlock(workspace?: string | null): Promise<string> {
  const defs = await loadSubagents(workspace);
  return formatSubagentsBlock(defs);
}
