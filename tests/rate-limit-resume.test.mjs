// 宿主侧「限流中断 → 解禁再继续」的**真跑**测试。
//
// 被测模块 `lib/rate-limit-resume.js` 只有在真宿主里才能 import（它要
// `@deepseek-ai/dsh-llm`）；故这里做两件事：
//   1. 从**资产源文件**里按函数名切出纯逻辑（`classifyRateLimitFailure` /
//      `nextResumeDelay` / `sanitizeHook` / `createRateLimitResumeEngine`），
//      在沙箱里跑完整生命周期；
//   2. 断言那些**真机事故**对应的判据（429 空体、额度耗尽、no-live-agent 放弃、
//      解禁时刻被推后要顺延、只在 open 时投递）。
//
// ⚠️ 这些用例存在的理由：引擎的每一步都是「定时器 + 状态迁移」，在真宿主里
// 只能靠等一小时观察，而它的分支（近乎）全都有明确的输入输出 —— 不测就等于
// 让「解禁后到底会不会续跑」永远没有实证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'assets', 'rate-limit-resume.js'), 'utf8');

/**
 * 假调度器：把 (task, delay) 收进数组，由测试自己把 `now` 往前拨再手动触发。
 *
 * ⚠️ 触发时**不**改 `now`：真实 `setTimeout` 到点就是「时钟已经走到那一刻」，
 * 故测试必须在 push 任务的同时把 `now` 拨到位（见各用例里的 `now += …`），
 * 否则 `attempt()` 里的 `current < resetAtMs - 1000` 会把它当成「被提前唤醒」
 * 而重新排一次 —— 那是**正确**的保护，不是缺陷。
 */
function makeScheduler() {
  const timers = [];
  return {
    timers,
    schedule(task, delay) {
      const handle = { task, delay };
      timers.push(handle);
      return handle;
    },
    cancel(handle) {
      const at = timers.indexOf(handle);
      if (at >= 0) timers.splice(at, 1);
    },
    /** 取出最早排的那个并执行（同时把时钟拨到它的触发时刻）。 */
    fireFirst(advanceNow) {
      const handle = timers.shift();
      assert.ok(handle, '没有待触发的定时器');
      advanceNow(handle.delay);
      handle.task();
      return handle;
    },
  };
}
function loadEngine() {
  // 去掉 import（沙箱里没有那些包），把 `export` 去掉（`new Function` 里不能有它）。
  const body = SOURCE
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function|async function)/gm, '$1');
  const names = [
    'classifyRateLimitFailure',
    'resetAtFromFailure',
    'nextResumeDelay',
    'sanitizeHook',
    'createRateLimitResumeEngine',
    'RATE_LIMIT_RESUME_PROMPT',
    'RATE_LIMIT_RESUME_SOURCE_KIND',
  ];
  // eslint-disable-next-line no-new-func -- 这是**刻意的**沙箱：沙箱里没有真实依赖
  const factory = new Function(`${body}\nreturn { ${names.join(', ')} };`);
  return factory();
}

test('429（空体、无文案）与额度耗尽都被判为「等解禁」类', () => {
  const engine = loadEngine();
  // 网关/CDN 会回空体 429：任何文案判据都不命中，只有状态码能判。
  assert.equal(engine.classifyRateLimitFailure({ code: 'HTTP_429', message: '', status: 429 }), 'rate');
  assert.equal(engine.classifyRateLimitFailure({ code: 'RATE_LIMIT', message: 'x' }), 'rate');
  assert.equal(engine.classifyRateLimitFailure({ code: 'x', message: 'too many requests', status: 429 }), 'rate');
  assert.equal(engine.classifyRateLimitFailure({ code: 'QUOTA', message: 'no credits' }), 'quota');
  assert.equal(engine.classifyRateLimitFailure({ code: 'ACCOUNT_QUOTA', message: '' }), 'quota');
  assert.equal(engine.classifyRateLimitFailure({ code: 'x', message: '14018 Credits exhausted' }), 'quota');
  assert.equal(engine.classifyRateLimitFailure({ code: 'x', message: '积分不足' }), 'quota');
  // 不该被误判的：参数错、认证、普通 5xx。
  assert.equal(engine.classifyRateLimitFailure({ code: 'INVALID_REQUEST', message: 'bad args', status: 400 }), undefined);
  assert.equal(engine.classifyRateLimitFailure({ code: 'AUTH', message: 'expired', status: 401 }), undefined);
  assert.equal(engine.classifyRateLimitFailure({ code: 'SERVER', message: 'internal', status: 500 }), undefined);
  assert.equal(engine.classifyRateLimitFailure(null), undefined);
  assert.equal(engine.classifyRateLimitFailure('429'), undefined);
});

test('providerRetryAfterMs 转成绝对解禁时刻；非法值不认', () => {
  const engine = loadEngine();
  const now = 1_000_000;
  assert.equal(engine.resetAtFromFailure({ providerRetryAfterMs: 60_000 }, now), now + 60_000);
  assert.equal(engine.resetAtFromFailure({ providerRetryAfterMs: 0 }, now), undefined);
  assert.equal(engine.resetAtFromFailure({ providerRetryAfterMs: -1 }, now), undefined);
  assert.equal(engine.resetAtFromFailure({}, now), undefined);
});

