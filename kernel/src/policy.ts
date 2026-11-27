// ============================================================================
// 一阶谓词权限规则引擎 + 只读 Shell 命令静态验证器 + 规则冲突形式化检查
// ============================================================================
// 为什么不直接写一堆嵌套 if-else？
//   1. 权限安全边界最怕漏分支或规则互相打架（比如「plan 只读模式」被历史「allow 白名单」绕过）；
//   2. 把每条规则拆成带名字的逻辑谓词（∧ 与、∨ 或、¬ 非、∀ 对全部元素成立、∃ 存在元素成立），
//      不仅一眼能读懂为什么放行/拦截，还能用 `verifyPolicyRuleTable()` 把所有真值组合跑一遍，
//      像数学证明一样在测试里自动抓出「同优先级矛盾」「永远触发不到的死规则」「漏掉的兜底分支」。
import type { SessionPermission } from './types.js';

/** 权限裁决结果：放行 / 直接拒绝 / 弹窗询问用户 */
export type PolicyEffect = 'allow' | 'deny' | 'ask';

/** 单个命名谓词：给一个布尔判断函数起个可读的逻辑名，方便审计与调试 */
export interface Predicate<T> {
  readonly name: string;
  readonly test: (input: T) => boolean;
}

/** 构造原子谓词 */
export function pred<T>(name: string, test: (input: T) => boolean): Predicate<T> {
  return { name, test };
}

/** 逻辑非（¬p） */
export function not<T>(p: Predicate<T>): Predicate<T> {
  return { name: `¬(${p.name})`, test: (x) => !p.test(x) };
}

/** 逻辑与（p1 ∧ p2 ∧ ...）：所有子谓词都为 true 才成立 */
export function and<T>(...ps: Predicate<T>[]): Predicate<T> {
  return {
    name: ps.map((p) => p.name).join(' ∧ '),
    test: (x) => ps.every((p) => p.test(x)),
  };
}

/** 逻辑或（p1 ∨ p2 ∨ ...）：任意一个子谓词为 true 即成立 */
export function or<T>(...ps: Predicate<T>[]): Predicate<T> {
  return {
    name: `(${ps.map((p) => p.name).join(' ∨ ')})`,
    test: (x) => ps.some((p) => p.test(x)),
  };
}

/**
 * 全称量词（∀ e ∈ domain: elemPred(e)）：
 * 集合里的「每一个」元素都满足条件才返回 true。
 * 例：一条管道命令 `git status && rg foo | wc -l` 只有在「每一段子命令都是只读」时才安全。
 */
export function forAll<T, U>(
  domainName: string,
  select: (input: T) => readonly U[],
  elemPred: Predicate<U>,
): Predicate<T> {
  return {
    name: `∀e∈${domainName}: ${elemPred.name}`,
    test: (x) => select(x).every((item) => elemPred.test(item)),
  };
}

/**
 * 存在量词（∃ e ∈ domain: elemPred(e)）：
 * 集合里只要「至少有一个」元素满足条件就返回 true。
 */
export function exists<T, U>(
  domainName: string,
  select: (input: T) => readonly U[],
  elemPred: Predicate<U>,
): Predicate<T> {
  return {
    name: `∃e∈${domainName}: ${elemPred.name}`,
    test: (x) => select(x).some((item) => elemPred.test(item)),
  };
}

// ============================================================================
// 第一部分：Shell 只读命令静态词法与全称谓词验证器
// ============================================================================
// 核心安全原则：Fail-Closed（默认不信任，宁可错杀，绝不漏放）。
//   1. 先手写词法扫描器把整条命令按 |、&&、||、; 切成若干段（同时正确处理单/双引号和转义）；
//   2. 扫描过程中只要在引号外碰到重定向（> / <）、命令替换（$(...) / 反引号）、子 Shell（()/{}）、
//      复杂展开（${...} / $[...]）、后台符（单个 &）或换行，直接判定不安全；
//   3. 再用全称量词 `allSegmentsReadOnly` 逐段检查：每段的可执行程序都在只读白名单内，
//      且没有带会写文件或执行外部命令的危险参数（如 find -delete、rg --pre、git -c、sort -o、tree -o）。

