// 多语言依赖解析器（JS/TS/Vue/Svelte、Python、Java/Kotlin、Go、Rust、C/C++）
// 全部基于单次扫描得到的内存文件集合（ReadonlySet<string>）做 O(1) 路径匹配，零额外磁盘 stat 开销。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CPP_EXTS,
  JS_TS_EXTS,
  PY_EXTS,
  type GoModuleInfo,
  type GoWorkspaceIndex,
  type JsPackageAliasMap,
  type JvmFileMeta,
  type JvmWorkspaceIndex,
  type PyImportRef,
  type RustCrateInfo,
  type RustWorkspaceIndex,
} from './types.js';
import {
  extractIdentifiers,
  extractSfcScripts,
  stripCLikeComments,
  stripJsComments,
  stripPythonCommentsAndStrings,
  stripRustComments,
} from './text.js';

// ============================================================================
// 1. JS / TS / Vue / Svelte 依赖解析器
// ============================================================================

/**
 * 给定去掉或带着后缀的候选绝对路径（如 `/ws/src/foo` 或 `/ws/src/foo.js`），
 * 在内存文件集合 `fileSet` 里按顺序尝试匹配磁盘上真正存在的源码文件：
 *   1) 完全命中；
 *   2) TS ESM 映射：源码里常写 `import './foo.js'`，但磁盘源码其实是 `./foo.ts` / `./foo.tsx`；
 *   3) 补全常见后缀（.ts / .tsx / .js / .vue / .svelte 等）；
 *   4) 目录入口文件（`foo/index.ts`、`foo/index.js` 等）。
 */
export function tryMatchJsFile(baseCandidate: string, fileSet: ReadonlySet<string>): string | null {
  if (fileSet.has(baseCandidate)) return baseCandidate;

  const ext = path.extname(baseCandidate);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') {
    const stem = baseCandidate.slice(0, -ext.length);
    const tsCandidates = ext === '.jsx'
      ? ['.tsx', '.ts']
      : ext === '.mjs'
        ? ['.mts', '.ts']
        : ext === '.cjs'
          ? ['.cts', '.ts']
          : ['.ts', '.tsx', '.mts', '.cts'];
    for (const tsExt of tsCandidates) {
      if (fileSet.has(stem + tsExt)) return stem + tsExt;
    }
  }

  for (const candExt of JS_TS_EXTS) {
    if (fileSet.has(baseCandidate + candExt)) return baseCandidate + candExt;
  }
  for (const idxExt of ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']) {
    const idxFile = path.join(baseCandidate, `index${idxExt}`);
    if (fileSet.has(idxFile)) return idxFile;
  }
  return null;
}

/**
 * 扫描候选子项目目录下的 package.json 与 tsconfig.json，建立两张映射表：
 *   - packages / packageEntries：把 Monorepo 内部包名（如 `@paw/kernel`）映射到 `kernel/src/index.ts`；
 *   - pathPrefixes：把 tsconfig 路径别名（如 `@/* -> src/*`）映射到真实目录数组。
 */
export async function discoverJsAliases(
  candidateDirs: readonly string[],
  fileSet: ReadonlySet<string>,
): Promise<JsPackageAliasMap> {
  const packages = new Map<string, string>();
  const packageEntries = new Map<string, string>();
  const pathPrefixes: Array<{ prefix: string; targetBases: string[] }> = [];

  for (const pkgDir of candidateDirs) {
    try {
      const pkgRaw = await readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { name?: unknown; main?: unknown; module?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.trim()) {
        const pkgName = pkg.name.trim();
        packages.set(pkgName, pkgDir);
        const entryCandidates = [
          path.join(pkgDir, 'src', 'index'),
          path.join(pkgDir, 'index'),
        ];
        for (const rawEntry of [pkg.module, pkg.main]) {
          if (typeof rawEntry === 'string' && rawEntry.trim()) {
            const mappedSrc = rawEntry.replace(/^\.?\/?(?:dist|build|lib)\//, 'src/');
            entryCandidates.unshift(path.resolve(pkgDir, mappedSrc));
            entryCandidates.push(path.resolve(pkgDir, rawEntry));
          }
        }
        for (const c of entryCandidates) {
          const hit = tryMatchJsFile(c, fileSet);
          if (hit) {
            packageEntries.set(pkgName, hit);
            break;
          }
        }
      }
    } catch { /* 无 package.json */ }

    try {
      const tsRaw = await readFile(path.join(pkgDir, 'tsconfig.json'), 'utf-8');
      const cleanJson = stripJsComments(tsRaw).replace(/,\s*([}\]])/g, '$1');
      const ts = JSON.parse(cleanJson) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const baseUrl = path.resolve(pkgDir, ts.compilerOptions?.baseUrl || '.');
      const pathsObj = ts.compilerOptions?.paths || {};
      for (const [pat, targets] of Object.entries(pathsObj)) {
        if (!Array.isArray(targets) || !targets.length) continue;
        if (pat.endsWith('/*')) {
          const prefix = pat.slice(0, -1);
          const targetBases = targets
            .filter((t): t is string => typeof t === 'string' && t.endsWith('/*'))
            .map((t) => path.resolve(baseUrl, t.slice(0, -1)));
          if (targetBases.length) pathPrefixes.push({ prefix, targetBases });
        }
      }
    } catch { /* 无或非标准 tsconfig.json */ }
  }

  return { packages, packageEntries, pathPrefixes };
}

