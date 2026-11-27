// ============================================================================
// 有向图（Directed Graph / DAG）通用算法库（零外部依赖）
// ============================================================================
// 包含四个在 Agent 运行时里直接落地的经典图论算法：
//   1. 三色标记 DFS 环检测（detectCycles / findDirectedCycles）
//      -> 用于拦截 Todo 清单循环依赖、检测代码里的循环 import；
//   2. Kahn 分层拓扑排序（topologicalLayers）
//      -> 把有前置依赖的任务/工具调用拆成一批批「同层可并行」的执行波次（Wave）；
//   3. Bernstein 读写冲突条件工具并发调度（scheduleToolBatches）
//      -> 自动识别单轮里哪些文件编辑互不冲突（可并行）、哪些碰了同一个文件（必须先后排队）；
//   4. 多源 BFS 最短路径可达闭包（bfsReachableClosure）
//      -> 用于代码影响面分析：从修改的文件出发，按 1 跳、2 跳… 查出所有受波及的上下游文件。

/** 悬空依赖描述：节点 id 声明依赖了 missing，但整个图里根本找不到 missing */
export interface MissingDependency {
  id: string;
  missing: string;
}

/** 分层拓扑排序的结果 */
export interface TopologicalLayersResult<T> {
  /**
   * 按执行波次分好的节点二维数组：
   * - layers[0] 是所有前置依赖为空（入度=0）的节点，可以立刻一起并行跑；
   * - layers[1] 是只依赖 layers[0] 的节点，等第 0 波跑完后可以一起并行跑；以此类推。
   */
  layers: T[][];
  /** 如果图里有环，这里列出具体环路路径，例如 ['stepA', 'stepB', 'stepA'] */
  cycles: string[][];
  /** 引用了不存在节点 ID 的错误依赖清单 */
  missingDeps: MissingDependency[];
}

/**
 * 在「节点 -> 依赖列表」模型上检测有向环。
 * 示例：a 依赖 b，b 又依赖 a，返回 [['a', 'b', 'a']]。
 */
export function detectCycles<T>(
  items: readonly T[],
  getId: (item: T) => string,
  getDeps: (item: T) => readonly string[],
): string[][] {
  const validIds = new Set(items.map(getId));
  const depsMap = new Map<string, string[]>();
  for (const item of items) {
    const id = getId(item);
    // 去重并忽略不存在的依赖 id（悬空依赖由 missingDeps 单独报告）
    const deps = [...new Set(getDeps(item))].filter((d) => validIds.has(d));
    depsMap.set(id, deps);
  }
  return findDirectedCycles([...validIds], (id) => depsMap.get(id) ?? []);
}

/**
 * 经典「三色标记法」深度优先搜索（DFS）找有向环。
 *
 * 颜色含义：
 *   - 0（白色）：还没访问过；
 *   - 1（灰色）：正在当前递归调用栈里（还没回溯完）；
 *   - 2（黑色）：它和它所有能到达的子图都已经彻底检查完，安全无环。
 *
 * 核心直觉：
 *   DFS 往前走时，如果从当前节点 u 指向了一个「灰色（颜色=1）」节点 v，
 *   说明 v 正躺在当前递归栈里还没退出，我们绕了一圈又回到 v 了 —— 这就找到了一个环！
 */
