// ============================================================================
// 会话分叉有根树（Rooted Fork Tree）与最近公共祖先（LCA）算法
// ============================================================================
// 背景：
//   当用户在某条历史消息上点「分叉会话」时，新会话会通过 `forkFrom` 指向父会话与分叉时间点 ts，
//   于是多个关联会话就组成了一棵「有根树」（类似 Git 的分支提交树）：
//
//        Root (原始会话)
//        ├── BranchA (在 t=10 从 Root 分叉)
//        │   └── LeafA1 (在 t=30 从 BranchA 分叉)
//        └── BranchB (在 t=20 从 Root 分叉)
//
// 核心问题：
//   当用户当前在 LeafA1 上工作，想切换到 BranchB，工作区里的文件要怎么恢复？
//   答案：先找到 LeafA1 和 BranchB 的最近公共祖先（LCA = Root），算出它们共享历史的截止时间
//   pivotTs = min(10, 20) = 10：
//     1) 倒序撤销 LeafA1 在 t > 10 之后的独有文件改动（退回到 Root@10 的状态）；
//     2) 正序重放 BranchB 在 t > 10 之后的独有文件改动（前进到 BranchB 的最新状态）。

/** 分叉来源指针：记录「从哪个父会话、哪条消息、哪个时间戳」分叉出来 */
export interface ForkLinkRef {
  sessionId: string;
  messageId: string;
  ts: number;
}

/** 分叉树里的单个会话节点（只需要 id 和可选的 forkFrom 父指针） */
export interface ForkTreeNode {
  id: string;
  forkFrom?: ForkLinkRef;
}

/** LCA 计算结果：供 snapshots.ts 执行跨分支文件撤销（undo）与重放（redo） */
export interface ForkLCAPlan {
  /** 最近公共祖先会话 ID（例如上面例子中的 Root） */
  lcaSessionId: string;
  /**
   * 两条分支在 LCA 上共享历史的截止时间戳。
   * - 小于等于 pivotTs 的快照改动：两边完全相同，不需要动磁盘；
   * - 严格大于 pivotTs 的快照改动：属于各自分支的独有改动，切换时必须先撤销旧分支再重放新分支。
   */
  pivotTs: number;
  /** 从源会话沿父指针一路往上走到 LCA 的路径，含两端：[fromId, ..., lcaId] */
  fromChain: string[];
  /** 从 LCA 一路往下走到目标会话的路径，含两端：[lcaId, ..., toId] */
  toChain: string[];
  /** 源会话与目标会话是否为同一个（相同时不需要做任何文件切换） */
  sameSession: boolean;
}

/** 还原后的树形节点结构（用于前端或工具展示父子分叉层级） */
export interface ForkSubtreeEntry {
  id: string;
  forkFrom?: ForkLinkRef;
  children: ForkSubtreeEntry[];
}

/** 内部结构：上溯祖先链时的每一步 */
interface AncestorStep {
  id: string;
  /**
   * 记录「从这个祖先走向刚才那个子分支」时的分叉时间戳。
   * 例如从 BranchA (forkFrom.ts = 10) 走到 Root，那么 Root 这一步的 childForkTs = 10；
   * 而起点节点自身（还没有往下分叉）用 +Infinity 表示，这样 min(10, +Infinity) = 10。
   */
  childForkTs: number;
}

/**
 * 从 startId 开始，沿着 forkFrom.sessionId 不断向上找父节点，直到根节点为止。
 * 返回示例：对于 LeafA1 -> BranchA(10) -> Root，返回：
 *   [{ id: 'LeafA1', childForkTs: Infinity }, { id: 'BranchA', childForkTs: 30 }, { id: 'Root', childForkTs: 10 }]
 */
function collectAncestors(
  startId: string,
  getNode: (id: string) => ForkTreeNode | null | undefined,
): AncestorStep[] | null {
  const start = getNode(startId);
  if (!start) return null;

  const chain: AncestorStep[] = [{ id: start.id, childForkTs: Number.POSITIVE_INFINITY }];
  // 用 visited 集合防死循环：万一数据库元数据损坏出现 A->B->A，遇到重复 id 立即停止
  const visited = new Set<string>([start.id]);
  let cur: ForkTreeNode | null | undefined = start;

  while (cur?.forkFrom?.sessionId) {
    const parentId = cur.forkFrom.sessionId;
    const forkTs = cur.forkFrom.ts;
    if (visited.has(parentId)) break; // 发现环路，安全截断
    const parent = getNode(parentId);
    if (!parent) break; // 父会话已被用户单独删除，停在当前可达的最高祖先
    visited.add(parentId);
    chain.push({ id: parent.id, childForkTs: forkTs });
    cur = parent;
  }
  return chain;
}

