// 进程内的语法自检：不 spawn 子进程也能拦住语法错误。
//
// 为什么需要它：DSH 的 Windows 沙箱禁止 `spawn`（EPERM），而 `node --check` 是
// 子进程 —— 于是补丁器在受限环境里只能「如实跳过自检」，等于把语法错误留到重启
// 之后才炸（宿主侧模块语法错误会让 DSH 直接起不来）。
//
// ## 判据
//
// | 形态 | 判据 | 判别力 |
// |---|---|---|
// | **CJS**（客户端 bundle：顶层是 `window.__ModuleLoader__.load(...)`） | `vm.compileFunction`（只编译不执行） | **完整**：V8 真编译 |
// | **ESM**（宿主模块 / `patch.mjs`：顶层有 `import`/`export`） | ① 有 `vm.SourceTextModule`（需 `--experimental-vm-modules`）⇒ 真解析；② 否则「挖掉 ESM 语句 + `compileFunction`」 | ① 完整；② **近似**（见下） |
//
// ## ⚠️ 兜底路径（②）的已知盲区，如实登记
//
// 挖掉 `import`/`export` 之后的残余体仍然经过 V8 编译，故**绝大多数**语法错误
// （括号不配对、`const x = ;`、非法标识符、字符串未闭合……）照样被抓到。
// 抓不到的只有「本身就是 ESM 独有的语法问题」这一类（例如 `await` 用错层级、
// `export` 关键字拼错）。它们在本项目的产物里不会出现（我们只信任自己写的源码
// + 上游未被改动的部分）。
//
// 故：**能带上 `--experimental-vm-modules` 时判别力是全的**；CI 与本地 `npm test`
// 都带这个标志（见 package.json 的 test 脚本）。
//
// 判据本身**绝不执行代码**：`compileFunction` 与 `SourceTextModule` 都只解析/编译。

import vm from 'node:vm';

/** 语句起点：行首的 `import` / `export`（后接空白、`*`、`{`、`default` 或声明关键字）。 */
const ESM_STATEMENT_START = /^(?:import|export)\b/;

/** 去掉字符串与注释（保留**长度与换行**，便于按原偏移继续扫描）。 */
export function maskStringsAndComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let lastSignificant = '\n';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // 行注释
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // 正则字面量：只有当它出现在「表达式位置」时才当正则，否则 `/` 是除号。
    // ⚠️ 这一条很关键：客户端 bundle 里有大量 `/[a-z]/.test(...)`，把它当成注释
    //    会把后面的代码整段吞掉，进而漏掉语法错误。
    if (ch === '/' && (lastSignificant === '(' || lastSignificant === '=' || lastSignificant === ',' || lastSignificant === '[' || lastSignificant === ':' || lastSignificant === '!' || lastSignificant === '&' || lastSignificant === '|' || lastSignificant === '?' || lastSignificant === '{' || lastSignificant === ';' || lastSignificant === '\n')) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break;
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { j += 1; break; }
        j += 1;
      }
      // 看后面是否还有 flags
      while (j < n && /[a-z]/i.test(source[j])) j += 1;
      out += ' '.repeat(j - i);
      i = j;
      lastSignificant = 'x';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === quote) { out += ' '; i += 1; break; }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      lastSignificant = 'x';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    else if (ch === '\n') lastSignificant = '\n';
    i += 1;
  }
  return out;
}

/**
 * 从 `start` 处的 ESM 语句末尾返回下一个索引。
 *
 * 规则（都在**括号深度 0** 上判）：
 * - 遇到 `;` ⇒ 结束（保留分号）；
 * - 遇到换行 ⇒ 结束（**保留**这个换行，行号不漂）。
 *
 * ⚠️ 深度只在 0 才判：`import { … }` 的花括号把深度抬到 1，于是**跨行**具名导入
 * 不会被第一行的换行截断 —— 第一版按行正则正是死在这里（留下 `} from 'x';`）。
 *
 * @param masked - 已遮掉字符串与注释的源码（长度与原源码一致）。
 * @param start - 语句起点。
 * @returns 语句结束后的索引（至少 `start + 1`，保证外层循环前进）。
 */
function endOfEsmStatement(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ';') return i + 1;
    else if (depth === 0 && ch === '\n') return i;
  }
  return masked.length;
}

/**
 * 挖掉 / 弱化 ESM 语句，返回可当脚本编译的近似源码。
 *
 * 三种处理：
 *
 * | 语句形态 | 处理 | 为什么 |
 * |---|---|---|
 * | `import …` | **整条挖掉** | 残余的 `{ a } from 'x'` / `from 'x'` 不是合法脚本；而 import 本身不承载表达式 |
 * | `export default …` | 挖掉 `export default ` **两个词**，保留后面的内容 | 后面的部分是真实代码，删掉会把语法错误一起删掉 |
 * | `export { … }` / `export * from '…'` | 整条挖掉 | 它只声明导出，没有表达式 |
 * | `export <声明>` | 只挖掉 `export ` 一个词，保留声明 | 同上 —— 保留被导出的代码才能让 V8 真的编译到它 |
 *
 * ⚠️ 最后一条是**判别力**的关键：早期把整条 `export const y = ;` 当 ESM 语句挖掉，
 * 于是那些语法错误连看都看不到（用例里当场抓到）。
 *
 * @param source - ESM 源码。
 * @returns 近似源码（只用于兜底判据；见模块头的盲区说明）。
 */
