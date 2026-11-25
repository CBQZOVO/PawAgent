/** 判断一个模型 id 是不是生图模型（生图模型不支持 chat 端点，直出生图由外部 image-gen 插件执行） */
export function isImageModel(model: string): boolean {
  return /^gpt-image-/i.test(model);
}