/**
 * 从 JS / TS / Vue / Svelte 源码中提取所有静态/动态导入路径字符串：
 *   - `import ... from 'x'` / `export ... from 'x'`（限定子句只含合法绑定字符，防跨语句误吞）
 *   - 裸副作用导入 `import 'x'`
 *   - 动态导入 `import('x')` 与 CommonJS `require('x')`
 */
export function extractJsSpecifiers(rawCode: string, ext = '.ts'): string[] {
  const source = ext === '.vue' || ext === '.svelte' ? extractSfcScripts(rawCode) : rawCode;
  const code = stripJsComments(source);
  const specs = new Set<string>();

  const patterns = [
    // import/export ... from 'spec'（限定导入子句仅含合法绑定字符，杜绝跨语句回溯或吞并下一行裸 import）
    /\b(?:import|export)\s+(?:type\s+)?[\w*\s{},$]+?\s+from\s*['"]([^'"\r\n]+)['"]/g,
    // 裸副作用导入：import 'spec'
    /\bimport\s*['"]([^'"\r\n]+)['"]/g,
    // 动态 import('spec') 与 CommonJS require('spec')
    /\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1]?.trim();
      if (spec) specs.add(spec);
    }
  }
  return [...specs];
}

export function resolveJsDependency(
  fromFile: string,
  spec: string,
  fileSet: ReadonlySet<string>,
  aliases: JsPackageAliasMap,
): string | null {
  if (spec.startsWith('node:') || /^[a-z]+:\/\//i.test(spec)) return null;

  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    return tryMatchJsFile(base, fileSet);
  }

  for (const { prefix, targetBases } of aliases.pathPrefixes) {
    if (spec.startsWith(prefix)) {
      const rest = spec.slice(prefix.length);
      for (const targetBase of targetBases) {
        const hit = tryMatchJsFile(path.resolve(targetBase, rest), fileSet);
        if (hit) return hit;
      }
    }
  }

  const exactEntry = aliases.packageEntries.get(spec);
  if (exactEntry) return exactEntry;

  for (const [pkgName, pkgDir] of aliases.packages.entries()) {
    if (spec.startsWith(`${pkgName}/`)) {
      const subPath = spec.slice(pkgName.length + 1);
      const hitSrc = tryMatchJsFile(path.resolve(pkgDir, 'src', subPath), fileSet);
      if (hitSrc) return hitSrc;
      const hitDirect = tryMatchJsFile(path.resolve(pkgDir, subPath), fileSet);
      if (hitDirect) return hitDirect;
    }
  }

  return null;
}

// ============================================================================
// 2. Python (.py / .pyi) 依赖解析器
// ============================================================================

/**
 * 提取 Python 导包语句：
 *   1) 先用 stripPythonCommentsAndStrings 清掉 # 注释和三引号 docstring，避免示例文案干扰；
 *   2) 把跨行括号导入 `from .pkg import (\n a,\n b,\n)` 和末尾 `\` 续行拼成完整逻辑行；
 *   3) 解析出相对点号层数（dots=1 表示 `.`，dots=2 表示 `..`）、模块路径和导入名列表。
 */
