// 按会话工具权限鉴权与审批挂起管理：
// 基于 @paw/kernel 的一阶谓词规则表（DEFAULT_PERMISSION_RULES）+ 全称谓词 Shell 只读验证器，
// 支持 default / strict / plan 三种模式及权限配置冲突检查；run_command 保持三重会话放行护栏。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PermissionDecision, SessionPermission } from '@paw/shared';
import {
  analyzeShellReadOnly,
  DEFAULT_PERMISSION_RULES,
  detectPermissionConflicts,
  evaluatePermissionPolicy,
  EXPLICIT_DENY_REASON,
  isSafeReadOnlyShellCommand,
  PLAN_MODE_DENY_REASON,
  verifyPolicyRuleTable,
  type PolicyVerdict,
  type ToolExecutionContext,
  type ToolRuntime,
} from '@paw/kernel';
import { pawPlugins } from '../plugins/index.js';
import { isMcpToolReadOnly } from '../mcp.js';
import { parseSessionPermission, updateSessionPermission } from '../db.js';
import { dataFile, LEGACY_DIRS } from '../paths.js';

export {
  analyzeShellReadOnly,
  DEFAULT_PERMISSION_RULES,
  detectPermissionConflicts,
  EXPLICIT_DENY_REASON,
  isSafeReadOnlyShellCommand,
  PLAN_MODE_DENY_REASON,
  verifyPolicyRuleTable,
};

/** 内部控制类工具不弹确认卡（subagent 内部工具执行会继承父会话 authorize） */
const INTERNAL_SAFE_TOOLS = new Set(['todo_write', 'ask_user', 'structured_output', 'subagent']);

export const APPROVAL_TIMEOUT_MS = 300_000;

/** 全局许可只存工具名，且只作为新会话 allow 的默认值；不追溯已有会话 */
const GLOBAL_PERMISSIONS_FILE = dataFile('permissions.json', LEGACY_DIRS);
/** 这两个工具无法静态判定副作用，服务端强过滤，不能只靠前端隐藏按钮 */
const GLOBAL_FORBIDDEN_TOOLS = new Set(['run_command', 'call_api']);

