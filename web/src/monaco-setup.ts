/**
 * Monaco 本地化配置：桌面 App 必须离线可用，绝不能走 @monaco-editor/react 默认的 CDN。
 * worker 用 Vite 的 ?worker 打包成独立 chunk，语法服务（TS/JSON/CSS/HTML）全部本地跑。
 */
// 中文语言包必须最先加载：它给 globalThis._VSCODE_NLS_MESSAGES 赋值，
// Monaco 的 nls.js 在 import 时读这个全局变量，晚一步菜单就是英文。
import 'monaco-editor/nls/lang/zh-cn';
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// 让 @monaco-editor/react 用打包进来的 monaco，而不是去 jsdelivr 拉
loader.config({ monaco });

export default monaco;
