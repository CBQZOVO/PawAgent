// 图片转文字：用能读图的模型（默认 Haiyue-122B-A10B，实测最快最准）识别图片，
// 把画面描述返回给不支持读图的模型继续对话。走网关，与正常请求同一配置。
//
// 注意：Haiyue 等 qoder 系渠道强制流式（非流式返回 heartbeat+SSE 无法解析），
// 所以这里用 stream:true 收集 delta。
import type { GatewayConfig } from './gateway/client.js';

const DESCRIBE_MODEL = 'Haiyue-122B-A10B'; // 0.5s、描述准确；备选 Haiyue-V3.5-27B
const PROMPT = '这张图里画的是什么？用简体中文详细描述画面内容（主体、动作、颜色、文字），控制在 150 字以内。';

/** 识别一张图片，返回文字描述；失败返回空串（调用方可降级）。
 *  signal：用户停止时取消上游请求。 */
export async function describeImage(
  dataUrl: string,
  gateway: { baseUrl: string; apiKey: string },
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(gateway.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.apiKey}`, 'User-Agent': 'Paw/1.0' },
    body: JSON.stringify({
      model: DESCRIBE_MODEL,
      stream: true,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`识别模型 HTTP ${resp.status}: ${(await resp.text()).slice(0, 100)}`);

  // 收集 SSE delta
  let text = '';
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('识别响应无 body');
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload);
        text += d.choices?.[0]?.delta?.content || '';
      } catch { /* 忽略非法 chunk */ }
    }
  }
  return text.trim();
}
