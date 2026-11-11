// 接线自检：**补丁插入的每个「自有标识符调用」都必须能被解析**。
//
// ## 为什么需要它（真实事故，2026-11-12）
//
// 上一版补丁在 `lib/index.js` 里插入了 `installExpiryFirst(ctx, pool);`，**却没有**
// 配套的 `import { installExpiryFirst } from './expiry-first.js';` —— 那条 import 在
// 用脚本重写 `patch-data.json` 时被悄悄丢了。后果不是「功能不生效」，而是：
//
//   `apply()` 抛 `ReferenceError: installExpiryFirst is not defined`
//   → 后面那句 `registerJetHubRpc(...)` 从未执行
//   → `/api/jet-hub` 整条通道 404（面板全线报「transport failure」）
//
// ## 为什么既有的三道防线都拦不住
//
// | 防线 | 为什么漏掉 |
// |---|---|
// | 语法自检（`syntax-check.mjs`） | 只**编译**，不解析标识符 —— `f()` 里 `f` 未定义是**运行时**错误 |
// | 锚点守卫 | 锚点确实都命中了，产出的文件也「看起来对」 |
// | 单元测试 | 测的是资产模块本身，不是「资产被别人 import 之后」的接线 |
//
// 故这里补一条**机械**判据，判据本身刻意做得极窄（只查「本补丁自有名字」），
// 不去猜上游代码 —— 宁可漏报，也不要误报把好补丁挡下。
//
// ## 判据
//
// 对一个**已打好补丁的文件**：
//   若文本里存在 `自有名字(`（调用），则该文件必须满足其一：
//     ① 有 `import … { … 自有名字 … } …` 的**多行 import 块**；或
//     ② 就地定义（`function 名字(` / `const 名字 =` / `var` / `let` / `class`）。
//
// ⚠️ 判据②必须支持「**同文件的多条补丁项**」：客户端 bundle 就是「A 项调用、
//    B 项用 `anchor-asset` 注入定义」的形态 —— 在最终文件文本上判，天然满足。
//
// @module wiring-check
import { readFileSync } from 'node:fs';

/**
 * 从资产源码里抽出「本补丁自有」的顶层名字。
 *
 * 两种形态都要收：
 * - 宿主 ESM 资产：`export function foo` / `export const bar` / `export async function baz`；
 * - 客户端 CJS 片段资产：`function foo(` / `var bar =`（它没有 `export`，铺在 bundle 顶层）。
 *
 * @param sources - 资产源码文本数组。
 * @returns `Set<string>` 自有名字。
 */
export function collectOwnNames(sources) {
  const names = new Set();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

/** 该名字在这个文件里被**调用**吗（`名字(`）？ */
function isCalled(text, name) {
  return new RegExp(`\\b${name}\\s*\\(`).test(text);
}

/** 该名字在这个文件里被 import 了吗（支持多行 `import {` 块）？ */
function isImported(text, name) {
  return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 's').test(text);
}

/** 该名字在这个文件里就地定义了吗？ */
function isDefined(text, name) {
  return new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(text);
}

/**
 * 检查一个**已打补丁的**文件文本。
 *
 * @param text - 补丁后的完整文件文本。
 * @param ownNames - 本补丁自有名字集合（见 {@link collectOwnNames}）。
 * @returns `{ ok: true }` 或 `{ ok: false, missing: string[] }`。
 */
export function checkWiring(text, ownNames) {
  const missing = [];
  for (const name of ownNames) {
    if (!isCalled(text, name)) continue;
    if (isImported(text, name) || isDefined(text, name)) continue;
    missing.push(name);
  }
  return missing.length === 0 ? { ok: true, missing } : { ok: false, missing };
}

/**
 * 便捷包装：直接读资产文件、读目标文件，跑一遍检查。
 *
 * @param targetPath - 已被补丁改写的文件。
 * @param assetPaths - 本补丁的全部资产路径。
 */
export function checkFileWiring(targetPath, assetPaths) {
  const sources = assetPaths.map((asset) => readFileSync(asset, 'utf8'));
  return checkWiring(readFileSync(targetPath, 'utf8'), collectOwnNames(sources));
}

/** 人读的诊断文案。 */
export function describeWiringFailure(relPath, missing) {
  return `${relPath}: 插入了对本补丁自有函数的调用，但这些名字既没有 import 也没有就地定义：`
    + `${missing.join('、')}。`
    + '这会让宿主在 `apply()` 里抛 `ReferenceError`，整个 Jet Hub RPC 通道注册不上'
    + '（表现为面板全线 `transport failure for /api/jet-hub: HTTP 404`）。';
}
