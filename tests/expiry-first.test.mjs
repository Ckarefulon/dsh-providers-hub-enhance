// 宿主侧「临期置顶」的用例：判据、稳定序、以及**三条不写盘的红线**。
//
// ⚠️ 不能直接 `import '../assets/expiry-first.js'`：它 `import { resolveJetHubHome }
//    from './jet-hub-store.js'`，而那个文件只存在于**已安装的插件包**里（本仓库不含
//    providers-hub 的源码）。故按本仓库既有手法（见 `rate-limit-resume.test.mjs`）：
//    把 import 挖掉、`export` 去掉，在 `new Function` 沙箱里跑**同一份源码**。
//    测的仍然是资产本体，不是另写的等价实现。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'assets', 'expiry-first.js'), 'utf8');

const {
  packageExpiryMs,
  accountExpiryAt,
  sortAccountsByExpiry,
  createExpiryFirstEngine,
} = (() => {
  const body = SOURCE
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function|async function)/gm, '$1');
  const names = [
    'packageExpiryMs',
    'accountExpiryAt',
    'sortAccountsByExpiry',
    'createExpiryFirstEngine',
  ];
  // eslint-disable-next-line no-new-func -- 刻意的沙箱：这里没有真实依赖
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
})();

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 固定「现在」：所有断言都相对它算，不依赖真实时间。 */
const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);

/** 造一个还有余量的活动资源包。 */
const pkg = (remaining, endMs, extra = {}) => ({
  name: '活动积分',
  unit: '积分',
  remaining,
  total: remaining,
  used: 0,
  active: true,
  cycleStartTime: '',
  cycleEndTime: '',
  expiredTime: '',
  ...(endMs === undefined ? {} : { deductionEndTime: endMs }),
  ...extra,
});

const account = (id, nickname) => ({ id, nickname: nickname ?? id });
const credits = (packages) => ({ balance: { total: 0, packages } });

// ── 判据 ────────────────────────────────────────────────────────────────────

test('只取「有效且还有余量」的包里最早的到期时刻', () => {
  assert.equal(
    accountExpiryAt(credits([pkg(100, NOW + 5 * DAY), pkg(200, NOW + 2 * DAY)]), NOW),
    NOW + 2 * DAY,
  );

  // 空包 / 已失效的包**不算**：真机上「积分早就用完的号」否则会永远排第一。
  assert.equal(
    accountExpiryAt(credits([pkg(0, NOW + HOUR), pkg(300, NOW + 9 * DAY, { active: false })]), NOW),
    undefined,
  );

  // 已经过去的到期时刻不算（那批额度已经作废了）。
  assert.equal(accountExpiryAt(credits([pkg(100, NOW - HOUR)]), NOW), undefined);
});

test('没有 deductionEndTime 的包 = 永久，不是「马上过期」', () => {
  assert.equal(accountExpiryAt(credits([pkg(5000)]), NOW), undefined);
});

test('只有字符串 expiredTime 的渠道也能解析（officeace 那种形状）', () => {
  // ⚠️ 夹具用**本地时间**拼：`'YYYY-MM-DD HH:mm:ss'` 没有时区后缀，`Date.parse`
  //    按本地时区解释。用 `toISOString()` 拼会得到 UTC 文本，在 UTC+8 的机器上
  //    整整偏 8 小时 —— 那样测的是夹具的时区，不是被测函数的解析。
  const target = NOW + 3 * DAY;
  const d = new Date(target);
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  assert.equal(packageExpiryMs(pkg(80, undefined, { expiredTime: text })), target - (target % 1000));
});

test('余额没读到 / 查询失败 ⇒ 该账号算「不知道」，不编造 0', () => {
  assert.equal(accountExpiryAt(undefined, NOW), undefined);
  assert.equal(accountExpiryAt({ balance: null, error: '查询失败' }, NOW), undefined);
  assert.equal(accountExpiryAt(credits([]), NOW), undefined);
  assert.equal(packageExpiryMs(null), undefined);
  assert.equal(packageExpiryMs({}), undefined);
});

// ── 排序 ────────────────────────────────────────────────────────────────────

test('排序：临期最近的在前，无临期的按原有相对顺序垫底', () => {
  const plan = sortAccountsByExpiry(
    [account('a'), account('b'), account('c'), account('d')],
    {
      a: credits([pkg(10, NOW + 10 * DAY)]),
      b: credits([pkg(10)]), // 永久
      c: credits([pkg(10, NOW + 2 * DAY)]),
      d: { balance: null, error: '查询失败' },
    },
    NOW,
  );
  assert.deepEqual(plan.orderedIds, ['c', 'a', 'b', 'd']);
  assert.equal(plan.withExpiry, 2);
  assert.equal(plan.withoutExpiry, 2);
  assert.equal(plan.reordered, true);
});

test('稳定：同一天到期、以及都无临期时保持原有顺序', () => {
  const accounts = [account('x'), account('y')];
  const sameDay = { x: credits([pkg(10, NOW + DAY)]), y: credits([pkg(10, NOW + DAY)]) };
  assert.deepEqual(sortAccountsByExpiry(accounts, sameDay, NOW).orderedIds, ['x', 'y']);

  const none = sortAccountsByExpiry(accounts, {}, NOW);
  assert.deepEqual(none.orderedIds, ['x', 'y']);
  assert.equal(none.reordered, false);
});