export function findDirectedCycles(
  nodes: readonly string[],
  getNeighbors: (node: string) => readonly string[],
  maxCycles = 20,
): string[][] {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];                  // 记录当前 DFS 走过的路径
  const stackIndex = new Map<string, number>(); // 快速查某个灰色节点在 stack 里的下标
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();      // 去重：A->B->A 和 B->A->B 其实是同一个环

  /**
   * 规范化环路签名用于去重：
   * 把环 [B, C, A, B] 去掉末尾重复点得到 [B, C, A]，旋转成字典序最小的 [A, B, C] -> "A->B->C"，
   * 这样无论 DFS 从 A、B 还是 C 先进入，得到的签名都一模一样，不会重复报错。
   */
  const canonicalCycleKey = (ring: string[]): string => {
    const core = ring.slice(0, -1);
    if (!core.length) return '';
    let best = core.join('->');
    for (let i = 1; i < core.length; i++) {
      const rotated = [...core.slice(i), ...core.slice(0, i)].join('->');
      if (rotated < best) best = rotated;
    }
    return best;
  };

  const dfs = (u: string) => {
    if (cycles.length >= maxCycles) return;
    // 进栈：标灰
    color.set(u, 1);
    stackIndex.set(u, stack.length);
    stack.push(u);

    for (const v of getNeighbors(u)) {
      if (cycles.length >= maxCycles) break;
      const c = color.get(v) ?? 0;
      if (c === 1) {
        // 撞到灰色节点：截取栈里从 v 到当前栈顶的一段，再拼上 v，就得到完整闭环
        const startIdx = stackIndex.get(v);
        if (startIdx !== undefined) {
          const ring = [...stack.slice(startIdx), v];
          const key = canonicalCycleKey(ring);
          if (key && !seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(ring);
          }
        }
      } else if (c === 0) {
        // 白色节点：继续深入递归
        dfs(v);
      }
    }

    // 出栈：标黑（彻底检查完毕）
    stack.pop();
    stackIndex.delete(u);
    color.set(u, 2);
  };

  for (const n of nodes) {
    if ((color.get(n) ?? 0) === 0) {
      dfs(n);
      if (cycles.length >= maxCycles) break;
    }
  }
  return cycles;
}

/**
 * Kahn 分层拓扑排序（按波次剥洋葱）：
 *
 * 思路：
 *   1. 统计每个节点有几个「未完成的前置依赖」，叫做它的入度（inDegree）；
 *   2. 把所有入度为 0 的节点挑出来，组成当前波次 frontier（它们互不依赖，可以一起并发）；
 *   3. 把这一波节点移除后，通知所有在等它们的下游节点把入度减 1；入度降到 0 的进入下一波；
 *   4. 如果最后排出来的节点总数 < 总节点数，说明剩下的节点互相卡死成了环，调用 detectCycles 把环找出来。
 */
export function topologicalLayers<T>(
  items: readonly T[],
  getId: (item: T) => string,
  getDeps: (item: T) => readonly string[],
): TopologicalLayersResult<T> {
  const byId = new Map<string, T>();
  const orderIndex = new Map<string, number>(); // 记录原始顺序，让同一波次内保持输入顺序
  items.forEach((item, idx) => {
    const id = getId(item);
    byId.set(id, item);
    orderIndex.set(id, idx);
  });

  const missingDeps: MissingDependency[] = [];
  const inDegree = new Map<string, number>();     // 节点 id -> 还需要等待多少个前置节点
  const dependents = new Map<string, string[]>(); // 前置节点 id -> 正在等它的下游节点列表

  for (const item of items) {
    const id = getId(item);
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  // 建图：如果 item 依赖 dep，则连一条有向边 dep -> item，并给 item 的入度 +1
  for (const item of items) {
    const id = getId(item);
    const uniqueDeps = [...new Set(getDeps(item))];
    for (const dep of uniqueDeps) {
      if (!byId.has(dep)) {
        missingDeps.push({ id, missing: dep });
        continue;
      }
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dep)!.push(id);
    }
  }

  const layers: T[][] = [];
  // 第一波：挑出所有入度为 0（没有任何前置依赖）的去重节点
  let frontier = [...byId.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0);

  let scheduledCount = 0;
  while (frontier.length > 0) {
    // 按输入时的先后下标排好序，保证结果稳定可预测
    frontier.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    layers.push(frontier.map((id) => byId.get(id)!));
    scheduledCount += frontier.length;

    // 模拟当前波次执行完毕：把下游节点的入度逐个减 1，减到 0 的进入下一波
    const nextFrontier: string[] = [];
    for (const u of frontier) {
      for (const v of dependents.get(u) ?? []) {
        const nextDeg = (inDegree.get(v) ?? 1) - 1;
        inDegree.set(v, nextDeg);
        if (nextDeg === 0) nextFrontier.push(v);
      }
    }
    frontier = nextFrontier;
  }

  // 如果有节点永远没能进波次（入度一直 > 0），说明存在循环依赖
  const cycles = scheduledCount < byId.size
    ? detectCycles(items, getId, getDeps)
    : [];

  return { layers, cycles, missingDeps };
}

