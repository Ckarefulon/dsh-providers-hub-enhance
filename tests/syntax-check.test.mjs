// 进程内语法自检的用例：它现在是补丁器的**唯一**语法防线（`node --check` 需要
// 子进程，而 DSH 的 Windows 沙箱禁 `spawn`）。
//
// ⚠️ 这些用例必须同时覆盖「该拦的拦得住」与「不该拦的别误伤」—— 一个只会
// 说 ok 的检查器与一个乱报错的检查器，在补丁器里是同样有害的。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkFileSyntax, checkSyntax } from '../scripts/syntax-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('CJS：能编译就通过，语法错误被拦住', () => {
  assert.equal(checkSyntax('var a = 1;\nfunction f() { return a; }\n', { form: 'cjs' }).ok, true);
  const broken = checkSyntax('var a = ;\n', { form: 'cjs' });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /Unexpected token|missing/i);
});

test('ESM：能解析就通过，语法错误被拦住', () => {
  const good = "import { x } from './x.js';\nexport const y = 1;\nexport function f() {}\n";
  assert.equal(checkSyntax(good, { form: 'esm' }).ok, true);
  // ⚠️ 「缺右操作数」这种错误在任何形态下都会被 V8 抓到（包括退化判据）。
  const broken = checkSyntax('export const y = ;\n', { form: 'esm' });
  assert.equal(broken.ok, false, 'export 后面的空赋值必须被抓到');
  // 括号/花括号不配对同样两条判据都抓得到。
  assert.equal(checkSyntax("import { a } from 'x';\nfunction f() {\n", { form: 'esm' }).ok, false);
});

test('形态判据看**行首**关键字：注释/正文里出现 import 不算 ESM', () => {
  // 注释行提到 import：仍是 CJS（否则会把一堆正常文件误判成 ESM）。
  const commentOnly = '// this file imports nothing\nvar a = 1;\n';
  assert.equal(checkFileSyntax(commentOnly).form, 'cjs');
  assert.equal(checkFileSyntax(commentOnly).ok, true);

  const inlineMention = 'var note = "import x from y";\n';
  assert.equal(checkFileSyntax(inlineMention).form, 'cjs');
  assert.equal(checkFileSyntax(inlineMention).ok, true);

  const realEsm = "import { readFileSync } from 'node:fs';\nexport const a = 1;\n";
  assert.equal(checkFileSyntax(realEsm).form, 'esm');
  assert.equal(checkFileSyntax(realEsm).ok, true);
});

test('真实产物：宿主/客户端资产都通过', () => {
  const files = [
    ['assets/rate-limit-resume.js', 'esm'],
    ['assets/client-rate-limit-resume.js', 'cjs'],
    ['scripts/wiring-check.mjs', 'esm'],
    ['patch.mjs', 'esm'],
  ];
  for (const [rel, expectedForm] of files) {
    const source = readFileSync(join(HERE, '..', rel), 'utf8');
    const result = checkFileSyntax(source);
    assert.equal(result.ok, true, `${rel} 应通过语法检查：${result.message ?? ''}`);
    assert.equal(result.form, expectedForm, `${rel} 的形态判据`);
  }
});

test('退化判据（Node 18 无 vm.SourceTextModule）必须接受顶层 await', () => {
  // 这一条是 CI 红的直接原因：`tests/wiring-check.test.mjs` 与 `patch.mjs` 都会用到
  // `await import(...)`，而 Node 18 的 CI 分支没有 `--experimental-vm-modules`，
  // 只能走退化判据 —— 旧实现把它当成脚本函数体编译，于是合法的顶层 await 被误报。
  const topLevelAwait = "import { join } from 'node:path';\n"
    + "const fs = await import('node:fs');\n"
    + "export const probe = join('a', 'b');\n";
  const ok = checkSyntax(topLevelAwait, { form: 'esm', degraded: true });
  assert.equal(ok.ok, true, ok.message);

  // 但**非 async 函数里的 await** 仍然必须报错 —— 包一层 async IIFE 只放行
  // 「顶层」这一条 ESM 差异，不能顺手把真错误也放过。
  const insideSyncFn = 'export function f() {\n  await g();\n}\n';
  assert.equal(checkSyntax(insideSyncFn, { form: 'esm', degraded: true }).ok, false);
  // 常规语法错误在退化判据下照旧被抓到。
  assert.equal(checkSyntax('export const y = ;\n', { form: 'esm', degraded: true }).ok, false);

  // 真实资产在退化判据下也必须通过（复制 CI 在 Node 18 上跑的那条路径）。
  for (const rel of ['assets/rate-limit-resume.js', 'scripts/wiring-check.mjs', 'patch.mjs']) {
    const source = readFileSync(join(HERE, '..', rel), 'utf8');
    const result = checkSyntax(source, { form: 'esm', degraded: true });
    assert.equal(result.ok, true, `${rel} 在退化判据下也应通过：${result.message ?? ''}`);
  }
});

test('退化判据必须容忍 shebang（ESM 只在源文本第 0 位允许 `#!`）', () => {
  // `patch.mjs` 带 shebang。退化判据把残余体包进 async 箭头函数后，`#!` 会落到
  // 函数体中间 ⇒ 旧实现报「Invalid or unexpected token」。
  const shebang = '#!/usr/bin/env node\nconst a = 1;\nexport const b = a;\n';
  assert.equal(checkSyntax(shebang, { form: 'esm', degraded: true }).ok, true);
  // 非开头的 `#!` 仍应报错（不是「见到 #! 就放过」）。
  assert.equal(checkSyntax('const a = 1;\n#!oops\n', { form: 'esm', degraded: true }).ok, false);
});

test('客户端 bundle（含 CSS 模板字符串与 SVG 常量）仍判为 CJS 并编译通过', () => {
  // 这一块最容易被「形态判据」误伤：里面有 `import` 字样的注释、还有 CSS 里的
  // `{...}` 与正则。它必须被判成 CJS（宿主把它当 lazy-CJS 加载）。
  const block = readFileSync(join(HERE, '..', 'assets', 'client-rate-limit-resume.js'), 'utf8');
  assert.match(block, /^\/\/ plugin-src\/client\/rate-limit-resume\.js/m);
  const result = checkFileSyntax(block);
  assert.equal(result.form, 'cjs');
  assert.equal(result.ok, true);
});

test('CSS 片段会被拦下（它不是合法 JS）', () => {
  // assets/client-styles.js 是**插进**模板字符串里的 CSS 片段，不该被单独当 JS
  // 检查；但它万一被误当成 JS，检查器必须如实报错（而不是静默放行）。
  const css = readFileSync(join(HERE, '..', 'assets', 'client-styles.js'), 'utf8');
  assert.equal(checkFileSyntax(css).ok, false);
});
