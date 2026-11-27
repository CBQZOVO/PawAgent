// 多语言代码引用有向图共享类型与后缀注册表

export const JS_TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'] as const;
export const PY_EXTS = ['.py', '.pyi'] as const;
export const JVM_EXTS = ['.java', '.kt', '.kts'] as const;
export const GO_EXTS = ['.go'] as const;
export const RUST_EXTS = ['.rs'] as const;
export const CPP_EXTS = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'] as const;

export type SourceLangFamily = 'js-ts' | 'python' | 'jvm' | 'go' | 'rust' | 'cpp';

export const SOURCE_EXT_FAMILY = new Map<string, SourceLangFamily>([
  ...JS_TS_EXTS.map((e) => [e, 'js-ts'] as const),
  ...PY_EXTS.map((e) => [e, 'python'] as const),
  ...JVM_EXTS.map((e) => [e, 'jvm'] as const),
  ...GO_EXTS.map((e) => [e, 'go'] as const),
  ...RUST_EXTS.map((e) => [e, 'rust'] as const),
  ...CPP_EXTS.map((e) => [e, 'cpp'] as const),
]);

export interface WorkspaceDepGraph {
  root: string;
  files: Set<string>;
  /** 正向依赖：u -> Set<v> 表示文件 u 直接引用了文件 v */
  dependencies: Map<string, Set<string>>;
  /** 反向引用：v -> Set<u> 表示文件 v 被文件 u 直接引用（修改 v 会波及 u） */
  dependents: Map<string, Set<string>>;
  edgeCount: number;
  truncated: boolean;
  /** 按语言族统计纳入图谱的源码文件数 */
  languageCounts: Partial<Record<SourceLangFamily, number>>;
}

export interface JsPackageAliasMap {
  /** 包名（如 @paw/kernel）-> 包根目录绝对路径 */
  packages: Map<string, string>;
  /** 包名 -> 主入口文件绝对路径 */
  packageEntries: Map<string, string>;
  /** tsconfig paths 前缀映射（一个前缀可对应多个候选目标目录） */
  pathPrefixes: Array<{ prefix: string; targetBases: string[] }>;
}

export interface PyImportRef {
  /** 相对导包点号数量（0 表示绝对模块名） */
  dots: number;
  module: string;
  names: string[];
}

export interface JvmFileMeta {
  file: string;
  pkg: string;
  declaredTypes: string[];
}

export interface JvmWorkspaceIndex {
  byFile: Map<string, JvmFileMeta>;
  /** 全限定类型名（如 com.acme.order.OrderService）-> 定义该类型的文件列表 */
  fqcnToFiles: Map<string, string[]>;
  /** 包名（如 com.acme.order）-> 包内所有文件 */
  packageToFiles: Map<string, string[]>;
}

export interface GoModuleInfo {
  modulePath: string;
  rootDir: string;
}

export interface GoWorkspaceIndex {
  /** 按 modulePath 长度降序排列，优先匹配嵌套子模块 */
  modules: GoModuleInfo[];
  /** 目录绝对路径 -> 该目录下非 _test.go 的生产源码文件 */
  dirToProdFiles: Map<string, string[]>;
}

export interface RustCrateInfo {
  /** Cargo crate 规范名（短横线转下划线，如 my_core） */
  crateName: string;
  rootDir: string;
  srcDir: string;
  /** lib.rs 或 main.rs 入口路径 */
  entryFile: string | null;
}

export interface RustWorkspaceIndex {
  cratesByName: Map<string, RustCrateInfo>;
  /** 按 rootDir 长度降序排列，定位某个 .rs 所属的最近 crate */
  cratesList: RustCrateInfo[];
}