export function extractPythonImports(rawCode: string): PyImportRef[] {
  const cleaned = stripPythonCommentsAndStrings(rawCode);
  // 合并括号跨行导入与反斜杠续行
  const logicalLines: string[] = [];
  let buf = '';
  let parenDepth = 0;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const trimmedRight = rawLine.replace(/\s+$/, '');
    const continuesWithSlash = trimmedRight.endsWith('\\');
    const chunk = continuesWithSlash ? trimmedRight.slice(0, -1) : trimmedRight;
    buf = buf ? `${buf} ${chunk.trim()}` : chunk.trim();
    for (const ch of chunk) {
      if (ch === '(') parenDepth++;
      else if (ch === ')' && parenDepth > 0) parenDepth--;
    }
    if (parenDepth === 0 && !continuesWithSlash) {
      if (buf) logicalLines.push(buf);
      buf = '';
    }
  }
  if (buf) logicalLines.push(buf);

  const refs: PyImportRef[] = [];
  for (const stmt of logicalLines) {
    for (const clause of stmt.split(';')) {
      const line = clause.trim();
      if (!line) continue;

      const fromMatch = /^from\s+(\.*)\s*([A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
      if (fromMatch) {
        const dots = fromMatch[1].length;
        const mod = fromMatch[2] || '';
        const rawNames = fromMatch[3].replace(/[()]/g, '');
        const names = rawNames
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() || '')
          .filter((s) => s && s !== '*');
        refs.push({ dots, module: mod, names });
        continue;
      }

      const impMatch = /^import\s+(.+)$/.exec(line);
      if (impMatch) {
        for (const p of impMatch[1].split(',')) {
          const mod = p.trim().split(/\s+as\s+/)[0]?.trim();
          if (mod) refs.push({ dots: 0, module: mod, names: [] });
        }
      }
    }
  }
  return refs;
}

/** 把 Python 点分模块名（如 `pkg.util`）映射成磁盘上存在的 `pkg/util.py` 或 `pkg/util/__init__.py` */
function tryMatchPyFile(baseDir: string, modulePath: string, fileSet: ReadonlySet<string>): string | null {
  const rel = modulePath ? modulePath.split('.').join(path.sep) : '';
  const targetBase = rel ? path.resolve(baseDir, rel) : path.resolve(baseDir);
  for (const ext of PY_EXTS) {
    if (rel && fileSet.has(`${targetBase}${ext}`)) return `${targetBase}${ext}`;
  }
  for (const ext of PY_EXTS) {
    const initFile = path.join(targetBase, `__init__${ext}`);
    if (fileSet.has(initFile)) return initFile;
  }
  return null;
}

/** 沿着 __init__.py 向上爬，找出当前 .py 文件所属顶级包的根目录（绝对导入从这里开始找） */
function inferPythonPackageRoot(fromFile: string, fileSet: ReadonlySet<string>): string | null {
  let dir = path.dirname(fromFile);
  let climbed = false;
  while (fileSet.has(path.join(dir, '__init__.py')) || fileSet.has(path.join(dir, '__init__.pyi'))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    climbed = true;
  }
  return climbed ? dir : null;
}

/**
 * 解析单条 Python 导入引用的实际文件列表：
 *   - 相对导入（dots > 0）：按点号个数逐级往上退父目录（`.`=当前目录，`..`=上一级）；
 *   - 绝对导入（dots === 0）：按「包根 → 当前目录 → 工作区/src 根」顺序查找，
 *     同时检查 `from pkg import sub` 里的 `sub` 是不是子模块文件 `pkg/sub.py`。
 */
export function resolvePythonDependencies(
  fromFile: string,
  ref: PyImportRef,
  pySourceRoots: readonly string[],
  fileSet: ReadonlySet<string>,
): string[] {
  const hits: string[] = [];
  let baseDirs: string[];

  if (ref.dots > 0) {
    let cur = path.dirname(fromFile);
    for (let d = 1; d < ref.dots; d++) cur = path.dirname(cur);
    baseDirs = [cur];
  } else {
    const pkgRoot = inferPythonPackageRoot(fromFile, fileSet);
    baseDirs = [
      ...(pkgRoot ? [pkgRoot] : []),
      path.dirname(fromFile),
      ...pySourceRoots,
    ];
  }

  const seenBases = new Set<string>();
  for (const base of baseDirs) {
    const resolvedBase = path.resolve(base);
    if (seenBases.has(resolvedBase)) continue;
    seenBases.add(resolvedBase);

    for (const name of ref.names) {
      const subMod = ref.module ? `${ref.module}.${name}` : name;
      const subHit = tryMatchPyFile(resolvedBase, subMod, fileSet);
      if (subHit) hits.push(subHit);
    }
    if (ref.module || ref.dots > 0) {
      const modHit = tryMatchPyFile(resolvedBase, ref.module, fileSet);
      if (modHit) hits.push(modHit);
    }
    if (hits.length > 0) break;
  }
  return hits;
}

