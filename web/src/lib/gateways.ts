// 内置平台：均为 OpenAI 兼容根地址，后端自动追加 /v1（已带版本的原样保留）并请求 /models 与 /chat/completions。
export interface GatewayPreset {
  label: string;
  url: string;
}

export const PRESET_GATEWAYS: GatewayPreset[] = [
  { label: 'Paw', url: 'https://api.inspurai.cc' },
  { label: 'OpenAI', url: 'https://api.openai.com' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com' },
  { label: 'Moonshot / Kimi（国内）', url: 'https://api.moonshot.cn' },
  { label: 'Kimi Code（国内·会员）', url: 'https://api.kimi.com/coding/v1' },
  { label: '硅基流动 SiliconFlow', url: 'https://api.siliconflow.cn' },
  { label: '通义千问 DashScope', url: 'https://dashscope.aliyuncs.com/compatible-mode' },
  { label: '腾讯云 TokenHub', url: 'https://tokenhub.tencentcloudmaas.com' },
  { label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'MiniMax', url: 'https://api.minimax.cn' },
  { label: '海岳大模型', url: 'https://ingpt.inspures.com/llm/' },
];

export const CUSTOM_GATEWAY = '__custom__';

/** 后端落盘会去掉尾部斜杠，匹配预设时统一规范化 */
const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');

export function matchGateway(baseUrl?: string): GatewayPreset | undefined {
  if (!baseUrl) return undefined;
  const target = normalizeUrl(baseUrl);
  return PRESET_GATEWAYS.find((p) => normalizeUrl(p.url) === target);
}

/** 把地址转成展示名：内置平台显示 label，其余显示 host */
export function gatewayLabel(baseUrl?: string): string {
  if (!baseUrl) return '自定义网关';
  return matchGateway(baseUrl)?.label
    ?? (() => { try { return new URL(baseUrl).host; } catch { return '自定义网关'; } })();
}
