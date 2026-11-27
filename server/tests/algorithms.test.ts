// 四项核心数据结构与离散数学能力集成测试：
// 1. 会话分叉有根树 + LCA 跨分支工作区文件状态切换（含用户手改保护）；
// 2. 一阶谓词权限引擎 + 全称量词只读 Shell 验证器 + 冲突检查 + plan 模式；
// 3. Todo 依赖 DAG 拓扑分层、环检测与内核无冲突文件并发写入；
// 4. 代码引用有向图（TS ESM .js->.ts、Monorepo 包、Python、注释剔除、循环引用）+ 多跳 BFS 闭包。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(tmpdir(), 'paw-algo-data-'));
const workDir = await mkdtemp(path.join(tmpdir(), 'paw-algo-ws-'));
process.env.PAW_DATA_DIR = dataDir;

const {
  recordFileChange,
  revertWorkspaceTo,
  forkSnapshotRecords,
  switchSessionWorkspace,
  rollbackAfter,
  deleteSnapshots,
} = await import('../src/snapshots.js');
const {
  evaluateToolPermission,
  evaluateToolPermissionVerdict,
  detectPermissionConflicts,
  verifyPolicyRuleTable,
  isSafeReadOnlyShellCommand,
  PLAN_MODE_DENY_REASON,
  EXPLICIT_DENY_REASON,
} = await import('../src/agent/permission.js');
const { executeTodoWrite } = await import('../src/tools/todo.js');
const { buildWorkspaceDepGraph, executeAnalyzeCodeImpact } = await import('../src/tools/dep-graph.js');
const { createPawToolRuntime } = await import('../src/agent/loop.js');
const { upsertSession, getSession, parseSessionPermission } = await import('../src/db.js');