// ============================================================================
// 3. Java & Kotlin (.java / .kt / .kts) 依赖解析器
// ============================================================================
// Java/Kotlin 按「包名 + 类型名（FQCN）」引用，而不是按文件路径引用：
//   - 第一遍（parseJvmFileMeta + buildJvmWorkspaceIndex）：记录每个文件的 `package` 及声明的类型名，
//     建出「全限定类名 com.acme.Order -> 文件路径」和「包名 com.acme -> 包内所有文件」两张反查表；
//   - 第二遍（resolveJvmDependencies）：
//       1) 解析显式 import（含 import static 和通配 import com.acme.*）；
//       2) 检查同 package 下的兄弟文件类名是否出现在本文件标识符里（捕捉同包免 import 引用）。

/** 第一遍扫描单个 Java/Kotlin 文件：提取 `package` 声明与文件内定义的全部类型名（含文件名主干） */
export function parseJvmFileMeta(file: string, rawCode: string): JvmFileMeta {
  const clean = stripCLikeComments(rawCode, { allowBacktick: false, stripStringBodies: true });
  const pkgMatch = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?/m.exec(clean);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  const declared = new Set<string>();
  const stem = path.basename(file, path.extname(file));
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stem)) declared.add(stem);

  const typeRe = /\b(?:class|interface|enum|record|object|typealias|@interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(clean)) !== null) {
    if (m[1]) declared.add(m[1]);
  }
  return { file, pkg, declaredTypes: [...declared] };
}

/** 汇总全部 Java/Kotlin 文件元信息，构建「全限定类名 -> 文件」与「包名 -> 包内文件列表」两张索引表 */
export function buildJvmWorkspaceIndex(metas: readonly JvmFileMeta[]): JvmWorkspaceIndex {
  const byFile = new Map<string, JvmFileMeta>();
  const fqcnToFiles = new Map<string, string[]>();
  const packageToFiles = new Map<string, string[]>();

  for (const meta of metas) {
    byFile.set(meta.file, meta);
    if (meta.pkg) {
      const pkgList = packageToFiles.get(meta.pkg) ?? [];
      pkgList.push(meta.file);
      packageToFiles.set(meta.pkg, pkgList);
    }
    for (const t of meta.declaredTypes) {
      const fqcn = meta.pkg ? `${meta.pkg}.${t}` : t;
      const list = fqcnToFiles.get(fqcn) ?? [];
      if (!list.includes(meta.file)) list.push(meta.file);
      fqcnToFiles.set(fqcn, list);
    }
  }
  return { byFile, fqcnToFiles, packageToFiles };
}

/** 第二遍解析单个 Java/Kotlin 文件的依赖：先查显式 import（含 static/通配/内部类），再查同包免 import 类引用 */
export function resolveJvmDependencies(
  fromFile: string,
  rawCode: string,
  jvmIndex: JvmWorkspaceIndex,
): string[] {
  const clean = stripCLikeComments(rawCode, { allowBacktick: false, stripStringBodies: true });
  const out = new Set<string>();

  // 1. 显式 import（含 Java import static 与 Kotlin import ... as Alias）
  const importRe = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)(?:\s+as\s+[A-Za-z0-9_]+)?\s*;?/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(clean)) !== null) {
    const target = m[1]?.trim();
    if (!target) continue;
    if (target.endsWith('.*')) {
      const pkgPrefix = target.slice(0, -2);
      for (const f of jvmIndex.packageToFiles.get(pkgPrefix) ?? []) {
        if (f !== fromFile) out.add(f);
      }
      // 兼顾 import static com.acme.ConstClass.* 静态通配导入
      for (const f of jvmIndex.fqcnToFiles.get(pkgPrefix) ?? []) {
        if (f !== fromFile) out.add(f);
      }
      continue;
    }

    // 逐级剥离尾部成员（支持 Outer.Inner 或 import static ClassName.method）
    let probe = target;
    while (probe) {
      const matched = jvmIndex.fqcnToFiles.get(probe);
      if (matched?.length) {
        for (const f of matched) if (f !== fromFile) out.add(f);
        break;
      }
      const dot = probe.lastIndexOf('.');
      if (dot < 0) break;
      probe = probe.slice(0, dot);
    }
  }

  // 2. 同 package 内无需显式 import 的类型引用（通过词法标识符集合 O(1) 命中）
  const selfMeta = jvmIndex.byFile.get(fromFile);
  if (selfMeta?.pkg) {
    const siblings = jvmIndex.packageToFiles.get(selfMeta.pkg) ?? [];
    if (siblings.length > 1) {
      const idents = extractIdentifiers(clean);
      for (const sibFile of siblings) {
        if (sibFile === fromFile) continue;
        const sibMeta = jvmIndex.byFile.get(sibFile);
        if (!sibMeta) continue;
        if (sibMeta.declaredTypes.some((typeName) => idents.has(typeName))) {
          out.add(sibFile);
        }
      }
    }
  }

  return [...out];
}