export interface ShellReadOnlyAnalysis {
  safe: boolean;
  /** 切分出来的各段命令及其参数数组，如 [['git', 'status'], ['wc', '-l']] */
  segments: string[][];
  /** 不安全时的具体拦截原因 */
  reason?: string;
}

/** 参数本身无写文件能力的纯只读常用工具白名单 */
const SIMPLE_READONLY_BINS = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file',
  'which', 'whoami', 'uname', 'echo', 'printf', 'true', 'false',
  'basename', 'dirname', 'realpath', 'du', 'df', 'diff', 'jq',
  'grep', 'egrep', 'fgrep', 'cut', 'tr', 'nl',
]);

/** find 命令里会删除文件、写文件或执行任意外部命令的危险选项 */
const FIND_DANGEROUS_FLAGS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fprint', '-fprint0', '-fprintf', '-fls',
]);

/** git 里只读查看仓库状态/历史/差异的子命令 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog',
]);

/** git 全局危险参数前缀（例如 `git -c core.pager=sh log` 会借 pager 执行任意 shell！） */
const GIT_GLOBAL_BLOCK_PREFIXES = [
  '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--output', '--paginate',
];

/** `git branch` 仅允许以下只读查看参数（防止 `git branch new-br` 创建或 `-D` 删除分支） */
const GIT_BRANCH_READONLY_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
  '-l', '--list', '--show-current', '--color', '--no-color',
  '--merged', '--no-merged', '--contains', '--no-contains',
]);

/**
 * 词法切分器：将单行 Shell 命令切分为管道/逻辑连接段，同时做语法级危险字符拦截。
 * 为什么要手写状态机而不用正则 split？
 *   因为 `echo "a > b" | wc -l` 里引号中的 `>` 是普通文本，不是重定向；
 *   而引号外的 `ls > out.txt` 才是写文件重定向。用状态机跟踪单引号/双引号/转义才能准确区分。
 */
export function tokenizeShellSegments(rawCmd: string): { ok: true; segments: string[][] } | { ok: false; reason: string } {
  const cmd = rawCmd.trim();
  if (!cmd) return { ok: false, reason: '空命令' };
  if (/[\r\n\0]/.test(cmd)) return { ok: false, reason: '含多行或控制字符' };

  const segments: string[][] = [];
  let curSeg: string[] = [];
  let curTok = '';
  let hasTok = false;
  let quote: "'" | '"' | null = null; // 当前是否处在单引号或双引号内部

  const flushTok = () => {
    if (hasTok) {
      curSeg.push(curTok);
      curTok = '';
      hasTok = false;
    }
  };
  const flushSeg = (): boolean => {
    flushTok();
    if (!curSeg.length) return false;
    segments.push(curSeg);
    curSeg = [];
    return true;
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    // 状态 1：单引号内部（POSIX 规则下单引号内一切字符都是纯字面量，不会执行命令替换）
    if (quote === "'") {
      if (ch === "'") quote = null;
      else curTok += ch;
      continue;
    }

    // 状态 2：双引号内部（双引号内仍会触发 `...`、$(...) 和 ${...} 展开，必须拦截！）
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '`' || (ch === '$' && (next === '(' || next === '{' || next === '['))) {
        return { ok: false, reason: '双引号内含命令替换或复杂参数展开' };
      }
      if (ch === '\\') {
        if (i + 1 >= cmd.length) return { ok: false, reason: '末尾悬空转义符' };
        curTok += cmd[++i];
        continue;
      }
      curTok += ch;
      continue;
    }

    // 状态 3：普通非引号态
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasTok = true; // 保留空字符串参数 ""
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= cmd.length) return { ok: false, reason: '末尾悬空转义符' };
      curTok += cmd[++i];
      hasTok = true;
      continue;
    }
    // 拦截命令替换、复杂展开、子 Shell、输入输出重定向
    if (ch === '`' || (ch === '$' && (next === '(' || next === '{' || next === '['))) {
      return { ok: false, reason: '含命令替换 $(...) / 反引号或复杂参数展开' };
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      return { ok: false, reason: '含子 Shell 或代码块括号' };
    }
    if (ch === '>' || ch === '<') {
      return { ok: false, reason: '含输入/输出重定向' };
    }
    // && 允许作为连接符分段；单个 & 会放到后台或配合 &> 重定向，一律拦截
    if (ch === '&') {
      if (next === '&') {
        if (!flushSeg()) return { ok: false, reason: '&& 前存在空命令段' };
        i++;
        continue;
      }
      return { ok: false, reason: '含后台执行或重定向符 &' };
    }
    // || 和 | 均作为合法分段符，前后两段都会分别接受只读检查
    if (ch === '|') {
      if (next === '|') {
        if (!flushSeg()) return { ok: false, reason: '|| 前存在空命令段' };
        i++;
        continue;
      }
      if (!flushSeg()) return { ok: false, reason: '管道 | 前存在空命令段' };
      continue;
    }
    if (ch === ';') {
      if (!flushSeg()) return { ok: false, reason: '分号前存在空命令段' };
      continue;
    }
    if (/\s/.test(ch)) {
      flushTok();
      continue;
    }
    curTok += ch;
    hasTok = true;
  }

  if (quote !== null) return { ok: false, reason: '存在未闭合引号' };
  flushTok();
  if (curSeg.length) segments.push(curSeg);
  else if (segments.length > 0 && /[|&;]\s*$/.test(cmd)) {
    return { ok: false, reason: '连接符末尾缺少命令段' };
  }
  if (!segments.length) return { ok: false, reason: '未解析出有效命令段' };
  return { ok: true, segments };
}

