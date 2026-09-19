/**
 * 按需注册语言的 highlight.js 实例。
 *
 * 为什么不直接 `import hljs from 'highlight.js'`：那是全量入口，会把 190+
 * 种语言定义整个打进包里。实测（esbuild, minified）：
 *
 *   全量入口 ............ 1055 KB
 *   core + 下面这些 ......   67 KB
 *
 * 而这份代码会在每个窗口的 WebView 进程里各解析常驻一份。产物里原本能搜到
 * erlang、fortran、verilog、smalltalk 这些在聊天里基本不会出现的语言。
 *
 * 语言清单对齐 FilePreview 里 CodeMirror 支持的那组，再补上聊天中常见的几种。
 * 需要新语言时在这里加一行即可 —— 代价是几 KB，不是一整个语言包。
 *
 * 副作用：`highlightAuto` 只会在已注册的语言里猜。这其实更准 —— 在 190 种
 * 里做自动识别对短代码片段经常猜错（FilePreview 当初换掉 highlightAuto 就是
 * 因为这个）。
 */

import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// 值是 [语言定义, ...别名]。别名要显式注册 —— 全量入口会自带，core 不会，
// 漏了的话 ```jsx 这种围栏就走不到高亮。
const LANGUAGES = {
  bash: [bash, 'sh', 'zsh'],
  c: [c, 'h'],
  cpp: [cpp, 'c++', 'hpp'],
  css: [css],
  diff: [diff, 'patch'],
  go: [go, 'golang'],
  java: [java],
  javascript: [javascript, 'js', 'jsx', 'mjs', 'cjs'],
  json: [json, 'jsonc'],
  markdown: [markdown, 'md'],
  python: [python, 'py'],
  rust: [rust, 'rs'],
  shell: [shell, 'console'],
  sql: [sql],
  typescript: [typescript, 'ts', 'tsx'],
  xml: [xml, 'html', 'svg', 'vue'],
  yaml: [yaml, 'yml'],
};

for (const [name, [definition, ...aliases]] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
  for (const alias of aliases) hljs.registerAliases(alias, { languageName: name });
}

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

export default hljs;