test('等待时长夹在 [5 秒, 48 小时]，不产生「立即触发」的怪值', () => {
  const engine = loadEngine();
  const now = Date.now();
  // 解禁时刻已过 ⇒ 至少等 5 秒（否则会在同一轮里连打）。
  assert.equal(engine.nextResumeDelay(now, now - 3600_000), 5000);
  assert.equal(engine.nextResumeDelay(now, now + 60_000), 60_000);
  // 超过 48 小时 ⇒ 截断（Node 的 setTimeout 对 >2^31-1 会给 1ms 警告并立即触发）。
  assert.equal(engine.nextResumeDelay(now, now + 100 * 3600_000), 48 * 3600_000);
});

test('引擎：中断 → 到点投递成功 → 钩子被清掉', () => {
  const engine = loadEngine();
  let now = 1_000_000;
  const timers = [];
  const delivered = [];
  const persisted = [];

  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: (task, delay) => { const handle = { task, delay, at: now + delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    persist: () => persisted.push(api.status()),
    deliver: (hook) => { delivered.push(hook); return { ok: true }; },
    enabled: true,
  });

  const hook = api.noteInterruption({ sessionId: 'session-a', turn: 3, provider: 'raccoon', model: 'm', kind: 'rate', resetAtMs: now + 60_000 });
  assert.equal(hook.armed, true, '默认开启时新钩子是 armed');
  assert.equal(timers.length, 1, '应排上一个定时器');

  now += 60_000;
  const pending = timers.splice(0)[0];
  pending.task();
  assert.equal(delivered.length, 1);
  assert.equal(api.status().hooks.length, 0, '投递成功后钩子应被清掉');
});

test('引擎：解禁时刻已被池推后 ⇒ 顺延而不是硬投', () => {
  const engine = loadEngine();
  let now = 1_000_000;
  const timers = [];
  let delivered = 0;
  const readReset = () => now + 3600_000; // 池里仍写着「一小时后才解禁」

  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: (task, delay) => { const handle = { task, delay, at: now + delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    readReset,
    deliver: () => { delivered += 1; return { ok: true }; },
    enabled: true,
  });

  api.noteInterruption({ sessionId: 'session-b', turn: 1, kind: 'rate', resetAtMs: now + 60_000 });
  now += 60_000;
  timers.splice(0)[0].task();
  assert.equal(delivered, 0, '池说仍未解禁时不该投递');
  assert.equal(api.status().hooks[0].deferrals, 1);
  assert.equal(api.status().hooks[0].resetAtMs, now + 3600_000, '解禁时刻应被顺延到池里的值');
});

test('引擎：没有 live agent 时直接放弃（不是无限重试）', () => {
  const engine = loadEngine();
  let now = 1_000_000;
  const timers = [];
  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: (task, delay) => { const handle = { task, delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    deliver: () => ({ ok: false, reason: 'no-live-agent' }),
    enabled: true,
  });

  api.noteInterruption({ sessionId: 'session-c', turn: 1, kind: 'rate', resetAtMs: now + 10_000 });
  now += 10_000;
  timers.splice(0)[0].task();
  assert.equal(api.status().hooks.length, 0, '会话已不在内存 ⇒ 直接放弃');
  assert.equal(timers.length, 0, '不该再排定时器');
});

test('引擎：其他投递失败（agents 未就绪）会按 5 分钟重试，且不丢钩子', () => {
  const engine = loadEngine();
  let now = 1_000_000;
  const timers = [];
  let attempts = 0;
  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: (task, delay) => { const handle = { task, delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    deliver: () => { attempts += 1; return { ok: false, reason: 'agents-unavailable' }; },
    enabled: true,
  });

  api.noteInterruption({ sessionId: 'session-d', turn: 1, kind: 'rate', resetAtMs: now + 10_000 });
  now += 10_000;
  timers.splice(0)[0].task();
  assert.equal(attempts, 1);
  assert.equal(api.status().hooks.length, 1, '钩子要留着等下次重试');
  assert.equal(timers.length, 1, '应排上重试定时器');
});

test('引擎：关掉 armed 会撤掉定时器；再打开按最小延迟重排', () => {
  const engine = loadEngine();
  let now = 1_000_000;
  const timers = [];
  let delivered = 0;
  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: (task, delay) => { const handle = { task, delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    deliver: () => { delivered += 1; return { ok: true }; },
    enabled: true,
  });

  api.noteInterruption({ sessionId: 'session-e', turn: 1, kind: 'rate', resetAtMs: now + 60_000 });
  assert.equal(timers.length, 1);

  const off = api.setArmed('session-e', false);
  assert.equal(off.armed, false);
  assert.equal(timers.length, 0, '关掉后不该再有定时器');

  now += 120_000; // 解禁时刻已过
  const on = api.setArmed('session-e', true);
  assert.equal(on.armed, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000, '解禁时刻已过 ⇒ 按最小延迟重排，不立刻投递');
  assert.equal(delivered, 0);
});