/** 专门校验 git 命令段：先过滤全局选项，再按子命令细查是否纯只读 */
function isSafeGitSegment(args: readonly string[]): boolean {
  let idx = 0;
  // 1. 跳过 git 主命令和子命令之间的全局选项（如 `git -C server log`）
  while (idx < args.length) {
    const flag = args[idx];
    if (!flag.startsWith('-')) break;
    if (GIT_GLOBAL_BLOCK_PREFIXES.some((p) => flag === p || flag.startsWith(`${p}=`))) return false;
    if (flag === '--no-pager' || flag === '-P' || flag === '--no-optional-locks' || flag === '--version' || flag === '--help') {
      idx++;
      continue;
    }
    if (flag === '-C') {
      if (idx + 1 >= args.length) return false;
      idx += 2; // -C 后面紧跟一个目录参数，一起跳过
      continue;
    }
    return false; // 未知全局参数一律拒绝
  }
  if (idx >= args.length) return true; // 仅 `git --version` / `git --help`

  const sub = args[idx];
  const subArgs = args.slice(idx + 1);
  // --output 会写补丁文件，--ext-diff 会调用外部 diff 脚本，全部拦截
  if (subArgs.some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff')) {
    return false;
  }

  if (GIT_READONLY_SUBCOMMANDS.has(sub)) return true;

  // `git branch` 必须仅含查看类参数；只有显式带了 -l/--list 才允许后面跟过滤模式
  if (sub === 'branch') {
    let allowPattern = false;
    for (const a of subArgs) {
      if (a === '-l' || a === '--list') {
        allowPattern = true;
        continue;
      }
      if (GIT_BRANCH_READONLY_FLAGS.has(a) || a.startsWith('--sort=') || a.startsWith('--format=') || a.startsWith('--color=')) {
        continue;
      }
      if (!a.startsWith('-') && allowPattern) continue;
      return false;
    }
    return true;
  }

  // `git tag` 只有无参或带 -l/--list 时才只读；否则 `git tag v1.0` 会创建标签
  if (sub === 'tag') {
    if (subArgs.length === 0) return true;
    const hasList = subArgs.includes('-l') || subArgs.includes('--list');
    if (!hasList) return false;
    return subArgs.every((a) =>
      a === '-l' || a === '--list' || a === '-n' || a.startsWith('--sort=') || a.startsWith('--format=') || !a.startsWith('-'));
  }

  return false;
}