/**
 * 计算两个会话（fromId -> toId）在分叉森林中的最近公共祖先（LCA）及共享快照截止时间 pivotTs。
 *
 * 算法步骤（经典树 LCA 的哈希表双链法，时间复杂度 O(树高)）：
 *   1. 先从 fromId 一路往上走到根，收集所有祖先并记下每个祖先在链中的下标；
 *   2. 再从 toId 一路往上走，第一个在 fromId 祖先表里命中的节点就是「最近公共祖先 LCA」；
 *   3. 两条路径在 LCA 处各自有一个分叉时间 t_A、t_B，取较小值 min(t_A, t_B) 就是两边完全一致的截止时间 pivotTs。
 *
 * 若两个会话毫无亲缘关系（不在同一棵树）或任一会话不存在，返回 null。
 */
export function computeForkLCA(
  fromId: string,
  toId: string,
  getNode: (id: string) => ForkTreeNode | null | undefined,
): ForkLCAPlan | null {
  const fromAnc = collectAncestors(fromId, getNode);
  if (!fromAnc) return null;

  // 特判：自己切自己，直接返回无需改动
  if (fromId === toId) {
    return {
      lcaSessionId: fromId,
      pivotTs: Number.POSITIVE_INFINITY,
      fromChain: [fromId],
      toChain: [toId],
      sameSession: true,
    };
  }

  const toAnc = collectAncestors(toId, getNode);
  if (!toAnc) return null;

  // 建立 from 祖先的快速查找表：sessionId -> 在 fromAnc 数组里的下标
  const fromIndexById = new Map<string, number>();
  for (let i = 0; i < fromAnc.length; i++) {
    fromIndexById.set(fromAnc[i].id, i);
  }

  // 从 toId 往上逐个检查，最先撞到的公共节点就是距离最近的公共祖先（LCA）
  for (let j = 0; j < toAnc.length; j++) {
    const candidate = toAnc[j];
    const i = fromIndexById.get(candidate.id);
    if (i === undefined) continue;

    // 关键公式：如果 BranchA 在 t=10 从 Root 分叉、BranchB 在 t=20 从 Root 分叉，
    // 那么两者共同拥有的历史只到 t=10 为止（10~20 之间的改动只在 Root/BranchB 里，不在 BranchA 里）
    const pivotTs = Math.min(fromAnc[i].childForkTs, candidate.childForkTs);
    const fromChain = fromAnc.slice(0, i + 1).map((x) => x.id);
    const toChain = toAnc.slice(0, j + 1).map((x) => x.id).reverse();
    return {
      lcaSessionId: candidate.id,
      pivotTs,
      fromChain,
      toChain,
      sameSession: false,
    };
  }

  return null;
}

/**
 * 将数据库查出来的扁平会话数组，重新组装成父子嵌套的分叉森林（可能有多棵互不相关的树）。
 * 会自动防御异常数据中的自环或互相引用（把环节点退化为根节点，避免无限递归）。
 */
export function buildSessionForkTree(nodes: readonly ForkTreeNode[]): ForkSubtreeEntry[] {
  // 第一步：为每个节点创建空壳对象，存入 Map 方便 O(1) 查找
  const byId = new Map<string, ForkSubtreeEntry>();
  for (const n of nodes) {
    byId.set(n.id, { id: n.id, forkFrom: n.forkFrom, children: [] });
  }

  const roots: ForkSubtreeEntry[] = [];
  // 第二步：根据 forkFrom.sessionId 把每个子节点挂到对应的父节点 children 下
  for (const n of nodes) {
    const entry = byId.get(n.id)!;
    const parentId = n.forkFrom?.sessionId;
    // 没有父节点、父节点指向自己、或父节点已不在列表中 -> 作为一棵树的根节点
    if (!parentId || parentId === n.id || !byId.has(parentId)) {
      roots.push(entry);
      continue;
    }
    // 检查把 n 挂到 parentId 下面会不会形成环路（沿 parentId 往上找，如果又回到 n 说明成环）
    let cur: string | undefined = parentId;
    const seen = new Set<string>([n.id]);
    let cyclic = false;
    while (cur) {
      if (seen.has(cur)) { cyclic = true; break; }
      seen.add(cur);
      cur = byId.get(cur)?.forkFrom?.sessionId;
    }
    if (cyclic) roots.push(entry);
    else byId.get(parentId)!.children.push(entry);
  }

  // 第三步：同一父节点下的多个分叉按分叉时间先后排序，展示更直观
  for (const entry of byId.values()) {
    entry.children.sort((a, b) => (a.forkFrom?.ts ?? 0) - (b.forkFrom?.ts ?? 0));
  }
  return roots;
}
