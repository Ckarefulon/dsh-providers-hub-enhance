// 接线自检的用例 —— 存在的唯一理由是一次**真实事故**（2026-11-12）：
//
// 上一版补丁在 `lib/index.js` 里插了 `installExpiryFirst(ctx, pool);`，却没有配套的
// `import { installExpiryFirst } from './expiry-first.js';`。后果不是「功能不生效」，
// 而是 `apply()` 抛 `ReferenceError` ⇒ 同一函数里后面的 `registerJetHubRpc(...)`
// 从未执行 ⇒ `/api/jet-hub` 整条通道 404（面板全线 `transport failure`）。
//
// 三道既有防线全都拦不住它：
//   · 语法自检只**编译**，不解析标识符（`f()` 里 `f` 未定义是运行时错误）；
//   · 锚点守卫的所有锚点都正常命中了；
//   · 单元测试测的是资产模块本身，不是「被 import 进宿主之后」的接线。
//
// 故这里是**第 4 道**防线。用例必须覆盖三件事：
//   ① 真能抓住「调了但没 import」（就是那次事故的形态）；
//   ② 不误伤「同文件另一条补丁项注入定义」（客户端 bundle 的正常形态）；
//   ③ 不误伤多行 `import {` 块（`import` 关键字与名字不在同一行）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWiring, collectOwnNames, describeWiringFailure } from '../scripts/wiring-check.mjs';

/** 事故形态：调用了自有函数，但整个文件没有它的 import。 */
const ACCIDENT = `
import { somethingElse } from './other.js';

export function apply(ctx) {
    // 本补丁：装上「临期置顶」。
    installExpiryFirst(ctx, pool);
    registerJetHubRpc(ctx, pool, {});
}
`;

/** 修好之后：同名调用 + 配套 import。 */
const FIXED = `
import { somethingElse } from './other.js';
import { installExpiryFirst } from './expiry-first.js';

export function apply(ctx) {
    installExpiryFirst(ctx, pool);
    registerJetHubRpc(ctx, pool, {});
}
`;

test('抓住真实事故形态：调了自有函数却没 import', () => {
  const result = checkWiring(ACCIDENT, new Set(['installExpiryFirst']));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['installExpiryFirst']);
  // 诊断文案必须把「后果」写出来 —— 只说「少个 import」不足以让人意识到严重性。
  const message = describeWiringFailure('lib/index.js', result.missing);
  assert.match(message, /ReferenceError/);
  assert.match(message, /HTTP 404/);
});

test('配上 import 就通过（含多行 import 块）', () => {
  assert.equal(checkWiring(FIXED, new Set(['installExpiryFirst'])).ok, true);

  // ⚠️ 多行 import：`import` 关键字与名字**不在同一行**。按「同一行里既含 import
  //    又含名字」判会误报 —— 本项目真实的 resume 接线就是这个形态。
  const multiLine = `
import {
    readRateLimitResumeState,
    setRateLimitResumeArmed,
} from './rate-limit-resume.js';

export function handleMethod() {
    return readRateLimitResumeState(undefined);
}
`;
  assert.equal(checkWiring(multiLine, new Set(['readRateLimitResumeState'])).ok, true);
});

test('就地定义也算接线（客户端 bundle 的真实形态）', () => {
  // 客户端那边是「A 项调用、B 项用 anchor-asset 注入定义」，铺在同一个 bundle 顶层。
  const clientBundle = `
var JET_HUB_RPC_CHANNEL = "/jet-hub";

function installRateLimitResumeUi(options) {
  return { dispose: function () {} };
}

function apply(ctx) {
  ctx.effect(() => {
    const ui = installRateLimitResumeUi({ rpcCall });
    return () => { ui.dispose(); };
  }, "jet-hub: rate-limit resume ui");
}
`;
  assert.equal(checkWiring(clientBundle, new Set(['installRateLimitResumeUi'])).ok, true);
});

test('只查「自有名字」：上游自己的未定义调用不管', () => {
  // 判据刻意做得极窄：宁可漏报，也不要用「猜上游代码」换来一堆误报。
  const upstream = 'function f() { return someUpstreamHelper(1); }\n';
  assert.equal(checkWiring(upstream, new Set(['installExpiryFirst'])).ok, true);
});

test('collectOwnNames 两种资产形态都收（ESM export / CJS 片段）', () => {
  const hostAsset = 'export function installExpiryFirst(ctx) {}\nexport const SCHEMA = 1;\nexport async function later() {}\n';
  const clientAsset = 'function PhcResumeDefaultSwitch(props) {}\nvar PHC_RESUME_SLOT_ATTR = "x";\n';
  const names = collectOwnNames([hostAsset, clientAsset]);
  for (const expected of ['installExpiryFirst', 'SCHEMA', 'later', 'PhcResumeDefaultSwitch', 'PHC_RESUME_SLOT_ATTR']) {
    assert.ok(names.has(expected), `应收录 ${expected}`);
  }
});

test('真实资产 + 真实补丁产物：不得有任何接线缺失', async () => {
  // 有已装插件就顺手验一遍（升级后忘记重打也能在这里暴露）；没有就跳过。
  const { existsSync, readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');

  const own = collectOwnNames(
    ['assets/rate-limit-resume.js', 'assets/client-rate-limit-resume.js'].map((a) => readFileSync(join(root, a), 'utf8')),
  );
  const pkg = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-providers-hub');
  if (!existsSync(join(pkg, 'lib', 'rate-limit-resume.js'))) {
    // 没打补丁 / 没装插件：如实跳过（这不构成失败）。
    return;
  }
  for (const rel of ['lib/index.js', 'lib/jet-hub-rpc.js', 'lib/client/jet-hub.js']) {
    const text = readFileSync(join(pkg, rel), 'utf8');
    const result = checkWiring(text, own);
    assert.equal(result.ok, true, describeWiringFailure(rel, result.missing));
  }
});