test('引擎：新回合 / 用户消息会撤掉待续跑记录', () => {
  const engine = loadEngine();
  const timers = [];
  const api = engine.createRateLimitResumeEngine({
    now: () => 1_000_000,
    schedule: (task, delay) => { const handle = { task, delay }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    deliver: () => ({ ok: true }),
    enabled: true,
  });

  api.noteInterruption({ sessionId: 's1', turn: 1, kind: 'rate', resetAtMs: 1_100_000 });
  assert.equal(api.status().hooks.length, 1);
  api.noteTurnStart('s1');
  assert.equal(api.status().hooks.length, 0, '宿主开了新回合 ⇒ 不再等');
  assert.equal(timers.length, 0);

  api.noteInterruption({ sessionId: 's2', turn: 1, kind: 'rate', resetAtMs: 1_100_000 });
  api.noteUserMessage('s2');
  assert.equal(api.status().hooks.length, 0, '用户手动发消息 ⇒ 不再等');
});

test('引擎：默认关闭时新钩子不 armed，也不排定时器', () => {
  const engine = loadEngine();
  const timers = [];
  const api = engine.createRateLimitResumeEngine({
    now: () => 1_000_000,
    schedule: (task, delay) => { const handle = { task, delay }; timers.push(handle); return handle; },
    cancel: () => {},
    deliver: () => ({ ok: true }),
    enabled: false,
  });

  const hook = api.noteInterruption({ sessionId: 's3', turn: 1, kind: 'rate', resetAtMs: 1_100_000 });
  assert.equal(hook.armed, false);
  assert.equal(timers.length, 0, '默认关 ⇒ 不排定时器');
  // 用户点成「自动继续」后才排上。
  api.setArmed('s3', true);
  assert.equal(timers.length, 1);
});

test('引擎：改全局默认只影响之后的中断（不追溯已有钩子）', () => {
  const engine = loadEngine();
  const api = engine.createRateLimitResumeEngine({
    now: () => 1_000_000,
    schedule: () => ({ task: () => {}, delay: 0 }),
    cancel: () => {},
    deliver: () => ({ ok: true }),
    enabled: true,
  });

  api.noteInterruption({ sessionId: 's4', turn: 1, kind: 'rate', resetAtMs: 1_100_000 });
  api.setEnabled(false);
  const status = api.status();
  assert.equal(status.enabled, false, '全局默认已关');
  assert.equal(status.hooks[0].armed, true, '已挂着的钩子保持原状态（用户可能刚点过它）');
});

test('引擎：restore 会丢掉无效/过旧记录，保留有效记录', () => {
  const engine = loadEngine();
  const now = 1_000_000;
  const api = engine.createRateLimitResumeEngine({
    now: () => now,
    schedule: () => ({ task: () => {}, delay: 0 }),
    cancel: () => {},
    deliver: () => ({ ok: true }),
    enabled: true,
  });

  api.restore([
    { sessionId: 'ok', turn: 2, kind: 'rate', resetAtMs: now + 60_000, armed: false },
    { sessionId: '', turn: 1, resetAtMs: now + 60_000 }, // 空 sessionId
    { sessionId: 'no-reset', turn: 1 }, // 缺解禁时刻
    { sessionId: 'stale', turn: 1, resetAtMs: now - 100 * 3600_000, kind: 'rate', armed: true }, // 100 小时前
    null,
    'nope',
  ]);
  const keys = api.status().hooks.map((hook) => hook.sessionId);
  assert.deepEqual(keys, ['ok'], '只该保留那一条有效记录');
  assert.equal(api.status().hooks[0].armed, false, 'persist 下来的 armed 要保留');
});

test('引擎：dispose 幂等且清掉所有定时器', () => {
  const engine = loadEngine();
  const timers = [];
  const api = engine.createRateLimitResumeEngine({
    now: () => 1_000_000,
    schedule: (task) => { const handle = { task }; timers.push(handle); return handle; },
    cancel: (handle) => { const at = timers.indexOf(handle); if (at >= 0) timers.splice(at, 1); },
    deliver: () => ({ ok: true }),
    enabled: true,
  });
  api.noteInterruption({ sessionId: 's5', turn: 1, kind: 'rate', resetAtMs: 1_100_000 });
  api.dispose();
  api.dispose(); // 第二次不该抛
  assert.equal(timers.length, 0);
  assert.equal(api.status().hooks.length, 0);
});

test('续跑消息的 source 是自己的标识，绝不能冒充 user', () => {
  const engine = loadEngine();
  assert.equal(engine.RATE_LIMIT_RESUME_SOURCE_KIND, 'rate-limit-resume');
  assert.notEqual(engine.RATE_LIMIT_RESUME_SOURCE_KIND, 'user');
  assert.match(engine.RATE_LIMIT_RESUME_PROMPT, /限流/);
  // 提示里不能出现 harness 内部词汇（那是给用户看的诊断，模型不需要）。
  assert.doesNotMatch(engine.RATE_LIMIT_RESUME_PROMPT, /钩子|解禁时刻|armed/);
});
