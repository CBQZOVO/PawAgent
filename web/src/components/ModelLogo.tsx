import { useState } from 'react'

/** 模型 id → 本地 logo（public/logos/*.svg），匹配不到或加载失败回退首字母块 */
const VENDOR_RULES: [RegExp, string][] = [
  [/gpt-image|gpt-|openai|codex/i, 'openai'],
  [/claude|anthropic/i, 'claude'],
  [/gemini/i, 'google-gemini'],
  [/qwen|tongyi|通义/i, 'qwen'],
  [/deepseek/i, 'deepseek'],
  [/hunyuan|hy4/i, 'hunyuan'],
  [/kimi|moonshot/i, 'kimi'],
  [/glm|zhipu/i, 'zhipu'],
  [/minimax|space-bunny/i, 'minimax'],
  [/doubao/i, 'doubao'],
  [/grok/i, 'grok'],
  [/haiyue/i, 'haiyue'],
  [/mimo/i, 'xiaomimimo'],
  [/step/i, 'stepfun'],
]

export default function ModelLogo({ model, size = 16 }: { model: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const vendor = VENDOR_RULES.find(([re]) => re.test(model))?.[1]
  const style = { width: size, height: size }
  if (vendor && !failed) {
    return <img className="model-logo" style={style} src={`/logos/${vendor}.svg`} alt=""
      onError={() => setFailed(true)} />
  }
  const initial = (model.replace(/^[^a-z0-9]+/i, '').charAt(0) || '?').toUpperCase()
  return <span className="model-logo-fallback" style={style}>{initial}</span>
}