// ============================================================================
// Bernstein 读写冲突条件与工具并发波次调度
// ============================================================================
// 经典并发理论（Bernstein's Conditions）：
//   操作 A（读集合 R_A、写集合 W_A）与操作 B（读集合 R_B、写集合 W_B）可以安全并行，
//   当且仅当以下三种冲突全部不存在：
//     - WAW（写后写）：W_A ∩ W_B ≠ ∅  （两个操作改同一个文件）
//     - RAW（写后读）：W_A ∩ R_B ≠ ∅  （A 刚写完文件，B 要读最新内容）
//     - WAR（读后写）：R_A ∩ W_B ≠ ∅  （A 还没读完，B 不能先把它改掉）
//
// 举例：模型一轮同时发出 [edit a.ts, edit b.ts, read a.ts]：
//   - edit a.ts 与 edit b.ts 读写集合不相交 -> 无冲突边 -> 第 1 波一起并行改！
//   - edit a.ts 与 read a.ts 满足 RAW 冲突 -> 连边 0 -> 2 -> read a.ts 自动排到第 2 波！

export interface ToolResourceAccess {
  /** 执行通道：subagent 走子代理专用并发池（上限4），normal 走普通工具并发池（上限10） */
  lane?: 'subagent' | 'normal';
  /** 读取的资源键集合；例如 ['file:/abs/a.ts']；'*' 表示会读取工作区任意文件（如 search_content） */
  reads: string[];
  /** 写入的资源键集合；空数组表示纯只读；'*' 表示全局写屏障（如未知副作用的 run_command） */
  writes: string[];
}

export interface ScheduledToolBatch<T> {
  lane: 'subagent' | 'normal';
  items: T[];
}

/** 判断两个资源键集合是否有交集；空集与任何集合（包括 '*'）都不冲突 */
function resourceSetsConflict(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes('*') || b.includes('*')) return true;
  const setB = new Set(b);
  return a.some((k) => setB.has(k));
}

/** 根据 Bernstein 条件判断先后两个工具调用是否存在因果冲突 */
function accessesConflict(a: ToolResourceAccess, b: ToolResourceAccess): boolean {
  if (resourceSetsConflict(a.writes, b.writes)) return true; // WAW：写写冲突
  if (resourceSetsConflict(a.writes, b.reads)) return true;  // RAW：写后读冲突
  if (resourceSetsConflict(a.reads, b.writes)) return true;  // WAR：读后写冲突
  // 子代理与带写副作用的常规工具之间也强制保序，避免子代理探查读到写了一半的目录
  const laneA = a.lane ?? 'normal';
  const laneB = b.lane ?? 'normal';
  if (laneA !== laneB && (a.writes.length > 0 || b.writes.length > 0)) return true;
  return false;
}

/**
 * 将单轮模型吐出的工具调用列表切分成「波次序列」：
 *   1. 对任意一对原始顺序 i < j 的调用，如果存在读写冲突就加一条有向边 i -> j；
 *      （因为边永远只从小数指向大数，所以这张图天然无环，一定是 DAG）
 *   2. 跑一次分层拓扑排序，同一层内的调用彼此无冲突，可以放心地并发执行；
 *   3. 如果同一层里混了 subagent 和普通只读工具，按通道拆成两个相邻批次，分别交给对应并发池。
 */