/** 单段命令只读判定谓词：检查可执行文件名与各自特有的危险参数 */
const isReadOnlySegmentPredicate: Predicate<readonly string[]> = pred('isReadOnlySegment', (seg) => {
  if (!seg.length) return false;
  const [bin, ...args] = seg;
  // 禁止环境变量前缀注入（如 LD_PRELOAD=evil.so ls）与路径脚本执行（如 ./run.sh、/tmp/x）
  if (!bin || bin.includes('/') || bin.includes('\\') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(bin)) {
    return false;
  }
  if (SIMPLE_READONLY_BINS.has(bin)) return true;

  if (bin === 'rg') {
    // ripgrep 的 --pre 参数会执行外部预处理程序，必须拦截
    return args.every((a) => a !== '--pre' && !a.startsWith('--pre='));
  }
  if (bin === 'sort' || bin === 'tree') {
    // sort -o 与 tree -o 都会把输出直接写入目标文件，必须拦截
    return args.every((a) => a !== '-o' && !a.startsWith('-o') && a !== '--output' && !a.startsWith('--output='));
  }
  if (bin === 'date') {
    // 拦截 date -s / --set 或裸数字（date 12101200 会尝试改系统时间）
    return args.every((a) => a !== '-s' && !a.startsWith('--set') && !/^\d{4,}$/.test(a));
  }
  if (bin === 'uniq') {
    // uniq [input [output]]：传 2 个位置参数时会把结果覆盖写入第 2 个文件
    let afterDashDash = false;
    let positional = 0;
    for (const a of args) {
      if (!afterDashDash && a === '--') { afterDashDash = true; continue; }
      if (!afterDashDash && a.startsWith('-') && a !== '-') continue;
      positional++;
    }
    return positional <= 1;
  }
  if (bin === 'find') {
    return !args.some((a) => FIND_DANGEROUS_FLAGS.has(a));
  }
  if (bin === 'git') {
    return isSafeGitSegment(args);
  }
  return false;
});

/** 全称量词：整条命令切出来的「每一段」都必须通过只读校验 */
const allSegmentsReadOnly = forAll<readonly (readonly string[])[], readonly string[]>(
  'Segments',
  (segs) => segs,
  isReadOnlySegmentPredicate,
);

/** 返回详细的只读判定结果（含切分后的命令段及拒绝原因） */
export function analyzeShellReadOnly(cmd: string): ShellReadOnlyAnalysis {
  const tok = tokenizeShellSegments(cmd);
  if (!tok.ok) return { safe: false, segments: [], reason: tok.reason };
  const safe = allSegmentsReadOnly.test(tok.segments);
  return {
    safe,
    segments: tok.segments,
    ...(safe ? {} : { reason: '包含非只读命令或未加入白名单的参数' }),
  };
}

/** 快捷布尔判断：该 Shell 命令是否已被静态证明为纯只读 */
export function isSafeReadOnlyShellCommand(cmd: string): boolean {
  return analyzeShellReadOnly(cmd).safe;
}

// ============================================================================
// 第二部分：声明式权限规则表与形式化真值表冲突检验
// ============================================================================

/** 传入规则引擎的单次工具调用事实上下文 */
export interface PolicyEvalInput {
  tool: string;
  args: Record<string, unknown>;
  permission: SessionPermission;
  isInternalSafe: boolean;   // 是否内部控制工具（todo_write / ask_user / subagent 等）
  isPluginReadOnly: boolean; // 插件元信息是否显式声明 readOnly: true
  isMcpReadOnly: boolean;    // MCP 工具是否显式声明 annotations.readOnlyHint === true
  isMutatingApi: boolean;    // call_api 的 HTTP 方法是否为写操作（POST/PUT/DELETE 等）
  isReadOnlyShell: boolean;  // run_command 的 cmd 是否通过了上面的全称只读校验
}

