#!/usr/bin/env node
/**
 * 一条命令回答：「CodeBuddy 出站守卫此刻在不在工作」。
 *
 * 分三层判据（任一层失败都能说清是哪一层的事）：
 *
 * 1. **接线**：已装的 `dsh-providers-hub` 里，`lib/index.js` 有没有 `installCodeBuddyGuard(ctx)`、
 *    `lib/buddy-adapter.js` 的构造有没有 `guardCodeBuddyFetch(...)`、`lib/codebuddy-guard.js` 在不在；
 * 2. **模块**：真的 import 那个模块（它只依赖 node: 内置模块），跑一遍四段指纹改写；
 * 3. **安装**：在一个假 ctx 上装一次守卫，确认 `globalThis.fetch` 被替换、日志能落、再能卸掉。
 *
 * ⚠️ 它**不发网络请求**：真网关的 A/B 需要真实凭据（见 dsh-wb400-guard 的 `verify-live.mjs`），
 * 本脚本只验证「我们这半边有没有就位」。
 *
 * 用法：
 *   node scripts/verify-guard.mjs                 # 自动探测本机 profile
 *   node scripts/verify-guard.mjs --dir <包目录>   # 指定 dsh-providers-hub 包目录
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf('--dir');
const explicitDir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;

function findPackage() {
  const candidates = [];
  if (explicitDir !== undefined) candidates.push(resolve(explicitDir));
  for (const name of [process.env.DSH_PROFILE, 'desktop', 'web', 'default']) {
    if (typeof name !== 'string' || name === '') continue;
    candidates.push(join(homedir(), '.dsh', 'profiles', name));
  }
  for (const base of candidates) {
    for (const candidate of [base, join(base, 'node_modules', 'dsh-providers-hub'), join(base, 'dsh-providers-hub')]) {
      const manifest = join(candidate, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-providers-hub') {
        return candidate;
      }
    }
  }
  return null;
}

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
  if (!ok) problems.push(message);
};

const pkg = findPackage();
if (pkg === null) {
  console.error('找不到已安装的 dsh-providers-hub（用 --dir 指定包目录）');
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
console.log(`目标包 : ${pkg}`);
console.log(`版本   : dsh-providers-hub@${version}`);
console.log('');

/* ------------------------------------------------------------ 1. 接线 */

const modulePath = join(pkg, 'lib', 'codebuddy-guard.js');
check(existsSync(modulePath), 'lib/codebuddy-guard.js 存在');

const indexSource = existsSync(join(pkg, 'lib', 'index.js')) ? readFileSync(join(pkg, 'lib', 'index.js'), 'utf8') : '';
const adapterSource = existsSync(join(pkg, 'lib', 'buddy-adapter.js')) ? readFileSync(join(pkg, 'lib', 'buddy-adapter.js'), 'utf8') : '';
check(indexSource.includes('installCodeBuddyGuard(ctx)'), 'lib/index.js 的 apply() 里调用了 installCodeBuddyGuard(ctx)');
check(adapterSource.includes('guardCodeBuddyFetch(options.fetchImpl ?? fetch)'), 'lib/buddy-adapter.js 的构造包了 guardCodeBuddyFetch');

if (problems.length > 0) {
  console.log('');
  console.log('❌ 补丁没打完（或插件升级后被冲掉了）。跑一次 `node patch.mjs`，然后重启 DSH。');
  process.exit(1);
}

/* ------------------------------------------------------------ 2. 模块 */

const guard = await import(pathToFileURL(modulePath).href);

/** 四段指纹（2026-11-07 本机活的 DSH system prompt 原文）。 */
const identity = 'You are an AI agent powered by DeepSeek\u200B Harness.';
const persona = 'You are a coding agent powered by the buddy/hy4-preview model.';
const webSurface = 'You are interacting with the user through the DeepSeek\u200B Harness Web GUI '
    + 'whose URL the runtime context names.';
const webUrl = 'Current DeepSeek\u200B Harness Web GUI URL: "http://127.0.0.1:3807".';
const system = [identity, '', persona, '', guard.FILE_REFERENCE_PROMPT, '', webSurface, '', webUrl].join('\n');

const raw = JSON.stringify({ model: 'hy4-preview', stream: true, messages: [{ role: 'system', content: system }] });
const rewritten = guard.rewriteJsonBody(raw, 'anchor');
const after = rewritten.changed ? JSON.parse(rewritten.body).messages[0].content : system;
const brand = /DeepSeek[\s\u200B\u00A0\u2060\uFEFF]*Harness/;

check(rewritten.changed, '模块能改写四段齐备的 system prompt');
check(!after.includes('Tokens prefixed with @'), '指纹 1（文件引用段）已中性化');
check(!brand.test(after), '指纹 2 / 品牌词已中性化');
check(!/coding agent powered by/i.test(after), '指纹 3（persona 句式）已中性化');
check(!/DeepSeek\s*Harness\s*Web\s*GUI/i.test(after), '指纹 4（Web GUI 两段）已中性化');
check(guard.rewriteJsonBody(rewritten.body, 'anchor').changed === false, '改写是幂等的（第二遍不再变动）');
check(guard.isGuardedHost('copilot.tencent.com') && !guard.isGuardedHost('www.workbuddy.ai'), '作用域只含 copilot.tencent.com');

/* ------------------------------------------------------------ 3. 安装 */

const original = globalThis.fetch;
const fakeCtx = {
  logger: { info: (line) => console.log(`  [logger] ${line}`) },
  effect: (callback, label) => { fakeCtx.dispose = callback(); fakeCtx.label = label; },
};
const installed = guard.installCodeBuddyGuard(fakeCtx);
check(installed.installed === true, '守卫能装上');
check(globalThis.fetch !== original, 'globalThis.fetch 已被替换');
check(typeof fakeCtx.dispose === 'function', 'ctx.effect 拿到了卸载函数');
guard.uninstallCodeBuddyGuard();
check(globalThis.fetch === original, '卸载后 fetch 已还原');
console.log(`     日志 : ${installed.logPath}`);

console.log('');
if (problems.length === 0) {
  console.log('✅ 守卫已就位。宿主侧模块在启动时加载 —— 改完补丁要**重启 DSH** 才生效。');
  process.exit(0);
}
console.log(`❌ 有 ${problems.length} 项不通过（见上面的 FAIL 行）。`);
process.exit(1);
