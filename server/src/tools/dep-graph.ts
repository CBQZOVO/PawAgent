// 多语言代码引用有向图（File Dependency Graph）与多跳 BFS 可达闭包影响面分析：
// 支持 6 大语言生态：
// - JS / TS / Vue / Svelte（含 TypeScript ESM .js→.ts、tsconfig paths、Monorepo 跨包引用）
// - Python（.py / .pyi，支持跨行括号导入、docstring/注释剔除、__init__.py 包层级与 src 布局）
// - Java / Kotlin（.java / .kt / .kts，支持 package 索引、静态/通配/内部类导入及同包隐式类型引用）
// - Go（.go + 多模块 go.mod 包路径解析、分组 import 与 _test.go 同包关联）
// - Rust（.rs + Cargo.toml 多 crate 工作区、Rust 2018 mod 子模块规则与嵌套 use {...} 展开）
// - C / C++（.c/.cpp/.h/.hpp 等 #include 本地与 include/ 头文件解析）
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolSchema } from '@paw/shared';
import { bfsReachableClosure, findDirectedCycles, type ReachableNode } from '@paw/kernel';
import { getWorkspaceRoot, resolveToolPath } from '../workspace.js';
import {
  SOURCE_EXT_FAMILY,
  type JvmFileMeta,
  type SourceLangFamily,
  type WorkspaceDepGraph,
} from './dep-graph/types.js';
import { stripJsComments } from './dep-graph/text.js';
import {
  buildJvmWorkspaceIndex,
  collectProjectDirs,
  discoverGoWorkspaceIndex,
  discoverJsAliases,
  discoverRustWorkspaceIndex,
  extractJsSpecifiers,
  extractPythonImports,
  parseJvmFileMeta,
  resolveCppDependencies,
  resolveGoDependencies,
  resolveJsDependency,
  resolveJvmDependencies,
  resolvePythonDependencies,
  resolveRustDependencies,
  tryMatchJsFile,
} from './dep-graph/resolvers.js';

export { stripJsComments, extractJsSpecifiers, extractPythonImports };
export type { WorkspaceDepGraph, SourceLangFamily };

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle', 'out',
  'vendor', 'cmake-build-debug', 'cmake-build-release', 'bin', 'obj',
]);

const MAX_GRAPH_FILES = 5000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 16;

const LANG_LABELS: Record<SourceLangFamily, string> = {
  'js-ts': 'JS/TS',
  python: 'Python',
  jvm: 'Java/Kotlin',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C/C++',
};

export const ANALYZE_CODE_IMPACT_SCHEMA: ToolSchema = {
  name: 'analyze_code_impact',
  description: 'Build a lightweight static import/reference directed graph across the workspace '
    + '(supports JS/TS/Vue/Svelte, Python, Java/Kotlin, Go, Rust, and C/C++) and compute multi-hop BFS reachability closure for one or more files. '
    + 'Use `dependents` (reverse BFS) to see every upstream file directly or transitively impacted when modifying target file(s); '
    + 'use `dependencies` (forward BFS) to trace downstream modules imported by target file(s); '
    + 'also detects circular reference cycles in the reachable subgraph.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target file path (absolute, or relative to workspace root) to analyze',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional multiple target file paths when analyzing a batch of changed files together',
      },
      direction: {
        type: 'string',
        enum: ['dependents', 'dependencies', 'both'],
        description: 'BFS traversal direction: "dependents" (who imports target), "dependencies" (what target imports), or "both" (default)',
      },
      max_depth: {
        type: 'number',
        description: 'Max BFS hop depth (1-15, default 4)',
      },
      scope: {
        type: 'string',
        description: 'Optional root directory to bound graph construction (defaults to workspace root)',
      },
      summary: {
        type: 'string',
        description: '用简体中文简述本次调用的目的，20字以内',
      },
    },
  },
};

async function collectSourceFiles(
  dir: string,
  budget: { left: number; truncated: boolean },
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || budget.left <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (signal?.aborted) return;
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collectSourceFiles(full, budget, out, signal);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (SOURCE_EXT_FAMILY.has(ext)) {
        budget.left--;
        out.push(full);
      }
    }
  }
}

