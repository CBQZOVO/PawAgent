// 会话标题：第二次模型调用，跟主对话完全独立。
// 主对话照常跑，这里异步生成标题；失败时前端保留字符串兜底标题，不影响使用。
import { streamChat, type GatewayConfig } from './gateway/client.js';

// 指令放在 user 消息里：实测这些网关模型对 system 角色遵循度差（原样复述用户消息），
// 放 user 里 + 补几个示例，输出才稳定（2026-11-23）。
const PROMPT_TEMPLATE = `请给下面这段用户消息起一个简短标题。要求：只输出标题本身；不超过 12 个汉字；用中文动宾短语概括用户想做什么；不要复制原文里的文件名、编号、路径、引用符号；不要引号或标点。

示例：
用户消息：我上传了 report.pdf 和 data.xlsx，帮我看看销售趋势
标题：分析销售数据

用户消息：@"GS Cloud产品线代码审查工具（iCodeScan）检查项.xlsx" 这几份文件你只说出文件名，不要读内容
标题：确认四个上传文件

用户消息：网关调用 Gemini4Carbon 一直报错，这是日志……
标题：排查网关调用报错

用户消息：{text}
标题：`;

/** 模型输出兜底清洗：去掉「标题：」前缀、引用符号和首尾标点 */
function cleanTitle(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/^标题[:：]?\s*/, '')
    .replace(/@"[^"]*"/g, '')
    .replace(/^[\s"'「『《]+|[\s"'」』》。！？!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** 调一次模型生成标题。8 秒超时，超时直接放弃——标题不是关键路径。 */
export async function generateTitle(text: string, cfg: GatewayConfig): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    let out = '';
    for await (const d of streamChat(cfg, [
      { role: 'user', content: PROMPT_TEMPLATE.replace('{text}', text.slice(0, 600)) },
    ], [], undefined, ctrl.signal)) {
      if (d.content) out += d.content;
    }
    const title = cleanTitle(out);
    // 模型偶尔仍会复述原文：带文件扩展名或以编号开头就丢弃，让前端沿用字符串兜底标题
    if (/\.(xlsx?|docx?|pdf|pptx?|txt|csv|png|jpe?g|webp)\b/i.test(title) || /^\d+[\.、)]/.test(title)) return '';
    return title;
  } finally {
    clearTimeout(timer);
  }
}
