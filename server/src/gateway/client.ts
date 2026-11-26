// 网关客户端：调 channelhub /v1/chat/completions，流式解析。
// 网关已修好 reasoning_content / tool_calls 归一，这里只管读 SSE。
import type { ChatMessage, ToolSchema } from '@paw/shared';

/**
 * 把网关的原始错误（JSON 包 HTML、技术链路）翻译成人话。
 * 例：{"error":{"message":"所有候选条目都失败: Qoder-xxx -> HTTP 405 Method Not Allowed @api.qoder.sh <html>..."}}
 *   → "上游服务暂时不可用（405），换个模型或稍后重试就好 🐾"
 */
export function friendlyGatewayError(status: number, raw: string): string {
  // 1. 尝试从 JSON 里抠 message
  let msg = raw;
  try {
    const d = JSON.parse(raw);
    msg = String(d?.error?.message || d?.message || raw);
  } catch { /* 非 JSON 原样处理 */ }

  // 2. 剥 HTML 标签和 meta/content 噪音（qoder 405 会甩一整页 HTML）
  msg = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // 3. 识别常见上游错误，给人话
  if (/405|Method Not Allowed/i.test(msg)) return '上游服务暂时不可用（方法不被允许），换个模型或稍后再试就好 🐾';
  if (/429|rate.?limit|too many requests/i.test(msg)) return '请求太频繁啦，等一会儿再发就好 🐾';
  if (/timeout|超时|timed out/i.test(msg)) return '模型响应超时了，稍后重试或换个模型试试 🐾';
  if (/401|403|unauthorized|forbidden|invalid api key/i.test(msg)) return '网关密钥可能失效了，检查一下配置 🐾';
  if (/404|no upstream|not found/i.test(msg)) return '这个模型暂时没有可用线路，换个模型试试 🐾';
  if (/500|502|503|上游|upstream|所有候选|候选条目都失败/i.test(msg)) return '上游服务开小差了，换个模型或稍后重试就好 🐾';
  if (/内容风控|injection|outfile|sensitive|安全/i.test(msg)) return '内容触发了安全策略，改一下措辞再试 🐾';

  // 4. 兜底：截短 + 去掉技术链路前缀
  msg = msg.replace(/^网关?\s*\d+:\s*/i, '')
    .replace(/所有候选条目都失败[:：]?\s*/i, '')
    .replace(/\s*->\s*/g, ' · ');
  return `请求没成功：${msg.slice(0, 80) || '上游服务异常，稍后重试'} 🐾`;
}

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 一次流式 chunk 的增量 */
export interface StreamDelta {
  reasoning?: string;
  content?: string;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
  finishReason?: string;
  usage?: { prompt: number; completion: number }; // stream_options.include_usage 的末尾 chunk
}

/** 首包前值得再试一次的状态码：限流、网关瞬断 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1000;

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 只重试「响应头都还没拿到 / 没吐过任何内容」的瞬时失败，且只重试一次。
 * 为什么需要：一轮多轮的工具上下文都在内存里，网关抖一下就直接报错，整轮白跑、
 * 用户只能重新发。已经拿到响应头之后的流式读取不重试（增量已经发给前端了）。
 * 不重试：超时（AbortError）、用户主动停止、4xx 这类确定性错误。
 */
async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok || attempt || !RETRY_STATUS.has(resp.status)) return resp;
      // 释放错误响应体，避免连接池里的底层 socket 被未消费流占住
      await resp.body?.cancel().catch(() => {});
    } catch (e) {
      if (attempt || signal?.aborted || (e as Error).name === 'AbortError') throw e;
    }
    await sleepAbortable(RETRY_DELAY_MS, signal);
  }
}

export async function* streamChat(
  cfg: GatewayConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  images?: string[],   // 本轮上传图片的 data URL（OpenAI 多模态 image_url part）
  signal?: AbortSignal, // 客户端停止时中断上游模型请求
): AsyncGenerator<StreamDelta> {
  // 本轮图片挂到**最后一条 user 消息**上。
  // 不能只认「数组最后一条」：模型调过工具之后，数组末尾是 tool 消息，user 消息在中间——
  // 按末尾判断，图片就会从第 1 轮起整体丢失。
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  // 回传历史里的 tool_calls 必须是 OpenAI 嵌套格式
  // {id,type:function,function:{name,arguments}}；shared 内部用平铺，发送前转换。
  const wireMessages = messages.map((m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    // content 转成多模态数组，照 WorkBuddy 实测格式：
    // {type:"image_url", image_url:{url:"data:image/...;base64,..."}}
    if (images?.length && m.role === 'user' && i === lastUser) {
      return {
        ...m,
        content: [
          { type: 'text', text: m.content },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    }
    return m;
  });
  const body = {
    model: cfg.model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true }, // 末尾 chunk 带 usage（token 统计用）
    tools: tools.length
      ? tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined,
  };
  // 超时护栏：上游收了请求但不吐数据（代理挂起、半死连接）会让整轮永久卡住——
  // 主对话只能靠用户手点停止，定时任务里 runTask 永不返回、运行记录都写不了。
  // 连接/首包 180s（历史大时 prefill 实测可达 86s），此后每收到一个 chunk 重置 300s 空闲计时。
  const CONNECT_TIMEOUT_MS = 180_000;
  const IDLE_TIMEOUT_MS = 300_000;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
  };
  armTimer(CONNECT_TIMEOUT_MS);
  try {
    const resp = await fetchWithRetry(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Paw/1.0',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }, signal);
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(friendlyGatewayError(resp.status, text));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const parseLine = function* (rawLine: string): Generator<StreamDelta, boolean> {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return true;
      let obj: any;
      try {
        obj = JSON.parse(data);
      } catch {
        return false;
      }
      // 网关有时 HTTP 200 但 SSE 里塞 error 对象（没有 choices）
      if (obj.error && !obj.choices) {
        throw new Error(friendlyGatewayError(502, JSON.stringify(obj.error)));
      }
      // usage chunk：stream_options.include_usage 时末尾发一条 choices=[] + usage
      if (obj.usage && typeof obj.usage.prompt_tokens === 'number') {
        yield { usage: { prompt: obj.usage.prompt_tokens, completion: obj.usage.completion_tokens || 0 } };
      }
      const choice = obj.choices?.[0];
      if (!choice) return false;
      const d = choice.delta || {};
      const out: StreamDelta = {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
      if (d.content) out.content = d.content;
      if (d.tool_calls) {
        // 网关返回 OpenAI 标准嵌套格式：{index,id,function:{name,arguments}}
        out.toolCalls = d.tool_calls.map((tc: any) => ({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name ?? tc.name,
          arguments: tc.function?.arguments ?? tc.arguments,
        }));
      }
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
      if (Object.keys(out).length) yield out;
      return false;
    };

    while (true) {
      if (ctrl.signal.aborted) return;
      armTimer(IDLE_TIMEOUT_MS);
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.trim()) yield* parseLine(buf);
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const finished = yield* parseLine(line);
        if (finished) return;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e; // 用户主动停止：原样上抛，调用方按中止处理
    if ((e as Error).name === 'AbortError') {
      throw new Error('网关长时间没有返回数据，已中断本次请求（稍后重试或换个模型试试）');
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