export function stripEsmSyntax(source) {
  const masked = maskStringsAndComments(source);
  let out = '';
  let i = 0;
  const blank = (from, to) => source.slice(from, to).replace(/[^\n]/g, ' ');
  while (i < source.length) {
    // 只在**行首**认语句起点：避免把正文 / 注释里的 `export` 字样挖掉。
    //
    // ⚠️⚠️ 起点必须落在**关键字本身**，不能停在行首的缩进上：早期 `i` 是行首
    // 空白处，于是 `blank(i, wordEnd)` 挖掉的是「缩进 + `exp`」，留下 `rt const
    // X = …` —— 检查器自己造出一个语法错误（用例当场抓到）。故这里先算出关键
    // 字的实际下标。
    const lineStart = masked.lastIndexOf('\n', i - 1) + 1;
    const indentEnd = lineStart + /^[^\S\n]*/.exec(masked.slice(lineStart))[0].length;
    const atLineStart = indentEnd === i;
    if (atLineStart && ESM_STATEMENT_START.test(masked.slice(indentEnd, indentEnd + 20))) {
      const rest = masked.slice(indentEnd, indentEnd + 40);
      if (/^import\b/.test(rest)) {
        // import：整条挖掉。`import './x'` 没有 `;` 时按行结束。
        const end = Math.max(endOfEsmStatement(masked, indentEnd), indentEnd + 1);
        out += blank(indentEnd, end);
        i = end;
        continue;
      }
      if (/^export\s+default\s/.test(rest)) {
        // 只挖 `export default`，保留后面的表达式 / 声明（那才是真实代码）。
        const after = indentEnd + rest.indexOf('default') + 'default'.length;
        out += blank(indentEnd, after);
        i = after;
        continue;
      }
      if (/^export\s*(?:\{[^}]*\}|\*)/.test(rest)) {
        // 纯导出清单：整条挖掉。
        const end = Math.max(endOfEsmStatement(masked, indentEnd), indentEnd + 1);
        out += blank(indentEnd, end);
        i = end;
        continue;
      }
      // `export const|let|var|function|class…`：只挖 `export` 这一个词。
      const wordEnd = indentEnd + 'export'.length;
      out += blank(indentEnd, wordEnd);
      i = wordEnd;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/**
 * 检查一份源码的语法。
 *
 * @param source - 源码。
 * @param options - `{ form: 'cjs' | 'esm' }`。
 * @returns `{ ok: true }` / `{ ok: false, message }`。
 */
export function checkSyntax(source, options = {}) {
  if (options.form === 'esm') {
    if (typeof vm.SourceTextModule === 'function') {
      try {
        // 只构造：真的走 V8 的 ESM 解析器，不 link、不执行。
        new vm.SourceTextModule(source, { identifier: 'probe.mjs' });
        return { ok: true };
      }
      catch (error) {
        return { ok: false, message: `${error.name}: ${error.message}` };
      }
    }
    try {
      vm.compileFunction(withScriptSafeSubstitutions(stripEsmSyntax(source)), []);
      return { ok: true, approximate: true };
    }
    catch (error) {
      return { ok: false, message: `${error.message}（退化判据）` };
    }
  }
  try {
    vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname']);
    return { ok: true };
  }
  catch (error) {
    return { ok: false, message: `${error.name}: ${error.message}` };
  }
}

/**
 * 把「只有模块里合法」的语法换成**脚本里合法的等价物**（只用于退化判据）。
 *
 * 退化判据是把源码当脚本编译，而两种语法在脚本里必然报错：
 *
 * | 语法 | 换成 | 说明 |
 * |---|---|---|
 * | `import.meta` | `__importMeta` | 普通的「点属性」写法 |
 * | `import(` | `__import(` | 普通调用表达式 |
 *
 * ⚠️ 替换是**等长**的（用 `_` 补齐），行号与列号不漂，报错位置仍对得上原文件。
 *
 * @param source - 已剥离 ESM 语句的源码。
 * @returns 可当脚本编译的同长源码。
 */
function withScriptSafeSubstitutions(source) {
  return source
    .replace(/(?<![.\w$])import\.meta/g, (match) => '__importMeta'.padEnd(match.length, '_').slice(0, match.length))
    .replace(/(?<![.\w$])import\s*\(/g, (match) => '__import('.padEnd(match.length, ' ').slice(0, match.length));
}

/**
 * 按文件**内容**判断形态并检查。
 *
 * 判据：行首出现顶层 `import` / `export` 即 ESM。客户端 bundle 虽然也是 `.js`，
 * 但顶层是 `window.__ModuleLoader__.load(...)`，故判成 CJS。
 *
 * @param source - 源码。
 * @returns `{ ok, message?, form, approximate? }`。
 */
export function checkFileSyntax(source) {
  const masked = maskStringsAndComments(source);
  const hasEsm = /^(?:import|export)\b/m.test(masked.replace(/(^|\n)[\t ]*/g, '$1'));
  const form = hasEsm ? 'esm' : 'cjs';
  const result = checkSyntax(source, { form });
  return { ...result, form };
}
