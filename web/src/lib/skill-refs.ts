// 从消息文本里提取 @skill:xxx 引用（复制粘贴场景：从 Paw 一个对话粘到另一个）。
// 提取出来后当成真正选中的技能——注入 SKILL.md、渲染成 chip，而不是纯文本。
export function extractSkillRefs(text: string): { text: string; skillIds: string[] } {
  const skillIds: string[] = [];
  const cleaned = text.replace(/@skill:([\w.-]+)/g, (_m, id: string) => {
    skillIds.push(id);
    return '';
  });
  // 没有引用就原样返回：下面的空白整理只用来收拾「删掉引用后留下的空洞」，
  // 对普通消息跑一遍等于篡改用户原文（缩进、连续空行都会没）
  if (!skillIds.length) return { text, skillIds };
  return {
    text: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    skillIds,
  };
}