// ============================================================================
// 4. Go (.go + go.mod) 依赖解析器
// ============================================================================
// Go 的 import 目标是「包目录」（而不是单个文件）：
//   1) 读 go.mod 里的 `module example.com/app`，把模块前缀映射到磁盘根目录；
//   2) 遇到 `import "example.com/app/internal/store"` 时，定位到 `internal/store/` 目录下所有非 `_test.go` 文件；
//   3) `*_test.go` 天然依赖同目录下的生产 `.go` 文件，直接连边，同时避免生产文件之间互相成环。

export async function discoverGoWorkspaceIndex(
  manifestDirs: readonly string[],
  goFiles: readonly string[],
): Promise<GoWorkspaceIndex> {
  const modules: GoModuleInfo[] = [];
  for (const dir of manifestDirs) {
    try {
      const modText = await readFile(path.join(dir, 'go.mod'), 'utf-8');
      const m = /^\s*module\s+([^\s/][^\s]*)/m.exec(modText);
      if (m?.[1]) {
        modules.push({ modulePath: m[1].trim().replace(/^['"]|['"]$/g, ''), rootDir: dir });
      }
    } catch { /* 非 go.mod 目录 */ }
  }
  modules.sort((a, b) => b.modulePath.length - a.modulePath.length);

  const dirToProdFiles = new Map<string, string[]>();
  for (const f of goFiles) {
    if (f.endsWith('_test.go')) continue;
    const d = path.dirname(f);
    const list = dirToProdFiles.get(d) ?? [];
    list.push(f);
    dirToProdFiles.set(d, list);
  }
  return { modules, dirToProdFiles };
}

/** 提取 Go 源码中的单行 `import "a/b"` 与分组 `import ( alias "a/b" )` 导入路径 */
export function extractGoImports(rawCode: string): string[] {
  const clean = stripCLikeComments(rawCode, { allowBacktick: true, stripStringBodies: false });
  const specs = new Set<string>();

  // 分组 import ( ... )
  const blockRe = /\bimport\s*\(([\s\S]*?)\)/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(clean)) !== null) {
    const strRe = /["`]([^"`\r\n]+)["`]/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(bm[1])) !== null) {
      if (sm[1]) specs.add(sm[1].trim());
    }
  }

  // 单行 import [alias] "pkg/path"
  const singleRe = /\bimport\s+(?:[A-Za-z0-9_.]+\s+)?["`]([^"`\r\n]+)["`]/g;
  let sm: RegExpExecArray | null;
  while ((sm = singleRe.exec(clean)) !== null) {
    if (sm[1]) specs.add(sm[1].trim());
  }

  return [...specs];
}

