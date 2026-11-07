// CI 用：校验 patch-data.json 的 schema 与资产齐全。
//
// 同样是独立脚本文件（理由见 scripts/ci-syntax-check.mjs 顶部注释）。

import fs from "node:fs";
import crypto from "node:crypto";

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const data = JSON.parse(fs.readFileSync("patch-data.json", "utf8"));
if (!Array.isArray(data.files) || data.files.length === 0) throw new Error("files 为空");

// 同一个路径允许多条（客户端 bundle 就是），故这里只校验**模式**与资产。
for (const file of data.files) {
  if (typeof file.path !== "string" || !file.path.startsWith("lib/")) {
    throw new Error("非法路径: " + String(file.path));
  }
  switch (file.mode) {
    case "file":
    case "create":
      if (!fs.existsSync(file.asset)) throw new Error("资产缺失: " + file.asset);
      if (sha(file.asset) !== file.patchedSha256) {
        throw new Error("资产哈希不符（先跑 npm run sync-hashes）: " + file.asset);
      }
      break;
    case "anchor":
      if (!Array.isArray(file.edits) || file.edits.length === 0) {
        throw new Error("anchor 无 edits: " + file.path);
      }
      for (const edit of file.edits) {
        if (!Array.isArray(edit.find) || !Array.isArray(edit.replace)) {
          throw new Error("锚点结构非法: " + file.path);
        }
      }
      break;
    case "anchor-asset":
      if (!fs.existsSync(file.asset)) throw new Error("资产缺失: " + file.asset);
      if (!Array.isArray(file.anchor) || file.anchor.length === 0) {
        throw new Error("anchor-asset 无 anchor: " + file.path);
      }
      if (!["before", "after"].includes(file.position)) {
        throw new Error("anchor-asset 的 position 非法: " + file.path);
      }
      if (typeof file.marker !== "string" || file.marker === "") {
        throw new Error("anchor-asset 缺 marker（幂等判据）: " + file.path);
      }
      break;
    default:
      throw new Error("未知 mode: " + String(file.mode));
  }
}

console.log("patch-data.json OK: " + data.files.length + " entries");
