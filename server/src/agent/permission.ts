// 按会话工具权限鉴权与审批挂起管理（strict 模式 fail-closed，run_command 禁整工具级会话放行）
import { randomUUID } from 'node:crypto';
import type { PermissionDecision, SessionPermission } from '@paw/shared';
import type { ToolExecutionContext, ToolRuntime } from '@paw/kernel';
import { pawPlugins } from '../plugins/index.js';
import { parseSessionPermission, updateSessionPermission } from '../db.js';

/** 内部控制类工具不弹确认卡（subagent 内部工具执行会继承父会话 authorize） */
const INTERNAL_SAFE_TOOLS = new Set(['todo_write', 'ask_user', 'structured_output', 'subagent']);

export const APPROVAL_TIMEOUT_MS = 300_000;

export function defaultPermission(): SessionPermission {
  return { mode: 'default', allow: [], deny: [] };
}

export function normalizePermission(raw?: SessionPermission): SessionPermission {
  return parseSessionPermission(raw) ?? defaultPermission();
}

export function evaluateToolPermission(
  name: string,
  args: Record<string, unknown>,
  permission: SessionPermission,
): 'allow' | 'deny' | 'ask' {
  if (permission.mode !== 'strict') return 'allow';
  if (permission.deny.includes(name)) return 'deny';
  if (name !== 'run_command' && permission.allow.includes(name)) return 'allow';
  if (INTERNAL_SAFE_TOOLS.has(name)) return 'allow';
  if (pawPlugins.isReadOnly(name)) return 'allow';
  if (name === 'call_api' && !pawPlugins.isMutating('call_api', args)) return 'allow';
  // Fail-closed：所有 mutating 工具、未显式声明 readOnly 的 MCP 工具与外置插件工具默认走确认
  return 'ask';
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
    const verdict = evaluateToolPermission(name, args, current);
    if (verdict === 'allow') return { decision: 'allow' as const };
    if (verdict === 'deny') {
      return { decision: 'deny' as const, reason: '该工具在本会话已被设为禁止', rejectedByUser: true };
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
        finish('deny', '已取消');
      };
      const timer = setTimeout(() => {
        const cur = pendingApprovals.get(approvalId);
        if (!cur || cur.settled) return;
        cur.settled = true;
        pendingApprovals.delete(approvalId);
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