test('已经是最优顺序时 reordered 为 false（不写盘）', () => {
  const plan = sortAccountsByExpiry(
    [account('soon'), account('later')],
    { soon: credits([pkg(10, NOW + DAY)]), later: credits([pkg(10, NOW + 20 * DAY)]) },
    NOW,
  );
  assert.deepEqual(plan.orderedIds, ['soon', 'later']);
  assert.equal(plan.reordered, false);
});

test('不就地排序调用方的数组', () => {
  const accounts = [account('b'), account('a')];
  const copy = accounts.slice();
  sortAccountsByExpiry(accounts, { a: credits([pkg(1, NOW + DAY)]) }, NOW);
  assert.deepEqual(accounts, copy);
});

// ── 引擎：三条「不写盘」红线 ────────────────────────────────────────────────

/** 造一个引擎 + 记录写盘调用。 */
function makeEngine(enabled = true) {
  const reorders = [];
  const saves = [];
  const engine = createExpiryFirstEngine({ enabled, save: (next) => saves.push({ ...next }) });
  const reorder = async (provider, orderedIds) => { reorders.push({ provider, orderedIds }); };
  return { engine, reorders, saves, reorder };
}

test('开关关闭时 apply 完全不碰顺序（连计划都不算）', async () => {
  const { engine, reorders, reorder } = makeEngine(false);
  const result = await engine.apply(
    'buddy',
    [account('a'), account('b')],
    { b: credits([pkg(10, NOW + DAY)]) },
    reorder,
  );
  assert.equal(result.applied, false);
  assert.equal(result.plan, undefined, '关闭就是不做任何工作');
  assert.equal(reorders.length, 0);
});

test('一个临期都算不出来 ⇒ 一个字都不写盘', async () => {
  // 这正是 `balance: null`（查询失败）与「没有临期」同形的那个坑：
  // 照排等于按 `undefined` 重排一遍，用户拖好的顺序会被一次查询失败打乱。
  const { engine, reorders, reorder } = makeEngine(true);
  const result = await engine.apply(
    'buddy',
    [account('a'), account('b')],
    { a: { balance: null, error: '查询失败' }, b: credits([pkg(10)]) },
    reorder,
  );
  assert.equal(result.applied, false);
  assert.equal(result.plan.withExpiry, 0);
  assert.equal(reorders.length, 0);
});

test('已经是最优顺序 ⇒ 不发 reorder', async () => {
  const { engine, reorders, reorder } = makeEngine(true);
  const result = await engine.apply(
    'buddy',
    [account('soon'), account('later')],
    { soon: credits([pkg(10, NOW + DAY)]), later: credits([pkg(10, NOW + 20 * DAY)]) },
    reorder,
  );
  assert.equal(result.applied, false);
  assert.equal(reorders.length, 0);
});

test('需要重排时写盘一次，且 id 集合与入参一致', async () => {
  const { engine, reorders, reorder } = makeEngine(true);
  const accounts = [account('later'), account('soon')];
  const result = await engine.apply(
    'buddy',
    accounts,
    { soon: credits([pkg(10, NOW + DAY)]), later: credits([pkg(10, NOW + 20 * DAY)]) },
    reorder,
  );
  assert.equal(result.applied, true);
  assert.equal(reorders.length, 1);
  assert.equal(reorders[0].provider, 'buddy');
  assert.deepEqual(reorders[0].orderedIds, ['soon', 'later']);
  // 集合不变只是顺序变 —— `reorderAccounts` 在宿主侧会校验这一点。
  assert.deepEqual(
    [...reorders[0].orderedIds].sort(),
    accounts.map((a) => a.id).sort(),
  );
});

test('顺序写失败只记日志、不上抛（余额不能被排序失败拖下水）', async () => {
  const { engine } = makeEngine(true);
  const result = await engine.apply(
    'buddy',
    [account('later'), account('soon')],
    { soon: credits([pkg(10, NOW + DAY)]), later: credits([pkg(10, NOW + 20 * DAY)]) },
    async () => { throw new Error('账号列表已变化，请刷新后重试'); },
  );
  assert.equal(result.applied, false);
  assert.equal(result.plan.withExpiry, 2, '计划仍然可用（两个号都有临期）');
});

test('开关切换会落盘，且幂等（同值不重复写）', () => {
  const { engine, saves } = makeEngine(false);
  assert.equal(engine.status().enabled, false);
  assert.equal(engine.setEnabled(true), true);
  assert.deepEqual(saves, [{ enabled: true }]);
  // 再拨一次同样的值：不该再写盘（避免无意义的 I/O）。
  assert.equal(engine.setEnabled(true), true);
  assert.equal(saves.length, 1);
  assert.equal(engine.setEnabled(false), false);
  assert.deepEqual(saves, [{ enabled: true }, { enabled: false }]);
});

test('默认关 —— 它会改写用户自己拖出来的顺序，未经同意不该自动动', async () => {
  const engine = createExpiryFirstEngine({});
  assert.equal(engine.status().enabled, false);
});