export function scheduleToolBatches<T>(
  items: readonly T[],
  getAccess: (item: T) => ToolResourceAccess,
): ScheduledToolBatch<T>[] {
  if (!items.length) return [];

  const accesses = items.map(getAccess);
  const indexed = items.map((item, idx) => ({ idx, id: String(idx), item, access: accesses[idx] }));
  const depsByIdx = new Map<string, string[]>();

  // 逐对检查 i < j 是否冲突，构造因果依赖边
  for (let j = 0; j < indexed.length; j++) {
    const deps: string[] = [];
    for (let i = 0; i < j; i++) {
      if (accessesConflict(indexed[i].access, indexed[j].access)) {
        deps.push(indexed[i].id);
      }
    }
    depsByIdx.set(indexed[j].id, deps);
  }

  const { layers } = topologicalLayers(
    indexed,
    (x) => x.id,
    (x) => depsByIdx.get(x.id) ?? [],
  );

  // 把每一层按执行通道（subagent / normal）拆分为可直接执行的批次
  const batches: ScheduledToolBatch<T>[] = [];
  for (const layer of layers) {
    const subItems = layer.filter((x) => (x.access.lane ?? 'normal') === 'subagent').map((x) => x.item);
    const normItems = layer.filter((x) => (x.access.lane ?? 'normal') !== 'subagent').map((x) => x.item);
    const firstLane = layer[0]?.access.lane ?? 'normal';
    if (firstLane === 'subagent') {
      if (subItems.length) batches.push({ lane: 'subagent', items: subItems });
      if (normItems.length) batches.push({ lane: 'normal', items: normItems });
    } else {
      if (normItems.length) batches.push({ lane: 'normal', items: normItems });
      if (subItems.length) batches.push({ lane: 'subagent', items: subItems });
    }
  }
  return batches;
}

// ============================================================================
// 多源有向图 BFS 可达闭包（用于代码引用影响面分析）
// ============================================================================

/** BFS 搜索到的一个关联节点及其最短传播路径 */
export interface ReachableNode {
  node: string;
  /** 距离起始文件（种子）的最短跳数：1 = 直接引用，2 = 隔一层间接引用，以此类推 */
  depth: number;
  /** 从起始种子到该节点的最短路径，如 ['math.ts', 'index.ts', 'service.ts'] */
  path: string[];
}

/**
 * 标准广度优先搜索（BFS）：从 seeds（可以同时传多个修改文件）出发，
 * 一层一层往外扩散，最多扩散 maxDepth 跳。
 * 因为 BFS 天然按「跳数从小到大」访问节点，第一次遇到某节点时记录的 path 必然是最短传播链。
 */
export function bfsReachableClosure(
  seeds: readonly string[],
  getNeighbors: (node: string) => readonly string[],
  maxDepth = 4,
): ReachableNode[] {
  const limit = Math.max(1, Math.floor(maxDepth));
  const seedSet = new Set(seeds);
  // visited 记录已入队的节点，防止图里有环或菱形依赖时重复访问
  const visited = new Set<string>(seeds);
  // 队列初始化：所有种子文件都在第 0 层
  const queue: Array<{ node: string; depth: number; path: string[] }> = seeds.map((s) => ({
    node: s,
    depth: 0,
    path: [s],
  }));
  const result: ReachableNode[] = [];

  // 用游标 head 代替 queue.shift()，避免 O(n) 数组搬移，保证整体 O(V + E)
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.depth >= limit) continue; // 已达到最大跳数，不再继续往外扩展
    // 对邻居排序，确保每次运行输出顺序稳定确定
    const neighbors = [...getNeighbors(cur.node)].sort();
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      const nextDepth = cur.depth + 1;
      const nextPath = [...cur.path, next];
      if (!seedSet.has(next)) {
        result.push({ node: next, depth: nextDepth, path: nextPath });
      }
      queue.push({ node: next, depth: nextDepth, path: nextPath });
    }
  }
  return result;
}