/** 单条声明式权限规则：当 `when` 成立时，按 priority 从高到低触发对应 `effect` */
export interface PolicyRule {
  id: string;
  description: string;
  /** 优先级数值越大越先匹配 */
  priority: number;
  when: Predicate<PolicyEvalInput>;
  effect: PolicyEffect;
  reason?: string;
}

/** 权限规则引擎的裁决返回值 */
export interface PolicyVerdict {
  effect: PolicyEffect;
  /** 命中的规则 ID，方便日志追踪与单测断言 */
  matchedRuleId: string;
  reason?: string;
}

// ---- 原子谓词定义（每条规则都由这些小积木拼装而成） ----
const pModeDefault = pred<PolicyEvalInput>('mode=default', (x) => x.permission.mode === 'default');
const pModeStrict = pred<PolicyEvalInput>('mode=strict', (x) => x.permission.mode === 'strict');
const pModePlan = pred<PolicyEvalInput>('mode=plan', (x) => x.permission.mode === 'plan');
const pInDeny = pred<PolicyEvalInput>('tool∈deny', (x) => x.permission.deny.includes(x.tool));
const pInAllow = pred<PolicyEvalInput>('tool∈allow', (x) => x.permission.allow.includes(x.tool));
const pNotRunCommand = pred<PolicyEvalInput>('tool≠run_command', (x) => x.tool !== 'run_command');
const pIsRunCommand = pred<PolicyEvalInput>('tool=run_command', (x) => x.tool === 'run_command');
const pIsCallApi = pred<PolicyEvalInput>('tool=call_api', (x) => x.tool === 'call_api');
const pInternalSafe = pred<PolicyEvalInput>('isInternalSafe', (x) => x.isInternalSafe);
const pPluginReadOnly = pred<PolicyEvalInput>('isPluginReadOnly', (x) => x.isPluginReadOnly);
const pMcpReadOnly = pred<PolicyEvalInput>('isMcpReadOnly', (x) => x.isMcpReadOnly);
const pReadOnlyApi = and(pIsCallApi, pred<PolicyEvalInput>('¬isMutatingApi', (x) => !x.isMutatingApi));
const pForegroundShell = pred<PolicyEvalInput>('¬args.daemon∧¬args.background', (x) => !x.args.daemon && !x.args.background);
const pReadOnlyShell = pred<PolicyEvalInput>('∀seg∈cmd:isReadOnly(seg)', (x) => x.isReadOnlyShell);

export const PLAN_MODE_DENY_REASON = '当前处于只读计划模式，禁止修改操作，请只做调研并输出计划';
export const EXPLICIT_DENY_REASON = '该工具在本会话已被设为禁止';

/**
 * Paw 默认权限规则表（按 priority 从 100 降到 10 依次匹配）：
 *   100: default 模式 -> 全部 allow
 *    90: 命中 deny 黑名单 -> 直接 deny（优先于一切白名单）
 *    80: 内部安全编排工具 -> allow
 *    70: 声明了只读的插件/MCP 工具或 GET 类 call_api -> allow
 *    65: plan 模式下通过全称静态验证的前台只读 Shell 命令 -> allow
 *    60: plan 模式其余一切写操作/未知工具 -> deny（排在 allow 白名单之前，防止历史 allow 绕过只读计划）
 *    50: strict 模式下命中会话 allow 的非 run_command 工具 -> allow
 *    10: strict 模式兜底 -> ask（弹窗请用户逐次确认）
 */
