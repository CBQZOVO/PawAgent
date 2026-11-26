// 图片转文字：用能读图的模型识别图片，把画面内容返回给主模型继续对话。
// 两个用途：
//   1. 主模型不支持读图时，上传的图片先转成文字再喂给主模型；
//   2. read_image 工具：回看本会话更早的图片（历史消息里只剩 @"文件名" 占位，不再带图）。
//
// 视觉模型**不再写死**：以前固定 Haiyue-122B-A10B，该模型从网关下架后，所有图片兜底
// 一次失败一次（2026-11-26 排查会话时发现）。现在按「主模型自己能读图 → 网关现有模型里
// 按优先级挑」实时决定，网关模型列表缓存 10 分钟。
//
// 注意：部分渠道（qoder 系等）强制流式（非流式返回 heartbeat+SSE 无法解析），
// 所以统一用 stream:true 收集 delta。
import { canSeeImages, VISION_MODELS } from '@paw/shared';
import type { GatewayConfig } from './gateway/client.js';

type GatewayLike = Pick<GatewayConfig, 'baseUrl' | 'apiKey'>;

/** 主模型不能读图时的兜底候选，按优先级排：先挑快且便宜的 */
const PREFERRED_VISION_MODELS = [
  'glm-5.3-flashx', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-3.8-flash',
  'deepseek-v4.1-flash', 'claude-haiku-5-5', 'gpt-6-luna', 'kimi-k3', 'mimo-v2.6-pro',
];
const LIST_CACHE_MS = 10 * 60 * 1000;

const DESCRIBE_PROMPT = '这张图里画的是什么？用简体中文详细描述画面内容（主体、动作、颜色、文字），控制在 150 字以内。';
/** read_image 工具用的提问词：截图类图片要的是完整转写，不是 150 字概括 */
export const READ_IMAGE_PROMPT = '请用简体中文详细描述这张图。先说明图的类型（截图/照片/图表/流程图等），再按从上到下、从左到右的顺序完整转写画面里的所有文字（保留原文，不要翻译、改写或省略），表格按行列还原，最后说明布局、颜色、标注、报错弹窗等关键视觉信息。看不清的内容明确说看不清，不要猜测。';

let listCache: { baseUrl: string; at: number; ids: string[] } | null = null;

/** 网关当前可用的模型 id（小写）；拿不到就当空，由调用方降级 */
async function listGatewayModels(gateway: GatewayLike): Promise<Set<string>> {
  if (listCache && listCache.baseUrl === gateway.baseUrl && Date.now() - listCache.at < LIST_CACHE_MS) {
    return new Set(listCache.ids);
  }
  let ids: string[] = [];
  try {
    const r = await fetch(gateway.baseUrl.replace(/\/$/, '') + '/v1/models', {
      headers: { Authorization: `Bearer ${gateway.apiKey}`, 'User-Agent': 'Paw/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const d = (await r.json()) as { data?: Array<{ id: string }> };
      ids = (d.data || []).map((m) => m.id.toLowerCase());
    }
  } catch { /* 列表拿不到不影响主流程 */ }
  // 仅缓存非空结果：拉取失败或暂时返回空列表时不缓存 10 分钟，下次立刻重试
  if (ids.length > 0) {
    listCache = { baseUrl: gateway.baseUrl, at: Date.now(), ids };
  }
  return new Set(ids);
}

/**
 * 选一个能读图的模型。顺序：
 *   1. 主模型自己能读图就用主模型（不跨模型，效果最好，也不依赖任何写死的模型名）；
 *   2. 网关现有模型里，按优先级挑一个快且便宜的；
 *   3. 网关现有的其它已知读图模型；
 *   4. 都没有就用首选名，让上游返回明确错误，而不是悄悄不发图。
 */
export async function resolveVisionModel(gateway: GatewayLike, mainModel?: string): Promise<string> {
  if (mainModel && canSeeImages(mainModel)) return mainModel;
  const available = await listGatewayModels(gateway);
  const pick = PREFERRED_VISION_MODELS.find((m) => available.has(m))
    ?? [...VISION_MODELS].find((m) => available.has(m));
  return pick ?? PREFERRED_VISION_MODELS[0];
}

/**
 * 识别一张图片，返回文字。
 * signal：用户停止时取消上游请求。opts.prompt 自定义提问（read_image 用），opts.maxTokens 输出上限。
 */
export async function describeImage(
  dataUrl: string,
  gateway: GatewayLike,
  signal?: AbortSignal,
  opts: { prompt?: string; maxTokens?: number; mainModel?: string } = {},
): Promise<string> {
  const model = await resolveVisionModel(gateway, opts.mainModel);
  const resp = await fetch(gateway.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.apiKey}`, 'User-Agent': 'Paw/1.0' },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: opts.maxTokens ?? 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt ?? DESCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`识别模型 ${model} HTTP ${resp.status}: ${(await resp.text()).slice(0, 100)}`);

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