try {
  // ---------------- 1. 会话分叉树与 LCA 跨分支切换 ----------------
  {
    const fileA = path.join(workDir, 'alpha.ts');
    const fileB = path.join(workDir, 'beta.ts');

    // Root 会话：先写 alpha=v1，再写 alpha=v2 & 创建 beta=b1
    await writeFile(fileA, 'v1', 'utf-8');
    const t1 = (await recordFileChange('root', fileA, null, 'v1'))!;
    await writeFile(fileA, 'v2', 'utf-8');
    await recordFileChange('root', fileA, 'v1', 'v2');
    await writeFile(fileB, 'b1', 'utf-8');
    await recordFileChange('root', fileB, null, 'b1');

    // 从 t1 时刻分叉出 branch-1：工作区非破坏性回退到 t1（alpha=v1，beta 删除），继承 <= t1 快照
    const rev = await revertWorkspaceTo('root', t1);
    assert.equal(rev.restored.length, 2);
    assert.equal(await readFile(fileA, 'utf-8'), 'v1');
    assert.equal(await readFile(fileB, 'utf-8').catch(() => null), null);
    await forkSnapshotRecords('root', 'branch-1', t1);

    // branch-1 独有改动：alpha=v1-branch1
    await writeFile(fileA, 'v1-branch1', 'utf-8');
    await recordFileChange('branch-1', fileA, 'v1', 'v1-branch1');

    upsertSession({
      id: 'root',
      title: 'Root',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'init' }], ts: t1 }],
      updatedAt: Date.now(),
    });
    upsertSession({
      id: 'branch-1',
      title: 'Branch 1',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'init' }], ts: t1 }],
      updatedAt: Date.now(),
      forkFrom: { sessionId: 'root', messageId: 'm1', ts: t1 },
    });

    // 从 branch-1 切回 root：LCA = root, pivotTs = t1 → 撤销 branch-1 的 v1-branch1，重放 root 的 v2 与 beta=b1
    const swToRoot = await switchSessionWorkspace('branch-1', 'root', (id) => getSession(id));
    assert.equal(swToRoot.switched, true);
    assert.equal(swToRoot.lcaSessionId, 'root');
    assert.equal(swToRoot.pivotTs, t1);
    assert.equal(await readFile(fileA, 'utf-8'), 'v2');
    assert.equal(await readFile(fileB, 'utf-8'), 'b1');

    // 再从 t1 分叉出兄弟分支 branch-2，先回退并写 beta=b2-sibling
    await revertWorkspaceTo('root', t1);
    await forkSnapshotRecords('root', 'branch-2', t1);
    await writeFile(fileB, 'b2-sibling', 'utf-8');
    await recordFileChange('branch-2', fileB, null, 'b2-sibling');
    upsertSession({
      id: 'branch-2',
      title: 'Branch 2',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'init' }], ts: t1 }],
      updatedAt: Date.now(),
      forkFrom: { sessionId: 'root', messageId: 'm1', ts: t1 },
    });

    // 兄弟分支直接互切：branch-2 → branch-1（LCA = root, pivotTs = t1）
    const swSibling = await switchSessionWorkspace('branch-2', 'branch-1', (id) => getSession(id));
    assert.equal(swSibling.switched, true);
    assert.equal(swSibling.lcaSessionId, 'root');
    assert.equal(await readFile(fileA, 'utf-8'), 'v1-branch1');
    assert.equal(await readFile(fileB, 'utf-8').catch(() => null), null);

    // 用户手改保护：手动把 alpha.ts 改成 user-edited，切换回 root 时不得覆盖手改文件
    await writeFile(fileA, 'user-edited', 'utf-8');
    const swDirty = await switchSessionWorkspace('branch-1', 'root', (id) => getSession(id));
    assert.ok(swDirty.skipped.includes(fileA), '用户手动修改的文件必须进入 skipped');
    assert.equal(await readFile(fileA, 'utf-8'), 'user-edited', '绝不覆盖用户手写内容');
    assert.equal(await readFile(fileB, 'utf-8'), 'b1', '未手改的另一个文件仍正常重放');

    // rollbackAfter 保留因手改而 skipped 的快照项
    await writeFile(fileA, 'user-custom-2', 'utf-8');
    const rb = await rollbackAfter('root', 0);
    assert.ok(rb.skipped.includes(fileA));

    await deleteSnapshots('root');
    await deleteSnapshots('branch-1');
    await deleteSnapshots('branch-2');
    console.log('✓ 1. 会话分叉有根树与 LCA 跨分支文件切换通过');
  }

  // ---------------- 2. 一阶谓词权限规则表、只读命令判定与冲突检查 ----------------
  {
    const report = verifyPolicyRuleTable();
    assert.equal(report.valid, true, `默认权限规则表必须零矛盾、零死规则、零缺口: ${JSON.stringify(report)}`);
    assert.equal(report.deadRules.length, 0);
    assert.equal(report.contradictions.length, 0);
    assert.equal(report.uncoveredCount, 0);

    // 全称谓词 Shell 只读验证
    assert.equal(isSafeReadOnlyShellCommand('git status --short && rg "runAgent" kernel/src | wc -l'), true);
    assert.equal(isSafeReadOnlyShellCommand('git -C server log -n 5 --oneline'), true);
    assert.equal(isSafeReadOnlyShellCommand('find src -name "*.ts" -maxdepth 3'), true);
    assert.equal(isSafeReadOnlyShellCommand('echo "hello > world" | head -n 1'), true, '引号内 > 不应误判为重定向');

    // 危险/写副作用命令拦截
    assert.equal(isSafeReadOnlyShellCommand('ls > out.txt'), false, '输出重定向必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('echo $(whoami)'), false, '命令替换必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('find . -name "*.tmp" -delete'), false, 'find -delete 必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('rg --pre=sh foo'), false, 'rg --pre 必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('git -c core.pager=sh log'), false, 'git -c 注入必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('git branch new-feature'), false, 'git branch 创建分支必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('git branch --list "feat/*"'), true, 'git branch --list 模式查询放行');
    assert.equal(isSafeReadOnlyShellCommand('sort -o out.txt in.txt'), false, 'sort -o 写文件必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('tree -o out.txt src'), false, 'tree -o 写文件必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('tree -L 2 src'), true, 'tree 只读目录展示放行');
    assert.equal(isSafeReadOnlyShellCommand('date -s "2026-01-01"'), false, 'date -s 改时钟必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('date +%Y-%m-%d'), true, 'date 格式化只读输出放行');
    assert.equal(isSafeReadOnlyShellCommand('echo "${PATH:-x}"'), false, '复杂参数展开必须拦截');
    assert.equal(isSafeReadOnlyShellCommand('uniq in.txt out.txt'), false, 'uniq 第二位置参数写文件必须拦截');

    // Plan 只读模式：只读工具 & 只读命令放行；写工具与先前残留 allow 一律拒绝并返回专属原因
    const planPerm = parseSessionPermission({ mode: 'plan', allow: ['write_file'], deny: ['web_search'] })!;
    assert.equal(planPerm.mode, 'plan');
    assert.equal(evaluateToolPermission('read_file', { path: 'a.ts' }, planPerm), 'allow');
    assert.equal(evaluateToolPermission('todo_write', { todos: [] }, planPerm), 'allow');
    assert.equal(evaluateToolPermission('run_command', { cmd: 'git diff --stat' }, planPerm), 'allow');
    assert.equal(evaluateToolPermission('run_command', { cmd: 'git diff --stat', daemon: true }, planPerm), 'deny');
    assert.equal(
      evaluateToolPermission('run_command', { cmd: 'echo hi' }, { mode: 'strict', allow: [], deny: [] }),
      'ask',
      'strict 模式下任何 run_command 均须走人工审批确认',
    );

    const writeInPlan = evaluateToolPermissionVerdict('write_file', { path: 'a.ts', content: 'x' }, planPerm);
    assert.equal(writeInPlan.effect, 'deny', 'plan 模式必须忽略历史 allow 并拦截写入');
    assert.equal(writeInPlan.reason, PLAN_MODE_DENY_REASON);

    const explicitDenyInPlan = evaluateToolPermissionVerdict('web_search', { query: 'x' }, planPerm);
    assert.equal(explicitDenyInPlan.effect, 'deny');
    assert.equal(explicitDenyInPlan.reason, EXPLICIT_DENY_REASON);

    // 冲突诊断：同时在 allow/deny、run_command 进 allow、plan 下遮蔽 allow
    const conflicts = detectPermissionConflicts({
      mode: 'plan',
      allow: ['write_file', 'run_command'],
      deny: ['write_file'],
    });
    assert.deepEqual(
      conflicts.map((c) => c.kind),
      ['allow_deny_overlap', 'forbidden_tool_in_allow', 'allow_shadowed_by_plan_mode'],
    );
    console.log('✓ 2. 一阶谓词权限规则表与只读 Shell 验证通过');
  }

  // ---------------- 3. Todo 依赖 DAG 与宿主文件资源冲突分类 ----------------
  {
    const okOut = executeTodoWrite({
      todos: [
        { id: 'schema', content: '定义数据结构', status: 'completed' },
        { id: 'kernel', content: '实现内核算法', status: 'pending', dependsOn: ['schema'] },
        { id: 'ui', content: '接入前端展示', status: 'pending', dependsOn: ['schema'] },
        { id: 'test', content: '集成联调测试', status: 'pending', dependsOn: ['kernel', 'ui'] },
      ],
    });
    assert.match(okOut, /Wave 1: \[schema\] → Wave 2: \[kernel, ui\] → Wave 3: \[test\]/);
    assert.match(okOut, /当前就绪可并行项（入度=0）：kernel: 实现内核算法；ui: 接入前端展示/);

    // 环检测拒绝
    assert.throws(
      () => executeTodoWrite({
        todos: [
          { id: 'a', content: '步骤 A', status: 'pending', dependsOn: ['b'] },
          { id: 'b', content: '步骤 B', status: 'pending', dependsOn: ['a'] },
        ],
      }),
      /循环依赖/,
    );

    // 悬空依赖拒绝
    assert.throws(
      () => executeTodoWrite({
        todos: [{ id: 'a', content: '步骤 A', status: 'pending', dependsOn: ['ghost'] }],
      }),
      /不存在的前置任务/,
    );

    // 宿主 ToolRuntime 资源访问分类
    const rt = createPawToolRuntime({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' }, { workspace: workDir });
    const accEditA = rt.getResourceAccess!('edit_file', { path: 'src/a.ts' });
    const accEditB = rt.getResourceAccess!('edit_file', { path: 'src/b.ts' });
    assert.notDeepEqual(accEditA.writes, accEditB.writes, '不同文件写入拥有互不冲突的资源键');
    assert.deepEqual(rt.getResourceAccess!('todo_write', {}).reads, []);
    assert.deepEqual(rt.getResourceAccess!('run_command', { cmd: 'git status' }).writes, []);
    assert.deepEqual(rt.getResourceAccess!('run_command', { cmd: 'npm install' }).writes, ['*']);
    console.log('✓ 3. Todo 依赖 DAG 拓扑波次与宿主资源冲突分类通过');
  }

  // ---------------- 4. 代码引用有向图与多跳 BFS 影响面分析 ----------------
  {
    const projDir = path.join(workDir, 'dep-proj');
    await mkdir(path.join(projDir, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(path.join(projDir, 'packages', 'app', 'src'), { recursive: true });
    await mkdir(path.join(projDir, 'py_pkg'), { recursive: true });

    await writeFile(
      path.join(projDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@demo/core', main: './dist/index.js' }),
      'utf-8',
    );
    const fMath = path.join(projDir, 'packages', 'core', 'src', 'math.ts');
    const fCoreIdx = path.join(projDir, 'packages', 'core', 'src', 'index.ts');
    const fService = path.join(projDir, 'packages', 'app', 'src', 'service.ts');
    const fEntry = path.join(projDir, 'packages', 'app', 'src', 'main.ts');
    const fCycleA = path.join(projDir, 'packages', 'app', 'src', 'cycleA.ts');
    const fCycleB = path.join(projDir, 'packages', 'app', 'src', 'cycleB.ts');

    await writeFile(fMath, 'export const add = (a: number, b: number) => a + b;\n', 'utf-8');
    // 测试 TS ESM './math.js' → 'math.ts' 映射 + 忽略注释中的假引用
    await writeFile(
      fCoreIdx,
      `// import './nonexistent.js'\n/* import './ghost.js' */\nexport { add } from './math.js';\n`,
      'utf-8',
    );
    // 测试跨包引用 '@demo/core'
    await writeFile(fService, `import { add } from '@demo/core';\nexport const calc = () => add(1, 2);\n`, 'utf-8');
    await writeFile(fEntry, `import { calc } from './service';\nimport './cycleA';\nconsole.log(calc());\n`, 'utf-8');
    await writeFile(fCycleA, `import './cycleB';\nexport const a = 1;\n`, 'utf-8');
    await writeFile(fCycleB, `import './cycleA';\nexport const b = 2;\n`, 'utf-8');

    // Python 跨行括号导入 + 忽略 docstring 内伪造导包
    const pyUtil = path.join(projDir, 'py_pkg', 'util.py');
    const pyExtra = path.join(projDir, 'py_pkg', 'extra.py');
    const pyFake = path.join(projDir, 'py_pkg', 'fake_doc.py');
    const pyMain = path.join(projDir, 'py_pkg', 'runner.py');
    await writeFile(pyUtil, 'def helper(): return 42\n', 'utf-8');
    await writeFile(pyExtra, 'VALUE = 1\n', 'utf-8');
    await writeFile(pyFake, 'FAKE = 0\n', 'utf-8');
    await writeFile(
      pyMain,
      `"""\nExample:\nfrom . import fake_doc\n"""\nfrom . import (\n  util,\n  extra as ex,\n)\n`,
      'utf-8',
    );

    // Vue SFC + export 后紧跟裸副作用 import（回归测试）
    const fSide = path.join(projDir, 'packages', 'app', 'src', 'setup.ts');
    const fVue = path.join(projDir, 'packages', 'app', 'src', 'Widget.vue');
    await writeFile(fSide, 'export const ready = true;\n', 'utf-8');
    await writeFile(
      fVue,
      `<template><div>ok</div></template>\n<script setup lang="ts">\nexport const flag = 1;\nimport './setup';\nimport { calc } from './service';\n</script>\n`,
      'utf-8',
    );

    // Java + Kotlin：跨包 import、import static 及同包隐式类引用
    const jvmDtoDir = path.join(projDir, 'jvm', 'src', 'com', 'acme', 'dto');
    const jvmSvcDir = path.join(projDir, 'jvm', 'src', 'com', 'acme', 'svc');
    await mkdir(jvmDtoDir, { recursive: true });
    await mkdir(jvmSvcDir, { recursive: true });
    const fOrderDto = path.join(jvmDtoDir, 'OrderDto.java');
    const fOrderValidator = path.join(jvmSvcDir, 'OrderValidator.java');
    const fOrderService = path.join(jvmSvcDir, 'OrderService.kt');
    await writeFile(fOrderDto, 'package com.acme.dto;\npublic record OrderDto(String id) {}\n', 'utf-8');
    await writeFile(fOrderValidator, 'package com.acme.svc;\npublic class OrderValidator { public static boolean check() { return true; } }\n', 'utf-8');
    await writeFile(
      fOrderService,
      'package com.acme.svc\nimport com.acme.dto.OrderDto\nclass OrderService { fun run(d: OrderDto) = OrderValidator.check() }\n',
      'utf-8',
    );

    // Go：go.mod + 分组 import + _test.go 同包依赖
    const goRoot = path.join(projDir, 'go_svc');
    const goStoreDir = path.join(goRoot, 'internal', 'store');
    const goCmdDir = path.join(goRoot, 'cmd', 'api');
    await mkdir(goStoreDir, { recursive: true });
    await mkdir(goCmdDir, { recursive: true });
    await writeFile(path.join(goRoot, 'go.mod'), 'module example.com/gosvc\n\ngo 1.22\n', 'utf-8');
    const fGoStore = path.join(goStoreDir, 'repo.go');
    const fGoStoreTest = path.join(goStoreDir, 'repo_test.go');
    const fGoMain = path.join(goCmdDir, 'main.go');
    await writeFile(fGoStore, 'package store\ntype Repo struct{}\n', 'utf-8');
    await writeFile(fGoStoreTest, 'package store\nimport "testing"\nfunc TestRepo(t *testing.T) { _ = Repo{} }\n', 'utf-8');
    await writeFile(fGoMain, 'package main\nimport (\n\t"fmt"\n\t"example.com/gosvc/internal/store"\n)\nfunc main() { fmt.Println(store.Repo{}) }\n', 'utf-8');

    // Rust：Cargo.toml + mod 声明 + Rust 2018 子模块 + 嵌套 use crate::{...} + 生命周期 'a
    const rsRoot = path.join(projDir, 'rs_crate');
    await mkdir(path.join(rsRoot, 'src', 'net'), { recursive: true });
    await writeFile(path.join(rsRoot, 'Cargo.toml'), '[package]\nname = "paw-rs"\nversion = "0.1.0"\n', 'utf-8');
    const fRsLib = path.join(rsRoot, 'src', 'lib.rs');
    const fRsConfig = path.join(rsRoot, 'src', 'config.rs');
    const fRsNet = path.join(rsRoot, 'src', 'net.rs');
    const fRsHttp = path.join(rsRoot, 'src', 'net', 'http.rs');
    await writeFile(fRsConfig, 'pub struct Config<\'a> { pub name: &\'a str }\n', 'utf-8');
    await writeFile(fRsHttp, 'use crate::{config::Config};\npub fn serve<\'a>(_c: Config<\'a>) {}\n', 'utf-8');
    await writeFile(fRsNet, 'pub mod http;\n', 'utf-8');
    await writeFile(fRsLib, 'pub mod config;\npub mod net;\n', 'utf-8');

    // C/C++：#include <...>（来自 include/）与 #include "..."
    const cppIncDir = path.join(projDir, 'cpp', 'include', 'engine');
    const cppSrcDir = path.join(projDir, 'cpp', 'src');
    await mkdir(cppIncDir, { recursive: true });
    await mkdir(cppSrcDir, { recursive: true });
    const fCppHeader = path.join(cppIncDir, 'core.hpp');
    const fCppImpl = path.join(cppSrcDir, 'core.cpp');
    await writeFile(fCppHeader, '#pragma once\nint compute();\n', 'utf-8');
    await writeFile(fCppImpl, '#include <engine/core.hpp>\nint compute() { return 7; }\n', 'utf-8');

    const graph = await buildWorkspaceDepGraph(projDir);
    assert.ok(graph.dependents.get(fMath)?.has(fCoreIdx), 'core/index.ts 应依赖 core/math.ts');
    assert.ok(graph.dependents.get(fCoreIdx)?.has(fService), 'app/service.ts 应通过 @demo/core 依赖 core/index.ts');
    assert.ok(graph.dependents.get(fSide)?.has(fVue), 'Vue SFC 中紧跟在 export 后的裸 import 必须被准确提取');
    assert.ok(graph.dependents.get(pyUtil)?.has(pyMain) && graph.dependents.get(pyExtra)?.has(pyMain), 'Python 跨行括号导入应解析成功');
    assert.ok(!graph.dependents.get(pyFake)?.has(pyMain), 'Python docstring 内的示例 import 不得产生假边');
    assert.ok(graph.dependents.get(fOrderDto)?.has(fOrderService), 'Kotlin 应解析跨包 Java record 导入');
    assert.ok(graph.dependents.get(fOrderValidator)?.has(fOrderService), 'Java/Kotlin 同包隐式类型引用应建立依赖边');
    assert.ok(graph.dependents.get(fGoStore)?.has(fGoMain), 'Go 应通过 go.mod 解析包级导入');
    assert.ok(graph.dependents.get(fGoStore)?.has(fGoStoreTest), 'Go _test.go 应关联同包生产源码');
    assert.ok(graph.dependents.get(fRsConfig)?.has(fRsHttp), 'Rust 嵌套 use crate::{config::Config} 应解析到 config.rs（且不受生命周期单引号干扰）');
    assert.ok(graph.dependents.get(fRsHttp)?.has(fRsNet) && graph.dependents.get(fRsNet)?.has(fRsLib), 'Rust 2018 mod 层级应串起 lib.rs -> net.rs -> net/http.rs');
    assert.ok(graph.dependents.get(fCppHeader)?.has(fCppImpl), 'C++ #include <engine/core.hpp> 应命中 include/ 头文件');

    // 支持直接传入 Go 包目录作为 target
    const goDirReport = await executeAnalyzeCodeImpact({ target: goStoreDir, direction: 'dependents' }, projDir);
    assert.ok(goDirReport.includes(fGoMain), '传入 Go 包目录作为 target 时应追踪到上游调用方 main.go');

    const impactReport = await executeAnalyzeCodeImpact(
      { target: fMath, direction: 'both', max_depth: 5 },
      projDir,
    );
    assert.match(impactReport, /1 跳（直接关联）/);
    assert.match(impactReport, /2 跳（传递关联）/);
    assert.match(impactReport, /3 跳（传递关联）/);
    assert.ok(impactReport.includes(fEntry), '3 跳反向闭包应追踪到顶层 main.ts');

    const cycleReport = await executeAnalyzeCodeImpact(
      { target: fEntry, direction: 'dependencies', max_depth: 4 },
      projDir,
    );
    assert.match(cycleReport, /检测到循环引用/, '可达子图中的循环导包应被检出');
    console.log('✓ 4. 代码引用有向图与多跳 BFS 可达闭包分析通过');
  }
} finally {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
