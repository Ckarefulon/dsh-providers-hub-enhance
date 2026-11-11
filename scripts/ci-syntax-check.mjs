// CI 用：一次性校验「补丁器与新模块」的语法。
//
// 刻意做成**独立脚本文件**而不是 `node -e`：
//   `node -e` 里同时出现 `require` 与顶层 `await` 时，Node 无法判定模块格式，
//   直接抛 ReferenceError（Cannot determine intended module format）。
//   写成 .mjs 就没这个歧义，也不需要额外的 flag 组合推理。
//
// 走 checkFileSyntax（进程内 vm 判据），不 spawn 子进程——受限环境同样可用。

import fs from "node:fs";
import { checkFileSyntax } from "./syntax-check.mjs";

const targets = [
  "patch.mjs",
  "assets/rate-limit-resume.js",
  "assets/client-rate-limit-resume.js",
  "scripts/syntax-check.mjs",
  "scripts/wiring-check.mjs",
  "scripts/sync-hashes.mjs",
  "scripts/ci-syntax-check.mjs",
  "scripts/ci-verify-patch-data.mjs",
];

let failed = 0;
for (const rel of targets) {
  const result = checkFileSyntax(fs.readFileSync(rel, "utf8"));
  if (!result.ok) {
    failed += 1;
    console.error(`${rel} 语法错误: ${result.message ?? "(无消息)"}`);
    continue;
  }
  const extra = result.approximate ? ", 退化判据" : "";
  console.log(`${rel} OK (${result.form}${extra})`);
}

if (failed > 0) process.exit(1);
console.log(`语法检查通过：${targets.length} 个文件`);