/**
 * 构建工作区多语言代码依赖有向图（分两阶段执行，避免重复读盘）：
 *   阶段 1：递归扫描源码文件（跳过 node_modules / .git / target 等产物目录），并发读入内存；
 *           同时按语言建立辅助索引（JS 包别名、Go 的 go.mod、Rust 的 Cargo.toml、Java/Kotlin 的 package-类名表）。
 *   阶段 2：纯内存解析每个文件的引用关系，写入正向表 `dependencies`（我依赖谁）和反向表 `dependents`（谁依赖我）。
 */
export async function buildWorkspaceDepGraph(
  rootDir: string,
  signal?: AbortSignal,
): Promise<WorkspaceDepGraph> {
  const root = path.resolve(rootDir);
  const fileList: string[] = [];
  const budget = { left: MAX_GRAPH_FILES, truncated: false };
  await collectSourceFiles(root, budget, fileList, signal);

  const files = new Set<string>(fileList);
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const languageCounts: Partial<Record<SourceLangFamily, number>> = {};

  const goFiles: string[] = [];
  let hasJs = false;
  let hasGo = false;
  let hasRust = false;
  let hasJvm = false;

  for (const f of fileList) {
    dependencies.set(f, new Set());
    dependents.set(f, new Set());
    const fam = SOURCE_EXT_FAMILY.get(path.extname(f).toLowerCase());
    if (fam) {
      languageCounts[fam] = (languageCounts[fam] ?? 0) + 1;
      if (fam === 'js-ts') hasJs = true;
      else if (fam === 'go') { hasGo = true; goFiles.push(f); }
      else if (fam === 'rust') hasRust = true;
      else if (fam === 'jvm') hasJvm = true;
    }
  }

  // 第一阶段：并发读取全部纳入图谱的文本源码（避免 Java/Kotlin 等双阶段语言重复读盘）
  const contents = new Map<string, string>();
  let readCursor = 0;
  const readers = Array.from({ length: Math.min(READ_CONCURRENCY, Math.max(1, fileList.length)) }, async () => {
    while (readCursor < fileList.length && !signal?.aborted) {
      const file = fileList[readCursor++];
      try {
        const st = await stat(file);
        if (st.size > MAX_SOURCE_BYTES) continue;
        const text = await readFile(file, 'utf-8');
        if (!text.includes('\u0000')) contents.set(file, text);
      } catch { /* 跳过无权限或瞬时删除文件 */ }
    }
  });
  await Promise.all(readers);

  const { manifestDirs, pyRoots, cppIncludeRoots } = await collectProjectDirs(root, fileList, SKIP_DIRS);

  const [jsAliases, goIndex, rustIndex] = await Promise.all([
    hasJs ? discoverJsAliases(manifestDirs, files) : Promise.resolve({ packages: new Map(), packageEntries: new Map(), pathPrefixes: [] }),
    hasGo ? discoverGoWorkspaceIndex(manifestDirs, goFiles) : Promise.resolve({ modules: [], dirToProdFiles: new Map() }),
    hasRust ? discoverRustWorkspaceIndex(manifestDirs, files) : Promise.resolve({ cratesByName: new Map(), cratesList: [] }),
  ]);

  let jvmIndex = buildJvmWorkspaceIndex([]);
  if (hasJvm) {
    const jvmMetas: JvmFileMeta[] = [];
    for (const [file, text] of contents.entries()) {
      if (SOURCE_EXT_FAMILY.get(path.extname(file).toLowerCase()) === 'jvm') {
        jvmMetas.push(parseJvmFileMeta(file, text));
      }
    }
    jvmIndex = buildJvmWorkspaceIndex(jvmMetas);
  }

  // 第二阶段：纯内存解析各语言导包与引用边
  for (const [file, content] of contents.entries()) {
    if (signal?.aborted) break;
    const ext = path.extname(file).toLowerCase();
    const fam = SOURCE_EXT_FAMILY.get(ext);
    if (!fam) continue;

    let resolvedDeps: string[] = [];
    switch (fam) {
      case 'js-ts': {
        for (const spec of extractJsSpecifiers(content, ext)) {
          const dep = resolveJsDependency(file, spec, files, jsAliases);
          if (dep && dep !== file) resolvedDeps.push(dep);
        }
        break;
      }
      case 'python': {
        for (const ref of extractPythonImports(content)) {
          for (const dep of resolvePythonDependencies(file, ref, pyRoots, files)) {
            if (dep !== file) resolvedDeps.push(dep);
          }
        }
        break;
      }
      case 'jvm': {
        resolvedDeps = resolveJvmDependencies(file, content, jvmIndex);
        break;
      }
      case 'go': {
        resolvedDeps = resolveGoDependencies(file, content, goIndex);
        break;
      }
      case 'rust': {
        resolvedDeps = resolveRustDependencies(file, content, rustIndex, files);
        break;
      }
      case 'cpp': {
        resolvedDeps = resolveCppDependencies(file, content, cppIncludeRoots, files);
        break;
      }
    }

    const outSet = dependencies.get(file)!;
    for (const dep of resolvedDeps) {
      if (dep === file || !files.has(dep)) continue;
      outSet.add(dep);
      dependents.get(dep)?.add(file);
    }
  }

  let edgeCount = 0;
  for (const set of dependencies.values()) edgeCount += set.size;

  return {
    root,
    files,
    dependencies,
    dependents,
    edgeCount,
    truncated: budget.truncated,
    languageCounts,
  };
}

