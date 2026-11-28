// render_mermaid 工具：校验并渲染 Mermaid 架构图/流程图/时序图/ER 图等，在对话区直接展示交互式图表卡片。
import type { ToolResult, ToolSchema } from '@paw/kernel';

/** Mermaid 官方常见图类型起始关键字（跳过注释与 YAML frontmatter 后的首行） */
const MERMAID_HEADER_RE = /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|gitGraph|timeline|journey|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|radar-beta)\b/i;

export const RENDER_MERMAID_SCHEMA: ToolSchema = {
  name: 'render_mermaid',
  description: [
    'Render an interactive Mermaid diagram card in the chat UI (zoomable, fullscreen, copyable).',
    'Use this whenever explaining system architecture, workflows, sequence interactions, state machines, ER schemas, class hierarchies, or mindmaps.',
    'Pass clean Mermaid syntax in `code` (no ```mermaid fences needed). Wrap node labels containing parentheses, colons, slashes, or quotes in double quotes, e.g. A["POST /api/chat (server)"].',
    'Once this tool succeeds, the diagram is already visible to the user in the tool card—do not repeat the same mermaid block in your text reply.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Mermaid diagram source code, e.g. "flowchart TD\\n  A[\\"开始\\"] --> B[\\"结束\\"]"',
      },
      title: {
        type: 'string',
        description: 'Optional short diagram title shown above the diagram',
      },
      summary: {
        type: 'string',
        description: 'Brief Chinese summary of what the diagram illustrates (<=20 chars)',
      },
    },
    required: ['code'],
  },
};

/** 去掉模型偶尔误包的外层 ```mermaid ... ``` 围栏 */
export function stripMermaidFences(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:mermaid)?[^\n]*\n([\s\S]*?)\n?```$/i);
  return (m ? m[1] : trimmed).trim();
}

/** 跳过空行、%% 注释、%%{init:...}%% 指令与 --- YAML frontmatter，找到真正的图表声明首行 */
function firstEffectiveLine(code: string): string {
  const lines = code.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === '---') {
    i++;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%')) continue;
    return line;
  }
  return '';
}

/**
 * 轻量静态校验（零外部依赖，无误杀）：
 * 只拦 100% 会导致前端渲染失败的常见错误，让模型在发给用户前立刻修正。
 */
export function validateMermaidSource(code: string): string | null {
  if (!code) return 'code 不能为空，请提供有效的 Mermaid 源码';
  if (/<script\b/i.test(code)) return 'Mermaid 源码中不允许包含 <script> 标签';
  const head = firstEffectiveLine(code);
  if (!head) return '未检测到有效的 Mermaid 图表内容';
  if (!MERMAID_HEADER_RE.test(head)) {
    return `首行「${head.slice(0, 40)}」不是已支持的 Mermaid 图类型声明（应以 flowchart / graph / sequenceDiagram / classDiagram / stateDiagram-v2 / erDiagram / gantt / pie / mindmap / gitGraph / timeline 等开头）`;
  }
  // flowchart / graph：检查 subgraph 与 end 数量配对（忽略 %% 注释行）
  if (/^(?:flowchart|graph)\b/i.test(head)) {
    let subgraphs = 0;
    let ends = 0;
    for (const raw of code.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('%%')) continue;
      if (/^subgraph\b/i.test(line)) subgraphs++;
      else if (/^end$/i.test(line)) ends++;
    }
    if (subgraphs > ends) {
      return `检测到 ${subgraphs} 个 subgraph，但只有 ${ends} 个 end，请补齐缺失的 end`;
    }
  }
  return null;
}

export function executeRenderMermaid(args: Record<string, unknown>, toolCallId: string): ToolResult | string {
  const rawCode = typeof args.code === 'string' ? args.code : '';
  const code = stripMermaidFences(rawCode);
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const err = validateMermaidSource(code);
  if (err) {
    return {
      tool_call_id: toolCallId,
      content: `Mermaid 校验失败：${err}。请修正后重新调用 render_mermaid。`,
      isError: true,
    };
  }
  const heading = title ? `#### ${title}\n\n` : '';
  return `${heading}\`\`\`mermaid\n${code}\n\`\`\``;
}