/** 解析单个 Go 文件的依赖：先处理 `_test.go` 对同包源码的依赖，再把模块前缀匹配的 import 展开为目标目录下全部非测试 .go 文件 */
export function resolveGoDependencies(
  fromFile: string,
  rawCode: string,
  goIndex: GoWorkspaceIndex,
): string[] {
  const out = new Set<string>();

  // _test.go 天然依赖同包目录下的生产源码文件
  if (fromFile.endsWith('_test.go')) {
    for (const sib of goIndex.dirToProdFiles.get(path.dirname(fromFile)) ?? []) {
      if (sib !== fromFile) out.add(sib);
    }
  }

  for (const spec of extractGoImports(rawCode)) {
    let targetDir: string | null = null;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      targetDir = path.resolve(path.dirname(fromFile), spec);
    } else {
      for (const mod of goIndex.modules) {
        if (spec === mod.modulePath) {
          targetDir = mod.rootDir;
          break;
        }
        if (spec.startsWith(`${mod.modulePath}/`)) {
          const rel = spec.slice(mod.modulePath.length + 1).split('/').join(path.sep);
          targetDir = path.join(mod.rootDir, rel);
          break;
        }
      }
    }
    if (targetDir) {
      for (const f of goIndex.dirToProdFiles.get(targetDir) ?? []) {
        if (f !== fromFile) out.add(f);
      }
    }
  }

  return [...out];
}

// ============================================================================
// 5. Rust (.rs + Cargo.toml) 依赖解析器
// ============================================================================
// Rust 文件间关联分两条线：
//   1) `mod foo;` 模块声明：由父模块（如 lib.rs / net.rs）声明挂载外部子文件（foo.rs 或 foo/mod.rs）；
//   2) `use` 路径树：支持 `crate::`（当前 crate 根）、`self::`、`super::`（上级模块）以及工作区兄弟 crate 名，
//      并会递归展开花括号语法 `use crate::{config::Config, net::{http, self}};`。

export async function discoverRustWorkspaceIndex(
  manifestDirs: readonly string[],
  fileSet: ReadonlySet<string>,
): Promise<RustWorkspaceIndex> {
  const cratesByName = new Map<string, RustCrateInfo>();
  const cratesList: RustCrateInfo[] = [];

  for (const dir of manifestDirs) {
    try {
      const toml = await readFile(path.join(dir, 'Cargo.toml'), 'utf-8');
      const pkgSection = /\[package\]([\s\S]*?)(?:\n\s*\[|$)/.exec(toml)?.[1];
      if (!pkgSection) continue;
      const nameMatch = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(pkgSection);
      if (!nameMatch?.[1]) continue;

      const crateName = nameMatch[1].trim().replace(/-/g, '_');
      const srcDir = path.join(dir, 'src');
      const libRs = path.join(srcDir, 'lib.rs');
      const mainRs = path.join(srcDir, 'main.rs');
      const entryFile = fileSet.has(libRs) ? libRs : (fileSet.has(mainRs) ? mainRs : null);
      const info: RustCrateInfo = { crateName, rootDir: dir, srcDir, entryFile };
      cratesByName.set(crateName, info);
      cratesList.push(info);
    } catch { /* 非 Cargo crate 目录 */ }
  }
  cratesList.sort((a, b) => b.rootDir.length - a.rootDir.length);
  return { cratesByName, cratesList };
}

/** 将 `crate::{a::b, c::{d, self}}` 展开为扁平路径列表 */
function expandRustUseTree(expr: string): string[] {
  const trimmed = expr.trim();
  if (!trimmed) return [];
  const openIdx = trimmed.indexOf('{');
  if (openIdx < 0) {
    const clean = trimmed.split(/\s+as\s+/)[0]?.trim() || '';
    return clean ? [clean] : [];
  }

  // 找到与首个 '{' 配对的顶层 '}'
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx < 0) return [];

  const prefix = trimmed.slice(0, openIdx).replace(/::\s*$/, '').trim();
  const body = trimmed.slice(openIdx + 1, closeIdx);
  // 按顶层逗号切分
  const items: string[] = [];
  let cur = '';
  let d = 0;
  for (const ch of body) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
    if (ch === ',' && d === 0) {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());

  const out: string[] = [];
  for (const item of items) {
    for (const sub of expandRustUseTree(item)) {
      if (sub === 'self') {
        if (prefix) out.push(prefix);
      } else {
        out.push(prefix ? `${prefix}::${sub}` : sub);
      }
    }
  }
  return out;
}

/**
 * 计算某个 Rust 文件声明 `mod sub;` 时子模块的默认查找目录（Rust 2018 规则）：
 *   - lib.rs / main.rs / mod.rs 的子模块就在同级目录；
 *   - 普通文件 `src/net.rs` 的子模块在同名子目录 `src/net/` 下（如 `src/net/http.rs`）。
 */