export const DEFAULT_PERMISSION_RULES: readonly PolicyRule[] = [
  {
    id: 'default-mode-allow',
    description: '默认模式下全部放行',
    priority: 100,
    when: pModeDefault,
    effect: 'allow',
  },
  {
    id: 'explicit-session-deny',
    description: '会话 deny 黑名单优先拦截',
    priority: 90,
    when: and(not(pModeDefault), pInDeny),
    effect: 'deny',
    reason: EXPLICIT_DENY_REASON,
  },
  {
    id: 'internal-safe-allow',
    description: '内部安全编排工具（todo_write / ask_user / structured_output / subagent）放行',
    priority: 80,
    when: and(not(pModeDefault), pInternalSafe),
    effect: 'allow',
  },
  {
    id: 'declared-readonly-allow',
    description: '内置只读插件工具、只读 MCP 工具与非变更 GET 类 call_api 放行',
    priority: 70,
    when: and(not(pModeDefault), pNotRunCommand, or(pPluginReadOnly, pMcpReadOnly, pReadOnlyApi)),
    effect: 'allow',
  },
  {
    id: 'verified-readonly-shell-allow',
    description: '只读计划模式下，通过全称谓词静态验证的纯只读前台 Shell 命令安全放行（strict 模式仍保持逐次确认）',
    priority: 65,
    when: and(pModePlan, pIsRunCommand, pForegroundShell, pReadOnlyShell),
    effect: 'allow',
  },
  {
    id: 'plan-mode-block-mutations',
    description: '只读计划模式下拒绝一切其余修改/未知副作用操作（忽略历史 allow 列表）',
    priority: 60,
    when: pModePlan,
    effect: 'deny',
    reason: PLAN_MODE_DENY_REASON,
  },
  {
    id: 'strict-session-allow',
    description: '严格模式下命中会话 allow 白名单的非 run_command 工具放行',
    priority: 50,
    when: and(pModeStrict, pNotRunCommand, pInAllow),
    effect: 'allow',
  },
  {
    id: 'strict-fallback-ask',
    description: '严格模式兜底：所有未证只读的敏感操作逐次询问用户',
    priority: 10,
    when: pModeStrict,
    effect: 'ask',
  },
];

/** 执行权限规则表求值：按 priority 降序找到第一条命中的规则返回 */
export function evaluatePermissionPolicy(
  input: PolicyEvalInput,
  rules: readonly PolicyRule[] = DEFAULT_PERMISSION_RULES,
): PolicyVerdict {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    if (rule.when.test(input)) {
      return {
        effect: rule.effect,
        matchedRuleId: rule.id,
        ...(rule.reason ? { reason: rule.reason } : {}),
      };
    }
  }
  // 终极安全兜底（即使调用方传入了不完整的自定义规则表也不会意外放行）
  return {
    effect: input.permission.mode === 'plan' ? 'deny' : 'ask',
    matchedRuleId: 'fallback-fail-closed',
    ...(input.permission.mode === 'plan' ? { reason: PLAN_MODE_DENY_REASON } : {}),
  };
}

// ============================================================================
// 第三部分：配置冲突诊断 & 真值表形式化模型检验
// ============================================================================

export interface PermissionConfigConflict {
  kind: 'allow_deny_overlap' | 'forbidden_tool_in_allow' | 'allow_shadowed_by_plan_mode';
  tools: string[];
  message: string;
}

/**
 * 静态诊断单个会话的权限配置是否存在逻辑矛盾或失效项（供 PATCH /api/sessions/:id/permission 返回给调用方）：
 *   1. 同一个工具同时出现在 allow 和 deny（交集非空）；
 *   2. run_command 被非法写入了 allow 列表；
 *   3. 当前处于 plan 只读模式，导致历史 allow 列表被整体遮蔽。
 */
export function detectPermissionConflicts(permission: SessionPermission): PermissionConfigConflict[] {
  const conflicts: PermissionConfigConflict[] = [];
  const denySet = new Set(permission.deny);
  const overlap = permission.allow.filter((t) => denySet.has(t));
  if (overlap.length) {
    conflicts.push({
      kind: 'allow_deny_overlap',
      tools: overlap,
      message: `工具同时出现在 allow 与 deny 中（按安全优先由 deny 生效）：${overlap.join(', ')}`,
    });
  }
  const forbidden = permission.allow.filter((t) => t === 'run_command');
  if (forbidden.length) {
    conflicts.push({
      kind: 'forbidden_tool_in_allow',
      tools: forbidden,
      message: `run_command 禁止整工具级会话常驻放行`,
    });
  }
  if (permission.mode === 'plan' && permission.allow.length > 0) {
    conflicts.push({
      kind: 'allow_shadowed_by_plan_mode',
      tools: [...permission.allow],
      message: `当前处于 plan 只读模式，会话 allow 列表中的 ${permission.allow.length} 项暂时不生效`,
    });
  }
  return conflicts;
}

