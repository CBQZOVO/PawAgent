/**
 * remark-math 守卫：把不像公式的行内 $...$ 还原成普通文本。
 *
 * 背景：remark-math 对行内公式的判定很宽松，「预算 $100 到 $200」「参数 $1 和 ${HOME}」
 * 这种普通文本会被切成公式（"100 到 "、"1 和 "），渲染出来就是乱码。
 * 聊天里金额、shell 变量很常见，所以宁可保守：拿不准就按原文显示。
 *
 * 判定一条行内 $...$ 是公式，要同时满足：
 *   1. 首尾没有空白（"$x $"、"100 到 " 这类不是）；
 *   2. \text{} 等文本命令之外含中文等 CJK 字符时，必须包含明确的 LaTeX 命令（如 \frac、\sum），
 *      否则视为普通文本误切（如「$100 到 $200」）；
 *   3. 内容含空格时，必须至少有一个数学符号（= ^ _ \ { } + - < > 括号等）。
 *      "E = mc^2"、"a + b" 是公式；"5 and" 不是。
 * 独立公式块 $$...$$ 不做判定（分隔符明确，基本不会误伤）。
 */

// 只声明用得到的结构，不依赖 mdast 类型包
type MdNode = { type: string; value?: string; children?: MdNode[] };

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const TEXT_CMD_RE = /\\(text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|mbox|operatorname)\{[^{}]*\}/g;
const LATEX_CMD_RE = /\\[a-zA-Z]{2,}/;
const MATH_SYMBOL_RE = /[\\^_{}=+\-<>()[\]|]|≤|≥|×|·|≠|≈|∈|∑|∫|√|∞|±|→/;
// 金额区间（$100-$200、$5~$10、$100/$200）被 remark-math 切出的前段如 "100-" / "5~" / "100/"
const DANGLING_PRICE_RE = /^\d[\d,.]*[-~–—/,，、]$/;

export function looksLikeMath(src: string): boolean {
  if (!src || src !== src.trim()) return false;
  if (DANGLING_PRICE_RE.test(src)) return false;
  if (CJK_RE.test(src.replace(TEXT_CMD_RE, '')) && !LATEX_CMD_RE.test(src)) return false;
  if (/\s/.test(src) && !MATH_SYMBOL_RE.test(src)) return false;
  return true;
}

/**
 * 把 LLM 常输出的 \(...\) 和 \[...\] 转为 remark-math 认识的 $...$ / $$...$$。
 * 跳过围栏代码块（``` / ~~~）和行内代码（`...`），不破坏代码里的转义字符。
 */
export function normalizeLatexDelimiters(md: string): string {
  if (!md.includes('\\(') && !md.includes('\\[')) return md;
  const codeRe = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)|(`+)[^\n`]*?\3/g;
  const convert = (seg: string) => seg
    .replace(/\\\[([\s\S]+?)\\\]/g, (raw, body: string) => {
      const trimmed = body.trim();
      // 单行 \[1\] / \[note\] 常见于 Markdown 转义方括号或学术引用，不含数学符号时不转成块级公式
      if (!trimmed.includes('\n') && !MATH_SYMBOL_RE.test(trimmed)) return raw;
      return `\n$$\n${trimmed}\n$$\n`;
    })
    .replace(/\\\(([^\n]+?)\\\)/g, (_m, body: string) => `$${body}$`);

  let out = '';
  let last = 0;
  for (const m of md.matchAll(codeRe)) {
    const idx = m.index ?? 0;
    out += convert(md.slice(last, idx));
    out += m[0];
    last = idx + m[0].length;
  }
  out += convert(md.slice(last));
  return out;
}

/** 还原成普通文本（保留原始的 $ 定界符，用户看到的就是模型输出的原文） */
export function remarkMathGuard(): (tree: MdNode) => void {
  return (tree) => {
    const walk = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'inlineMath' && typeof child.value === 'string' && !looksLikeMath(child.value)) {
          return [{ type: 'text', value: `$${child.value}$` }];
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
