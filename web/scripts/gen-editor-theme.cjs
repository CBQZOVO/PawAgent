#!/usr/bin/env node
/**
 * 从 primer/github-vscode-theme 生成 Paw 编辑器令牌 CSS。
 * 用法：
 *   1) 准备主题源码（zip 解压后的 src/ 目录）与依赖：
 *        npm i @primer/primitives@7.10.0 chroma-js
 *   2) node web/scripts/gen-editor-theme.cjs <theme-src-dir> <out-css>
 * 产物：web/src/styles/editor-theme.css（:root = GitHub Light，
 *       :root[data-editor-theme="dark"] = GitHub Dark）
 * 不手调近似色：所有值来自主题源码 tokenColors / colors 映射。
 */
const fs = require('fs');
const path = require('path');

const srcDir = process.argv[2];
const outFile = process.argv[3] || path.resolve(__dirname, '../src/styles/editor-theme.css');
if (!srcDir) { console.error('用法: node gen-editor-theme.cjs <theme-src-dir> [out-css]'); process.exit(1); }

const getTheme = require(path.resolve(srcDir, 'theme.js'));
const themes = {
  light: getTheme({ theme: 'light', name: 'GitHub Light Default' }),
  dark: getTheme({ theme: 'dark', name: 'GitHub Dark Default' }),
};

// tokenizer 类 → TextMate scope
const CLASS_SCOPE = {
  'tk-cmt': 'comment', 'tk-kw': 'keyword', 'tk-storage': 'storage.type',
  'tk-str': 'string', 'tk-num': 'constant', 'tk-const': 'constant',
  'tk-fn': 'entity.name.function', 'tk-type': 'entity.name', 'tk-tag': 'entity.name.tag',
  'tk-var': 'variable', 'tk-prop': 'meta.property-name', 'tk-jsonkey': 'support.type.property-name.json',
  'tk-dec': 'punctuation.section.embedded', 'tk-regex': 'string.regexp',
  'tk-heading': 'markup.heading', 'tk-bold': 'markup.bold', 'tk-italic': 'markup.italic',
  'tk-quote': 'markup.quote', 'tk-link': 'string.other.link', 'tk-raw': 'markup.inline.raw',
  'tk-list': 'punctuation.definition.list.begin.markdown',
  'tk-diff-add': 'markup.inserted', 'tk-diff-del': 'markup.deleted', 'tk-diff-hunk': 'meta.diff.range',
  'tk-punct': 'brackethighlighter.curly', 'tk-invalid': 'invalid.illegal',
};
const UI_MAP = {
  'gh-bg': 'editor.background', 'gh-fg': 'editor.foreground', 'gh-fg-muted': 'statusBar.foreground',
  'gh-canvas-inset': 'sideBar.background', 'gh-border': 'sideBar.border',
  'gh-tabs-bg': 'editorGroupHeader.tabsBackground', 'gh-tab-active-bg': 'tab.activeBackground',
  'gh-tab-active-fg': 'tab.activeForeground', 'gh-tab-inactive-fg': 'tab.inactiveForeground',
  'gh-tab-accent': 'tab.activeBorderTop', 'gh-ln': 'editorLineNumber.foreground',
  'gh-ln-active': 'editorLineNumber.activeForeground', 'gh-line-hi': 'editor.lineHighlightBackground',
  'gh-sel': 'editor.selectionBackground', 'gh-list-active': 'list.activeSelectionBackground',
  'gh-list-hover': 'list.hoverBackground', 'gh-scroll': 'scrollbarSlider.background',
  'gh-scroll-hover': 'scrollbarSlider.hoverBackground', 'gh-scroll-active': 'scrollbarSlider.activeBackground',
  'gh-focus': 'focusBorder', 'gh-link': 'textLink.foreground', 'gh-widget': 'editorWidget.background',
  // 内置终端：GitHub 官方 terminal.* 令牌（ANSI 16 色 + 前景），不自己调色
  'gh-term-fg': 'terminal.foreground',
  'gh-term-black': 'terminal.ansiBlack', 'gh-term-red': 'terminal.ansiRed',
  'gh-term-green': 'terminal.ansiGreen', 'gh-term-yellow': 'terminal.ansiYellow',
  'gh-term-blue': 'terminal.ansiBlue', 'gh-term-magenta': 'terminal.ansiMagenta',
  'gh-term-cyan': 'terminal.ansiCyan', 'gh-term-white': 'terminal.ansiWhite',
  'gh-term-bblack': 'terminal.ansiBrightBlack', 'gh-term-bred': 'terminal.ansiBrightRed',
  'gh-term-bgreen': 'terminal.ansiBrightGreen', 'gh-term-byellow': 'terminal.ansiBrightYellow',
  'gh-term-bblue': 'terminal.ansiBrightBlue', 'gh-term-bmagenta': 'terminal.ansiBrightMagenta',
  'gh-term-bcyan': 'terminal.ansiBrightCyan', 'gh-term-bwhite': 'terminal.ansiBrightWhite',
};

function resolve(theme, scope) {
  let best = null, bestLen = -1;
  for (const r of themes[theme].tokenColors) {
    const scopes = Array.isArray(r.scope) ? r.scope : (r.scope ? [r.scope] : []);
    for (const s of scopes) {
      if (s === scope) { if (bestLen < 999) { best = r.settings; bestLen = 999; } }
      else if (scope.startsWith(s + '.') && s.length > bestLen && bestLen < 999) { best = r.settings; bestLen = s.length; }
    }
  }
  return best || {};
}

function block(theme, selector) {
  const c = themes[theme].colors;
  const lines = [];
  for (const [v, key] of Object.entries(UI_MAP)) if (c[key]) lines.push(`  --${v}: ${c[key]};`);
  for (const [cls, scope] of Object.entries(CLASS_SCOPE)) {
    const st = resolve(theme, scope);
    if (st.foreground) lines.push(`  --${cls}: ${st.foreground};`);
    const parts = String(st.fontStyle || '').split(/\s+/);
    if (parts.includes('italic')) lines.push(`  --${cls}-style: italic;`);
    if (parts.includes('bold')) lines.push(`  --${cls}-weight: 700;`);
    if (parts.includes('underline')) lines.push(`  --${cls}-deco: underline;`);
  }
  return `${selector} {\n${lines.join('\n')}\n}`;
}

const out = [
  '/* ==========================================================================',
  '   编辑器令牌：GitHub VS Code Theme（primer/github-vscode-theme, MIT）',
  '   由 src/theme.js + @primer/primitives 生成，非手调近似色。',
  '   light = GitHub Light Default（默认）；dark = GitHub Dark Default（可切换）',
  '   重新生成：node web/scripts/gen-editor-theme.cjs <theme-src-dir>',
  '   ========================================================================== */',
  block('light', ':root'),
  block('dark', ':root[data-editor-theme="dark"]'),
  '',
  '/* 语法类 → 令牌（fontStyle 一并还原：注释斜体、标题粗体等） */',
  ...Object.keys(CLASS_SCOPE).map((c) =>
    `.${c} { color: var(--${c}); font-style: var(--${c}-style, normal); font-weight: var(--${c}-weight, inherit); text-decoration: var(--${c}-deco, none); }`),
].join('\n') + '\n';

fs.writeFileSync(outFile, out);
console.log('已生成', outFile, out.split('\n').length, '行');
