import type { PawPlugin } from '@paw/kernel';
import { GIT_TOOL_SCHEMAS, executeGitTool } from '../tools/git.js';
import type { ServerToolExecCtx } from './types.js';

const READ_ONLY_GIT = new Set(['git_status', 'git_diff', 'git_log']);
const MUTATING_GIT = new Set(['git_commit', 'git_branch', 'git_stash']);
const PRUNABLE_GIT = new Set(['git_diff', 'git_log']);

export const gitPlugin: PawPlugin<ServerToolExecCtx> = {
  name: 'git',
  tools: GIT_TOOL_SCHEMAS.map((schema) => ({
    schema,
    meta: {
      readOnly: READ_ONLY_GIT.has(schema.name),
      mutating: MUTATING_GIT.has(schema.name),
      prunable: PRUNABLE_GIT.has(schema.name),
    },
    execute: (args, _id, ctx) => executeGitTool(schema.name, args, ctx.workspace, ctx.signal),
  })),
};