export interface RuleTableVerificationReport {
  valid: boolean;
  /** 同优先级但结论相反（例如同时 allow 和 deny）的矛盾规则对 */
  contradictions: Array<{ ruleA: string; ruleB: string; priority: number; sampleTool: string; mode: SessionPermission['mode'] }>;
  /** 在所有输入组合下都永远无法胜出的「死规则」 */
  deadRules: string[];
  /** 没有任何规则能命中的输入组合数量（应为 0，表示规则表完备） */
  uncoveredCount: number;
}

/**
 * 真值表穷举模型检验（Finite Model Checking）：
 * 枚举 3 种模式 × 6 类代表性工具 × 4 个布尔维度（共 288 种典型场景组合），自动验证规则表满足三条数学性质：
 *   1. 一致性：不存在同优先级且结论冲突的两条规则；
 *   2. 无冗余死规则：每条规则至少存在一种场景能成为首个命中项；
 *   3. 完备性：所有场景组合都有规则覆盖，不会掉进空白区。
 */
export function verifyPolicyRuleTable(
  rules: readonly PolicyRule[] = DEFAULT_PERMISSION_RULES,
): RuleTableVerificationReport {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);
  const modes: SessionPermission['mode'][] = ['default', 'strict', 'plan'];
  const tools = ['read_file', 'write_file', 'run_command', 'call_api', 'todo_write', 'mcp__srv__op'];
  const bools = [false, true];

  const hitRules = new Set<string>();
  const contradictionKeySet = new Set<string>();
  const contradictions: RuleTableVerificationReport['contradictions'] = [];
  let uncoveredCount = 0;

  for (const mode of modes) {
    for (const tool of tools) {
      for (const inAllow of bools) {
        for (const inDeny of bools) {
          for (const daemon of bools) {
            for (const flag of bools) {
              const sample: PolicyEvalInput = {
                tool,
                args: daemon ? { daemon: true } : {},
                permission: {
                  mode,
                  allow: inAllow ? [tool] : [],
                  deny: inDeny ? [tool] : [],
                },
                isInternalSafe: tool === 'todo_write',
                isPluginReadOnly: tool === 'read_file',
                isMcpReadOnly: tool === 'mcp__srv__op' && flag,
                isMutatingApi: tool === 'call_api' ? flag : true,
                isReadOnlyShell: tool === 'run_command' && flag,
              };

              const matched = ordered.filter((r) => r.when.test(sample));
              if (!matched.length) {
                uncoveredCount++;
                continue;
              }
              // 记录首条胜出的规则
              hitRules.add(matched[0].id);

              // 检查同一优先级下是否存在结论打架的两条规则
              for (let i = 0; i < matched.length; i++) {
                for (let j = i + 1; j < matched.length; j++) {
                  if (matched[i].priority !== matched[j].priority) break;
                  if (matched[i].effect !== matched[j].effect) {
                    const key = `${matched[i].id}|${matched[j].id}`;
                    if (!contradictionKeySet.has(key)) {
                      contradictionKeySet.add(key);
                      contradictions.push({
                        ruleA: matched[i].id,
                        ruleB: matched[j].id,
                        priority: matched[i].priority,
                        sampleTool: tool,
                        mode,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const deadRules = ordered.filter((r) => !hitRules.has(r.id)).map((r) => r.id);
  return {
    valid: contradictions.length === 0 && deadRules.length === 0 && uncoveredCount === 0,
    contradictions,
    deadRules,
    uncoveredCount,
  };
}