function formatRel(root: string, absPath: string): string {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function formatClosureSection(
  title: string,
  nodes: ReachableNode[],
  root: string,
  arrow: '<-' | '->',
): string {
  if (!nodes.length) return `### ${title}\n（无）`;
  const byDepth = new Map<number, ReachableNode[]>();
  for (const n of nodes) {
    const arr = byDepth.get(n.depth) ?? [];
    arr.push(n);
    byDepth.set(n.depth, arr);
  }
  const lines: string[] = [`### ${title}（共 ${nodes.length} 个文件）`];
  for (const [depth, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const label = depth === 1 ? '1 跳（直接关联）' : `${depth} 跳（传递关联）`;
    lines.push(`- **${label}**（${group.length}）：`);
    for (const item of group) {
      const chain = item.path.map((p) => formatRel(root, p)).join(` ${arrow} `);
      lines.push(`  - \`${item.node}\`  _(路径: ${chain})_`);
    }
  }
  return lines.join('\n');
}

/**
 * `analyze_code_impact` 工具执行入口：
 *   1. 把用户传入的 target / targets（支持绝对路径、相对路径、无后缀模块名、Go/Python 包目录）解析成图里的起始种子节点；
 *   2. 按 direction 跑多源 BFS 可达闭包：
 *        - dependents（反向 BFS）：改了这些文件，1 跳/2 跳…会波及哪些上游调用方；
 *        - dependencies（正向 BFS）：这些文件直接/间接依赖了哪些下游模块；
 *   3. 在可达子图上顺带跑一次三色 DFS 环检测，把循环引用一并标出来。
 */
export async function executeAnalyzeCodeImpact(
  args: Record<string, unknown>,
  workspace?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const wsRoot = workspace ?? await getWorkspaceRoot();
  const scopeDir = typeof args.scope === 'string' && args.scope.trim()
    ? await resolveToolPath(args.scope.trim(), wsRoot)
    : path.resolve(wsRoot || process.cwd());

  const rawTargets: string[] = [];
  if (typeof args.target === 'string' && args.target.trim()) rawTargets.push(args.target.trim());
  if (Array.isArray(args.targets)) {
    for (const t of args.targets) {
      if (typeof t === 'string' && t.trim()) rawTargets.push(t.trim());
    }
  }
  if (!rawTargets.length) {
    throw new Error('请至少提供 target 或 targets 参数（待分析的目标文件路径）');
  }

  const direction = args.direction === 'dependents' || args.direction === 'dependencies' || args.direction === 'both'
    ? args.direction
    : 'both';
  const maxDepth = Math.min(15, Math.max(1, Math.floor(Number(args.max_depth) || 4)));

  const t0 = Date.now();
  const graph = await buildWorkspaceDepGraph(scopeDir, signal);
  const resolvedSeeds: string[] = [];
  const missingTargets: string[] = [];

  for (const raw of rawTargets) {
    const abs = await resolveToolPath(raw, wsRoot);
    if (graph.files.has(abs)) {
      if (!resolvedSeeds.includes(abs)) resolvedSeeds.push(abs);
      continue;
    }
    const jsMatched = tryMatchJsFile(abs, graph.files);
    if (jsMatched) {
      if (!resolvedSeeds.includes(jsMatched)) resolvedSeeds.push(jsMatched);
      continue;
    }
    // 支持传入无后缀多语言路径或包目录（如 Go 包目录 internal/store、Python 包目录）
    let extMatched = false;
    for (const ext of SOURCE_EXT_FAMILY.keys()) {
      if (graph.files.has(abs + ext)) {
        if (!resolvedSeeds.includes(abs + ext)) resolvedSeeds.push(abs + ext);
        extMatched = true;
        break;
      }
    }
    if (extMatched) continue;

    const dirPrefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
    const directInDir = [...graph.files].filter((f) => path.dirname(f) === abs || (f.startsWith(dirPrefix) && !f.slice(dirPrefix.length).includes(path.sep)));
    if (directInDir.length > 0) {
      for (const f of directInDir) {
        if (!resolvedSeeds.includes(f)) resolvedSeeds.push(f);
      }
      continue;
    }
    missingTargets.push(abs);
  }

  if (!resolvedSeeds.length) {
    throw new Error(`目标文件不在已扫描的源码图中（扫描根目录: ${graph.root}）：${missingTargets.join(', ')}`);
  }

  const langSummary = (Object.entries(graph.languageCounts) as Array<[SourceLangFamily, number]>)
    .filter(([, n]) => n > 0)
    .map(([fam, n]) => `${LANG_LABELS[fam]} ${n}`)
    .join(' / ');

  const sections: string[] = [
    `## 代码引用图与影响面分析`,
    `- 扫描范围：\`${graph.root}\`（源码文件 ${graph.files.size} 个${langSummary ? ` [${langSummary}]` : ''}${graph.truncated ? '，已达上限截断' : ''}，引用有向边 ${graph.edgeCount} 条，耗时 ${Date.now() - t0}ms）`,
    `- 起始种子（${resolvedSeeds.length}）：${resolvedSeeds.map((s) => `\`${s}\``).join('、')}`,
    `- 搜索最大跳数：${maxDepth}`,
  ];
  if (missingTargets.length) {
    sections.push(`- 未纳入源码图的目标（已跳过）：${missingTargets.map((m) => `\`${m}\``).join('、')}`);
  }

  const touchedSubgraph = new Set<string>(resolvedSeeds);

  if (direction === 'dependents' || direction === 'both') {
    const impacted = bfsReachableClosure(
      resolvedSeeds,
      (u) => [...(graph.dependents.get(u) ?? [])],
      maxDepth,
    );
    for (const x of impacted) touchedSubgraph.add(x.node);
    sections.push(formatClosureSection('上游受影响文件（反向 BFS：谁直接/间接引用了目标）', impacted, graph.root, '<-'));
  }

  if (direction === 'dependencies' || direction === 'both') {
    const deps = bfsReachableClosure(
      resolvedSeeds,
      (u) => [...(graph.dependencies.get(u) ?? [])],
      maxDepth,
    );
    for (const x of deps) touchedSubgraph.add(x.node);
    sections.push(formatClosureSection('下游依赖文件（正向 BFS：目标直接/间接引用了谁）', deps, graph.root, '->'));
  }

  const cycles = findDirectedCycles(
    [...touchedSubgraph],
    (u) => [...(graph.dependencies.get(u) ?? [])].filter((v) => touchedSubgraph.has(v)),
    10,
  );
  if (cycles.length > 0) {
    sections.push(
      `### ⚠️ 可达子图内检测到循环引用（${cycles.length} 条）\n`
      + cycles.map((ring) => `- ${ring.map((p) => `\`${formatRel(graph.root, p)}\``).join(' → ')}`).join('\n'),
    );
  }

  return sections.join('\n\n');
}