function rustModuleBaseDir(fromFile: string): string {
  const base = path.basename(fromFile);
  const dir = path.dirname(fromFile);
  if (base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs') return dir;
  // Rust 2018：src/foo.rs 的子模块位于 src/foo/
  return path.join(dir, path.basename(fromFile, '.rs'));
}

/**
 * 沿着 `use` 路径段列表（如 `['config', 'Config']`）从长到短回退匹配 Rust 源文件：
 * 因为最后一段通常是结构体/函数名而非文件名，回退到 `['config']` 就能命中 `config.rs` 或 `config/mod.rs`。
 */
function matchRustModuleChain(baseDir: string, segs: readonly string[], fileSet: ReadonlySet<string>): string | null {
  // 从完整段列表往回缩短（尾部通常是函数/结构体符号名，前段才是模块文件路径）
  for (let len = segs.length; len >= 1; len--) {
    const slice = segs.slice(0, len);
    const targetPath = path.join(baseDir, ...slice);
    if (fileSet.has(`${targetPath}.rs`)) return `${targetPath}.rs`;
    const modRs = path.join(targetPath, 'mod.rs');
    if (fileSet.has(modRs)) return modRs;
  }
  return null;
}

/** 解析单个 Rust 文件的依赖：同时提取 `mod foo;` 外部文件挂载与 `use crate/self/super/兄弟crate` 路径树 */
export function resolveRustDependencies(
  fromFile: string,
  rawCode: string,
  rustIndex: RustWorkspaceIndex,
  fileSet: ReadonlySet<string>,
): string[] {
  const clean = stripRustComments(rawCode);
  const out = new Set<string>();
  const ownerCrate = rustIndex.cratesList.find(
    (c) => fromFile === c.rootDir || fromFile.startsWith(c.rootDir + path.sep),
  );

  // 1. 外部文件模块声明：[#[path = "..."]] [pub] mod xxx;
  const modRe = /(?:#\[\s*path\s*=\s*"([^"]+)"\s*\]\s*)?(?:\bpub(?:\s*\([^)]*\))?\s+)?\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let mm: RegExpExecArray | null;
  const modSearchDir = rustModuleBaseDir(fromFile);
  while ((mm = modRe.exec(clean)) !== null) {
    const customPath = mm[1]?.trim();
    const modName = mm[2]?.trim();
    if (customPath) {
      const absCustom = path.resolve(path.dirname(fromFile), customPath);
      if (fileSet.has(absCustom) && absCustom !== fromFile) out.add(absCustom);
      continue;
    }
    if (!modName) continue;
    const candidates = [
      path.join(modSearchDir, `${modName}.rs`),
      path.join(modSearchDir, modName, 'mod.rs'),
      path.join(path.dirname(fromFile), `${modName}.rs`),
      path.join(path.dirname(fromFile), modName, 'mod.rs'),
    ];
    for (const c of candidates) {
      if (fileSet.has(c) && c !== fromFile) {
        out.add(c);
        break;
      }
    }
  }

  // 2. use 路径树（crate:: / self:: / super:: / 工作区兄弟 crate::）
  const useRe = /\buse\s+([^;]+);/g;
  let um: RegExpExecArray | null;
  while ((um = useRe.exec(clean)) !== null) {
    for (const rawPath of expandRustUseTree(um[1])) {
      const normalized = rawPath.replace(/^::/, '');
      const segs = normalized.split('::').map((s) => s.trim()).filter(Boolean);
      if (!segs.length) continue;

      if (segs[0] === 'crate') {
        const srcBase = ownerCrate?.srcDir ?? path.dirname(fromFile);
        const hit = matchRustModuleChain(srcBase, segs.slice(1), fileSet) ?? ownerCrate?.entryFile ?? null;
        if (hit && hit !== fromFile) out.add(hit);
      } else if (segs[0] === 'self') {
        const hit = matchRustModuleChain(rustModuleBaseDir(fromFile), segs.slice(1), fileSet);
        if (hit && hit !== fromFile) out.add(hit);
      } else if (segs[0] === 'super') {
        let upCount = 0;
        while (segs[upCount] === 'super') upCount++;
        let curDir = rustModuleBaseDir(fromFile);
        for (let k = 0; k < upCount; k++) curDir = path.dirname(curDir);
        const rest = segs.slice(upCount);
        const hit = rest.length
          ? matchRustModuleChain(curDir, rest, fileSet)
          : (fileSet.has(`${curDir}.rs`) ? `${curDir}.rs` : (fileSet.has(path.join(curDir, 'mod.rs')) ? path.join(curDir, 'mod.rs') : null));
        if (hit && hit !== fromFile) out.add(hit);
      } else {
        const targetCrate = rustIndex.cratesByName.get(segs[0]);
        if (targetCrate) {
          const hit = matchRustModuleChain(targetCrate.srcDir, segs.slice(1), fileSet) ?? targetCrate.entryFile;
          if (hit && hit !== fromFile) out.add(hit);
        }
      }
    }
  }

  return [...out];
}

// ============================================================================
// 6. C / C++ (#include 头文件解析器)
// ============================================================================
// 规则：
//   - `#include "local.h"` 优先从当前文件所在目录找，找不到再去 include/、src/ 等根目录找；
//   - `#include <engine/core.hpp>` 优先从工作区 include/、src/ 搜索（标准库头文件不在 fileSet 里，自动跳过）。

export function resolveCppDependencies(
  fromFile: string,
  rawCode: string,
  includeRoots: readonly string[],
  fileSet: ReadonlySet<string>,
): string[] {
  const clean = stripCLikeComments(rawCode, { allowBacktick: false, stripStringBodies: false });
  const out = new Set<string>();
  const incRe = /^\s*#\s*include\s*([<"])([^>"\r\n]+)[>"]/gm;
  let m: RegExpExecArray | null;

  while ((m = incRe.exec(clean)) !== null) {
    const kind = m[1];
    const rel = m[2]?.trim();
    if (!rel) continue;

    const searchBases = kind === '"'
      ? [path.dirname(fromFile), ...includeRoots]
      : [...includeRoots, path.dirname(fromFile)];

    for (const base of searchBases) {
      const cand = path.resolve(base, rel);
      if (fileSet.has(cand) && cand !== fromFile) {
        out.add(cand);
        break;
      }
    }
  }
  return [...out];
}

/** 收集工作区内用于各语言清单/头文件查找的候选子项目目录（含根、1~2 层子目录及 manifest 所在目录） */
export async function collectProjectDirs(
  root: string,
  allSourceFiles: readonly string[],
  skipDirs: ReadonlySet<string>,
): Promise<{
  manifestDirs: string[];
  pyRoots: string[];
  cppIncludeRoots: string[];
}> {
  const dirSet = new Set<string>([root]);
  try {
    const top = await readdir(root, { withFileTypes: true });
    for (const e of top) {
      if (!e.isDirectory() || skipDirs.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(root, e.name);
      dirSet.add(sub);
      const nested = await readdir(sub, { withFileTypes: true }).catch(() => []);
      for (const ne of nested) {
        if (ne.isDirectory() && !skipDirs.has(ne.name) && !ne.name.startsWith('.')) {
          dirSet.add(path.join(sub, ne.name));
        }
      }
    }
  } catch { /* ignore */ }

  const isWithinRoot = (p: string) => p === root || p.startsWith(root + path.sep);

  // 从已发现源码路径反推深层 go.mod / Cargo.toml / package.json 可能所在的模块根目录（向上停在 root）
  for (const f of allSourceFiles) {
    let cur = path.dirname(f);
    while (isWithinRoot(cur)) {
      dirSet.add(cur);
      if (cur === root) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const manifestDirs = [...dirSet];
  const pyRoots = new Set<string>([root, path.join(root, 'src')]);
  const cppIncludeRoots = new Set<string>([root, path.join(root, 'include'), path.join(root, 'src')]);

  for (const d of manifestDirs) {
    const base = path.basename(d);
    if (base === 'src') pyRoots.add(d);
    if (base === 'include' || base === 'src') cppIncludeRoots.add(d);
  }

  // 若存在头文件，将其父目录（遇到 include/ 时取 include/）纳入头文件搜索根
  for (const f of allSourceFiles) {
    const ext = path.extname(f).toLowerCase();
    if ((CPP_EXTS as readonly string[]).includes(ext) && ext.startsWith('.h')) {
      let cur = path.dirname(f);
      while (isWithinRoot(cur)) {
        if (path.basename(cur) === 'include') {
          cppIncludeRoots.add(cur);
          break;
        }
        if (cur === root) break;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
  }

  return {
    manifestDirs,
    pyRoots: [...pyRoots],
    cppIncludeRoots: [...cppIncludeRoots],
  };
}
