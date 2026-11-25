/**
 * 文件预览共用工具：扩展名解析 / 图标配色 / 是否原生预览（图片/PDF）。
 * 从 highlight.ts 拆出来——那边只该管文件名，不该塞预览语义。
 */
export { extOf, fileHue } from './highlight';

/** 图片/PDF：浏览器原生预览（跟后端 RAW_MIME 对齐） */
const RAW_PREVIEW_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'pdf']);
export function isRawPreviewable(ext: string): boolean {
  return RAW_PREVIEW_EXT.has(ext.toLowerCase());
}

/**
 * 文件类型徽章：CodeBuddy 那种彩色小方块 + 类型缩写，用在 tab / 文件列表。
 * 配色取 Material Icon Theme 的经典色，一眼能认出语言。
 */
export function fileBadge(ext: string): { label: string; color: string } {
  const e = ext.toLowerCase();
  const table: Record<string, [string, string]> = {
    ts: ['TS', '#3178c6'], tsx: ['TS', '#3178c6'],
    js: ['JS', '#f0db4f'], jsx: ['JS', '#f0db4f'], mjs: ['JS', '#f0db4f'], cjs: ['JS', '#f0db4f'],
    py: ['Py', '#3572A5'],
    md: ['M↓', '#519aba'], markdown: ['M↓', '#519aba'],
    json: ['{}', '#cbcb41'], jsonc: ['{}', '#cbcb41'],
    yaml: ['Y', '#cb171e'], yml: ['Y', '#cb171e'], toml: ['T', '#9c4221'],
    sh: ['$_', '#89e051'], bash: ['$_', '#89e051'], zsh: ['$_', '#89e051'],
    html: ['<>', '#e34c26'], css: ['#', '#563d7c'], scss: ['S#', '#c6538c'],
    java: ['J', '#b07219'], kt: ['K', '#a97bff'], kts: ['K', '#a97bff'],
    go: ['Go', '#00ADD8'], rs: ['R', '#dea584'], c: ['C', '#555555'], cpp: ['C+', '#f34b7d'],
    sql: ['DB', '#e38c00'], xml: ['<>', '#e34c26'], svg: ['<>', '#ffb13b'],
    vue: ['V', '#41b883'], pdf: ['PDF', '#b30b00'],
    png: ['IMG', '#a074c4'], jpg: ['IMG', '#a074c4'], jpeg: ['IMG', '#a074c4'], gif: ['IMG', '#a074c4'], webp: ['IMG', '#a074c4'],
    lock: ['🔒', '#bbbbbb'], log: ['≡', '#aaaaaa'], txt: ['≡', '#87919e'],
  };
  const hit = table[e];
  if (hit) return { label: hit[0], color: hit[1] };
  return { label: (e.slice(0, 2) || '?').toUpperCase(), color: '#87919e' };
}

/** 扩展名 → Monaco language id（同名的不用列）；跟 IdePanel 保持同一份映射 */
export const MONACO_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', xml: 'xml', svg: 'xml',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', java: 'java', php: 'php', rb: 'ruby',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', sql: 'sql',
  ps1: 'powershell', bat: 'bat', dockerfile: 'dockerfile',
  txt: 'plaintext',
};
