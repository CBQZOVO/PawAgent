// ============================================================================
// 多语言源码词法清洗与注释剥离工具（dep-graph/text.ts）
// ============================================================================
// 为什么不能直接拿正则去扫源码里的 import？
//   1. 注释里经常留着废弃代码，例如 `// import './old.js'`，不剥掉注释就会画出不存在的假依赖边；
//   2. 字符串/文档注释里也可能写示例代码，例如 Python docstring 里的 `"""from foo import bar"""`；
//   3. URL 字符串 `"https://example.com"` 里含有 `//`，如果粗暴用正则删 `//.*`，会把字符串拦腰截断；
//   4. Rust 里的生命周期 `'a`、`&'static str` 带有孤立的单引号，不能当成普通单引号字符串。
// 因此这里用极轻量的逐字符状态机，按语言家族精确剥离注释，再交给 resolvers.ts 解析依赖。

/**
 * 剥离类 C 语言（JS / TS / Java / Kotlin / Go / C / C++）的 // 行注释与 /* 块注释 * /。
 *
 * 参数说明：
 *   - allowBacktick：JS/TS 和 Go 支持反引号字符串（`...`），Java/C++ 不支持；
 *   - stripStringBodies：
 *       * 设为 false（默认）：保留字符串内容（例如 `import './foo'` 里的 './foo' 需要留着提取）；
 *       * 设为 true：把字符串内部替换为空格（供 Java/Kotlin 扫标识符时用，避免把字符串里的类名误当成代码引用）。
 */
export function stripCLikeComments(
  code: string,
  opts: { allowBacktick?: boolean; stripStringBodies?: boolean } = {},
): string {
  const allowBacktick = opts.allowBacktick ?? true;
  const stripBodies = opts.stripStringBodies ?? false;
  let out = '';
  let i = 0;
  let quote: "'" | '"' | '`' | null = null; // 记录当前是否正处在某个引号内部

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    // 如果当前在引号里：遇到反斜杠转义就一次跳过两个字符，遇到配对引号才退出字符串态
    if (quote) {
      if (quote !== '`' && ch === '\\' && i + 1 < code.length) {
        out += stripBodies ? '  ' : ch + code[i + 1];
        i += 2;
        continue;
      }
      if (quote === '`' && ch === '\\' && i + 1 < code.length) {
        out += stripBodies ? '  ' : ch + code[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        out += ch;
        quote = null;
        i++;
        continue;
      }
      // 保留换行符，避免行号错乱或把相邻两行语句粘成一行
      out += ch === '\n' ? '\n' : (stripBodies ? ' ' : ch);
      i++;
      continue;
    }

    // 非字符串态：进入引号
    if (ch === "'" || ch === '"' || (allowBacktick && ch === '`')) {
      quote = ch as "'" | '"' | '`';
      out += ch;
      i++;
      continue;
    }
    // 遇到行注释 //：一路跳到行尾换行符
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    // 遇到块注释 /* ... */：一路跳到 */，中途保留换行符
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 快捷封装：剥离 JS/TS 行注释与块注释（保留字符串字面量） */
export function stripJsComments(code: string): string {
  return stripCLikeComments(code, { allowBacktick: true, stripStringBodies: false });
}

/**
 * 专用于 Rust 的注释剥离器。与类 C 语言有三个关键差异：
 *   1. Rust 原生字符串写法是 r#"..."#（前后 # 数量必须配对）；
 *   2. Rust 的单引号 `'a` / `'static` 是生命周期标注，不是字符串！只有 `'x'` 或 `'\n'` 才是字符字面量；
 *   3. Rust 允许块注释嵌套（外层块注释里还可以再套一层块注释），需要用 depth 计数配对。
 */
export function stripRustComments(code: string): string {
  let out = '';
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    // 1) 原生字符串：r"..." 或 r#"..."# / r##"..."##
    if (ch === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let k = i + 1;
      while (k < code.length && code[k] === '#') { hashes++; k++; }
      if (code[k] === '"') {
        const closeSeq = '"' + '#'.repeat(hashes);
        const endIdx = code.indexOf(closeSeq, k + 1);
        if (endIdx >= 0) {
          out += code.slice(i, endIdx + closeSeq.length);
          i = endIdx + closeSeq.length;
          continue;
        }
      }
    }

    // 2) 普通双引号字符串 "..."
    if (ch === '"') {
      out += ch;
      i++;
      while (i < code.length) {
        const c = code[i];
        out += c;
        if (c === '\\' && i + 1 < code.length) {
          out += code[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }

    // 3) 单引号：先判断是否是字符字面量（'a' 或 '\n' / '\u{...}'），否则按生命周期符号直接放行
    if (ch === "'") {
      if (next === '\\') {
        const closeQuote = code.indexOf("'", i + 2);
        if (closeQuote > i && closeQuote - i <= 10) {
          out += code.slice(i, closeQuote + 1);
          i = closeQuote + 1;
          continue;
        }
      } else if (i + 2 < code.length && code[i + 2] === "'") {
        out += code.slice(i, i + 3);
        i += 3;
        continue;
      }
      // 生命周期标注（如 fn serve<'a>(c: Config<'a>)），原样输出，不进入字符串状态
      out += ch;
      i++;
      continue;
    }

    // 4) 行注释 //
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }

    // 5) 可嵌套块注释 /* ... */
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (code[i] === '/' && code[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (code[i] === '*' && code[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (code[i] === '\n') out += '\n';
          i++;
        }
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * 剥离 Python 的 `#` 行注释以及单引号/双引号/三引号（docstring）正文内容，替换为占位符 `""`。
 * 作用：Python 文档字符串里经常写用法示例 `"""\nfrom . import foo\n"""`，
 * 把字符串内容清空但保留换行后，后续的 import 解析器就不会被示例代码骗出假边。
 */
export function stripPythonCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;

  while (i < code.length) {
    const ch = code[i];

    // 遇到 # 行注释，跳到换行符
    if (ch === '#') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }

    // 遇到引号：区分三引号（''' / """）和普通单行引号（' / "）
    if (ch === "'" || ch === '"') {
      const triple = code[i + 1] === ch && code[i + 2] === ch;
      const delim = triple ? ch.repeat(3) : ch;
      out += '""';
      i += delim.length;
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (triple ? code.startsWith(delim, i) : (code[i] === ch || code[i] === '\n')) {
          if (!triple && code[i] === '\n') {
            out += '\n';
            i++;
          } else {
            i += delim.length;
          }
          break;
        }
        if (code[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** 提取 .vue / .svelte 单文件组件里的所有 <script>...</script> 代码块，忽略 HTML 模板与 CSS */
export function extractSfcScripts(code: string): string {
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks.length ? blocks.join('\n') : code;
}

/**
 * 提取清洗后源码中的全部单词标识符，放入 Set（查询 O(1)）。
 * 用途：Java/Kotlin 同包下的两个文件互相调用类不需要写 import，
 * 扫一遍本文件的标识符集合，就能快速判断它是否引用了同包兄弟文件里声明的类名。
 */
export function extractIdentifiers(cleanCode: string): Set<string> {
  const set = new Set<string>();
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleanCode)) !== null) {
    set.add(m[0]);
  }
  return set;
}