export function sanitizeGlobalAllow(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || GLOBAL_FORBIDDEN_TOOLS.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

export async function loadGlobalAllow(): Promise<string[]> {
  try {
    const d = JSON.parse(await readFile(GLOBAL_PERMISSIONS_FILE, 'utf-8')) as { allow?: unknown };
    return sanitizeGlobalAllow(d?.allow);
  } catch {
    return [];
  }
}

let globalPermWriteChain: Promise<void> = Promise.resolve();
let globalPermSeq = 0;

export async function saveGlobalAllow(raw: unknown): Promise<string[]> {
  const allow = sanitizeGlobalAllow(raw);
  const run = async () => {
    await mkdir(path.dirname(GLOBAL_PERMISSIONS_FILE), { recursive: true });
    const tmp = `${GLOBAL_PERMISSIONS_FILE}.${process.pid}.${++globalPermSeq}.tmp`;
    await writeFile(tmp, JSON.stringify({ allow }, null, 2) + '\n', 'utf-8');
    await rename(tmp, GLOBAL_PERMISSIONS_FILE);
  };
  const next = globalPermWriteChain.then(run, run);
  globalPermWriteChain = next.catch(() => {});
  await next;
  return allow;
}

export function defaultPermission(): SessionPermission {
  return { mode: 'default', allow: [], deny: [] };
}

export function normalizePermission(raw?: SessionPermission): SessionPermission {
  return parseSessionPermission(raw) ?? defaultPermission();
}

/**
 * 返回某次工具调用的完整权限裁决（含命中的规则 ID 与拒绝提示文案）。
 * 流程：收集当前工具的客观属性（是否内置安全、是否插件/MCP 只读、是否 GET 类 API、
 *       是否通过全称谓词检验的只读 Shell），交给 @paw/kernel 的声明式规则表统一裁决。
 */
export function evaluateToolPermissionVerdict(
  name: string,
  args: Record<string, unknown>,
  permission: SessionPermission,
): PolicyVerdict {
  const isReadOnlyShell = name === 'run_command'
    && typeof args.cmd === 'string'
    && isSafeReadOnlyShellCommand(args.cmd);

  return evaluatePermissionPolicy({
    tool: name,
    args,
    permission,
    isInternalSafe: INTERNAL_SAFE_TOOLS.has(name),
    isPluginReadOnly: pawPlugins.isReadOnly(name),
    isMcpReadOnly: isMcpToolReadOnly(name),
    isMutatingApi: name === 'call_api' ? pawPlugins.isMutating('call_api', args) : true,
    isReadOnlyShell,
  });
}

/** 简化入口：只返回裁决动作（'allow' | 'deny' | 'ask'），兼容既有调用方 */
export function evaluateToolPermission(
  name: string,
  args: Record<string, unknown>,
  permission: SessionPermission,
): 'allow' | 'deny' | 'ask' {
  return evaluateToolPermissionVerdict(name, args, permission).effect;
}

export function formatApprovalPrompt(name: string, args: Record<string, unknown>): { title: string; detail: string } {
  if (name === 'run_command') {
    const cmd = String(args.cmd || '').trim();
    const flag = args.daemon ? '（常驻服务）' : args.background ? '（后台任务）' : '';
    return {
      title: `执行终端命令${flag}`,
      detail: cmd || '(空命令)',
    };
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'delete_file') {
    const action = name === 'write_file' ? '写入文件' : name === 'edit_file' ? '修改文件' : '删除文件';
    const targetPath = String(args.path || '(未指定路径)');
    const extra = name === 'write_file' && typeof args.content === 'string'
      ? `\n内容长度：${args.content.length} 字符`
      : name === 'edit_file' && typeof args.old_text === 'string'
        ? `\n替换片段：${args.old_text.slice(0, 160)}${args.old_text.length > 160 ? '…' : ''}`
        : '';
    return {
      title: `${action}：${targetPath}`,
      detail: `路径：${targetPath}${extra}`,
    };
  }
  if (name === 'call_api') {
    const conn = String(args.connection || '');
    const method = String(args.method || 'GET').toUpperCase();
    const apiPath = String(args.path || '');
    const bodyPreview = args.body !== undefined
      ? `\nBody：${JSON.stringify(args.body).slice(0, 400)}`
      : args.body_file ? `\nBody 文件：${String(args.body_file)}` : '';
    return {
      title: `调用外部接口：${conn} ${method} ${apiPath}`,
      detail: `${conn} · ${method} ${apiPath}${bodyPreview}`,
    };
  }
  let rawJson = '';
  try {
    rawJson = JSON.stringify(args, (k, v) => (/token|secret|password|authorization|cookie|key/i.test(k) ? '[REDACTED]' : v), 2);
  } catch {
    rawJson = String(args);
  }
  return {
    title: `执行工具：${name}`,
    detail: rawJson.length > 800 ? `${rawJson.slice(0, 800)}\n…（已截断）` : rawJson,
  };
}

interface PendingApproval {
  sessionId: string;
  turnId?: string;
  tool: string;
  resolve: (decision: PermissionDecision, reason?: string) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  settled: boolean;
}

const pendingApprovals = new Map<string, PendingApproval>();

export function hasPendingApproval(sessionId: string, turnId?: string): boolean {
  for (const entry of pendingApprovals.values()) {
    if (entry.sessionId !== sessionId || entry.settled) continue;
    if (turnId !== undefined && entry.turnId !== turnId) continue;
    return true;
  }
  return false;
}

export function resolveApproval(
  sessionId: string,
  id: string,
  decision: PermissionDecision,
): { ok: boolean; tool?: string; effectiveDecision?: PermissionDecision } {
  const entry = pendingApprovals.get(id);
  if (!entry || entry.settled || entry.sessionId !== sessionId) {
    return { ok: false };
  }
  // 双重护栏：run_command 即使前端误传 allow_session 也强制降级为 allow_once
  const effectiveDecision: PermissionDecision =
    entry.tool === 'run_command' && decision === 'allow_session' ? 'allow_once' : decision;
  entry.settled = true;
  clearTimeout(entry.timer);
  pendingApprovals.delete(id);
  entry.resolve(effectiveDecision);
  return { ok: true, tool: entry.tool, effectiveDecision };
}

export function cancelPendingApprovals(sessionId?: string, reason = '已取消', turnId?: string): void {
  for (const [id, entry] of [...pendingApprovals.entries()]) {
    if (entry.settled) continue;
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
    if (turnId !== undefined && entry.turnId !== turnId) continue;
    entry.settled = true;
    clearTimeout(entry.timer);
    pendingApprovals.delete(id);
    entry.resolve('deny', reason);
  }
}

export function createSessionAuthorizer(opts: {
  sessionId?: string;
  turnId?: string;
  permission?: SessionPermission;
  timeoutMs?: number;
  onWaitMs?: (ms: number, toolCallId: string) => void;
  onPermissionUpdated?: (perm: SessionPermission) => void;
}): NonNullable<ToolRuntime['authorize']> {
  let current = normalizePermission(opts.permission);
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;

  return async (
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    ctx: ToolExecutionContext,
  ) => {
    const verdict = evaluateToolPermissionVerdict(name, args, current);
    if (verdict.effect === 'allow') return { decision: 'allow' as const };
    if (verdict.effect === 'deny') {
      return {
        decision: 'deny' as const,
        reason: verdict.reason || EXPLICIT_DENY_REASON,
        rejectedByUser: true,
      };
    }

    // 子代理或无人值守模式绝不弹确认卡，直接拒绝以防卡死或绕过 strict
    if ((ctx.depth ?? 0) >= 1 || ctx.unattended) {
      return {
        decision: 'deny' as const,
        reason: '当前会话已开启严格确认模式，子代理/后台任务不可自动执行写入操作',
        rejectedByUser: true,
      };
    }

    const sid = opts.sessionId || ctx.sessionId || 'ephemeral';
    const approvalId = `${sid}:${opts.turnId || 'turn'}:${toolCallId}:${randomUUID().slice(0, 6)}`;
    const { title, detail } = formatApprovalPrompt(name, args);
    const options: PermissionDecision[] = name === 'run_command'
      ? ['allow_once', 'deny', 'deny_session']
      : ['allow_once', 'deny', 'allow_session', 'deny_session'];

    ctx.emit({
      type: 'permission_ask',
      id: approvalId,
      toolCallId,
      tool: name,
      title,
      detail,
      options,
    });

    const startedAt = Date.now();
    const { decision, reason } = await new Promise<{ decision: PermissionDecision; reason?: string }>((resolve) => {
      const finish = (d: PermissionDecision, r?: string) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        opts.onWaitMs?.(Math.max(0, Date.now() - startedAt), toolCallId);
        resolve({ decision: d, reason: r });
      };
      const onAbort = () => {
        const cur = pendingApprovals.get(approvalId);
        if (!cur || cur.settled) return;
        cur.settled = true;
        clearTimeout(cur.timer);
        pendingApprovals.delete(approvalId);
        ctx.emit({ type: 'permission_resolved', id: approvalId, status: 'cancelled' });
        finish('deny', '已取消');
      };
      const timer = setTimeout(() => {
        const cur = pendingApprovals.get(approvalId);
        if (!cur || cur.settled) return;
        cur.settled = true;
        pendingApprovals.delete(approvalId);
        ctx.emit({ type: 'permission_resolved', id: approvalId, status: 'timeout' });
        finish('deny', '等待确认超时');
      }, timeoutMs);
      timer.unref?.();

      pendingApprovals.set(approvalId, {
        sessionId: sid,
        turnId: opts.turnId,
        tool: name,
        resolve: finish,
        timer,
        startedAt,
        settled: false,
      });
      if (ctx.signal?.aborted) {
        onAbort();
      } else {
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
      }
    });

    if (decision === 'allow_session' && name !== 'run_command') {
      const next: SessionPermission = {
        mode: current.mode,
        allow: [...new Set([...current.allow, name])],
        deny: current.deny.filter((t) => t !== name),
      };
      current = next;
      if (opts.sessionId) updateSessionPermission(opts.sessionId, next);
      opts.onPermissionUpdated?.(next);
      ctx.emit({ type: 'permission_updated', permission: next });
      return { decision: 'allow' as const };
    }
    if (decision === 'deny_session') {
      const next: SessionPermission = {
        mode: current.mode,
        allow: current.allow.filter((t) => t !== name),
        deny: [...new Set([...current.deny, name])],
      };
      current = next;
      if (opts.sessionId) updateSessionPermission(opts.sessionId, next);
      opts.onPermissionUpdated?.(next);
      ctx.emit({ type: 'permission_updated', permission: next });
      return { decision: 'deny' as const, reason: '用户已在本会话禁止该工具', rejectedByUser: true };
    }
    if (decision === 'allow_once') {
      return { decision: 'allow' as const };
    }
    return { decision: 'deny' as const, reason: reason || '用户拒绝', rejectedByUser: true };
  };
}
