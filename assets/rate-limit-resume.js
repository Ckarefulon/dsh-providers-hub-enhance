/**
 * 宿主侧：「会话因限流中断 → 解禁后自动继续」。
 *
 * ## 它做的事
 *
 * 1. 听宿主进程内的**会话事件 firehose**（`session/event`），在 `turn/end` 且
 *    `reason.kind === 'error'` 时判一次失败类别（见 {@link classifyRateLimitFailure}）。
 * 2. 属于限流 / 额度类 ⇒ 为该会话记一条待续跑钩子，解禁时刻按三条来源取最保守的一条：
 *    ① `providerRetryAfterMs`（服务端指定的机器通道）；
 *    ② 账号池里该 provider+模型**未来最晚**的限流标记（providers-hub 自己写的）；
 *    ③ 兜底 1 小时。
 * 3. 到点后先**复核**池里是否仍未解禁（被推后则顺延），再经 `agent.followup` 投递一条
 *    续跑消息。投递失败的形态分两类：`no-live-agent`（会话已不在内存）直接放弃，
 *    其余按 {@link DELIVER_RETRY_MS} 重试。
 * 4. 通过 `jet-hub-rpc.js` 的三条新端点（`resume.getState` / `resume.setArmed` /
 *    `resume.setEnabled`）把状态交给客户端：报错行尾的图标按钮与 Jet Hub 设置页的
 *    总开关都走这里。
 *
 * ## ⚠️ 为什么续跑消息**不能**标成 `source.kind === 'user'`
 *
 * 与 `loop-recovery.ts` 的 `LOOP_RESUME_SOURCE_KIND` 完全同一个理由（那边有完整论述）：
 * `source.kind === 'user'` 是宿主对「直接人类输入」的**证明**，`tool-goal` 的
 * 增删改都据此授权；伪造成 user 等于让自动续跑**冒用人类授权**。这里用自己的
 * 来源标识 {@link RATE_LIMIT_RESUME_SOURCE_KIND}，如实署名。
 *
 * ## ⚠️ 为什么钩子要落盘
 *
 * 「等 1 小时」这件事**必然跨越宿主重启**（DSH 一天重启几次很正常）。只在内存里
 * 记的钩子会随进程消失，用户第二天回来看到的就是「什么都没发生」。故写
 * `$DSH_HOME/jet-hub/rate-limit-resume.json`，启动时恢复 —— 与 `badge-preferences`
 * 同目录、同原子写惯例（tmp + rename）。
 *
 * ## ⚠️ 为什么不改 `jet-hub-rpc.ts` 的函数签名
 *
 * 那边的注释明令禁止给它加位置形参（「可选的**位置**形参会静默把表落进错位置」，
 * 本仓库实测复发 6 次）。故控制器放在模块级单例上，由本文件导出、RPC 侧
 * `import { … } from './rate-limit-resume.js'` 现读 —— 与 `provider-runtime.ts` 的
 * 全局注册表同一手法。
 *
 * @module rate-limit-resume
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveJetHubHome } from './jet-hub-store.js';

/** 续跑消息**自有**的来源标识（理由见模块头）。 */
export const RATE_LIMIT_RESUME_SOURCE_KIND = 'rate-limit-resume';

/**
 * 续跑消息正文（模型可见且会落盘）。
 *
 * 按「给模型的指令」写：①继续未完成的任务；②上一轮为什么停了（限流，**不是**
 * 任务做完）；③不要重复已经完成的部分。不写 harness 内部词汇（「钩子」「解禁时刻」）
 * —— 那是给用户看的诊断。
 */
export const RATE_LIMIT_RESUME_PROMPT = '继续未完成的任务。上一轮因为服务端限流/额度限制被中断，'
    + '现在已经解禁 —— 请接着刚才的进度推进，不要重复已经完成的部分。';

/** 持久化文档的文件名（与 `ui-preferences.json` 同目录）。 */
export const RATE_LIMIT_RESUME_FILE = 'rate-limit-resume.json';
const SCHEMA = 'dsh-providers-hub-enhance/rate-limit-resume/v1';

/** 失败类别：限流（429 / RATE_LIMIT）。 */
const CLASS_RATE = 'rate';
/** 失败类别：额度耗尽（积分 / 余额 / 配额）。 */
const CLASS_QUOTA = 'quota';

/** 解禁时刻拿不到时的兜底等待时长（1 小时，与 providers-hub 的 429 冷却同档）。 */
const DEFAULT_RESET_WAIT_MS = 60 * 60 * 1000;
/** 最早多久之后才允许续跑（防「解禁时刻已过」时在同一轮里连打）。 */
const MIN_FIRE_DELAY_MS = 5 * 1000;
/** 最长一次等待（`setTimeout` 超过 2^31-1 会给 1ms 警告并立即触发 —— 那是真实的醒来太早缺陷）。 */
const MAX_RESET_WAIT_MS = 48 * 60 * 60 * 1000;
/** 同一钩子最多推迟/重试多少次，超过就放弃（防「解禁时刻被反复推后」无限循环）。 */
const MAX_DEFERRALS = 24;
/** 投递失败（例如宿主里暂时没有 live agent）后重试的间隔。 */
const DELIVER_RETRY_MS = 5 * 60 * 1000;
/** 同时挂着的钩子上限（正常使用远达不到，纯粹防止异常场景无限增长）。 */
const MAX_HOOKS = 64;

/** 「频率限制」的自然语言兜底（与 providers-hub 的 `RATE_LIMIT_PATTERN` 同口径加少量变体）。 */
const RATE_TEXT_PATTERN = /频率限制|频率超出|使用量已超出|请求过于频繁|too\s+many\s+requests|rate[\s_-]?limit|frequency\s+limit|usage\s+exceeds|throttl/i;
/** 「额度耗尽」的自然语言兜底。 */
const QUOTA_TEXT_PATTERN = /14018|credits?\s+exhausted|配额|额度|积分(不足|耗尽|用尽)|余额(不足|耗尽)|insufficient\s+(quota|balance|credits?)|quota\s+(exceeded|exhausted)|out\s+of\s+credits?/i;

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断一次 `turn/end` 的失败载荷是否属于「等解禁」类。
 *
 * ## 判据顺序必须是「结构化 → 状态码 → 文案」
 *
 * 结构化码（`RATE_LIMIT` / `QUOTA` / `ACCOUNT_QUOTA`）与 HTTP 429 是**与语言无关**
 * 的事实；文案兜底只服务于那些把错误塞进正文的渠道（providers-hub 的十来个适配器
 * 各有各的形态，且部分渠道的限流是「模型饱和」这类只有文案的信号）。
 *
 * ⚠️ **`status === 429` 必须早于文案**：网关 / CDN 可以回**空体** 429，那时任何
 * 文案判据都不命中 —— 而它正是最典型的限流。
 *
 * @param failure - `turn/end` 的 `reason.error`（未知形状按「不是」处理）。
 * @returns {@link RESUME_CLASS_RATE} / {@link RESUME_CLASS_QUOTA} / `undefined`。
 */
export function classifyRateLimitFailure(failure) {
    if (!isRecord(failure)) return undefined;
    const code = typeof failure.code === 'string' ? failure.code : undefined;
    const status = typeof failure.status === 'number' ? failure.status : undefined;
    if (code === 'RATE_LIMIT') return CLASS_RATE;
    if (status === 429) return CLASS_RATE;
    if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return CLASS_QUOTA;
    const detail = [typeof failure.message === 'string' ? failure.message : '',
        typeof failure.code === 'string' ? failure.code : ''].filter((part) => part !== '').join(' ');
    if (detail === '') return undefined;
    if (RATE_TEXT_PATTERN.test(detail)) return CLASS_RATE;
    if (QUOTA_TEXT_PATTERN.test(detail)) return CLASS_QUOTA;
    return undefined;
}

/**
 * 从失败载荷里读出「服务端指定的等待时长」（`providerRetryAfterMs`）。
 *
 * ⚠️ 这个字段是 DSH 的**机器通道**（`LlmError` 校验里 `> 0` 才允许出现），不是文案
 * 解析。providers-hub 的绝大多数适配器并不填它，故它只是三条来源里的一条 ——
 * 权威来源仍是账号池里的限流标记（见 {@link modelResetAt}）。
 *
 * @param failure - `turn/end` 的 `reason.error`。
 * @param now - 当前时刻。
 * @returns 绝对解禁时刻（ms）；没有该字段时 `undefined`。
 */
export function resetAtFromFailure(failure, now) {
    if (!isRecord(failure)) return undefined;
    const retryAfter = failure.providerRetryAfterMs;
    return Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter : undefined;
}

/**
 * 从账号池条目里取「该模型最晚的解禁时刻」。
 *
 * ## 为什么取 **max** 而不是第一条
 *
 * `modelRateLimits` 是**每个账号**各自一张表（键 = 模型 id）。同一模型上 A 号封
 * 1 小时、B 号封 24 小时（额度）时，下一次请求会先落在 A（顺序优先且 A 已解禁），
 * 于是「等谁」没有唯一答案。取 **max** 是保守方向：宁可晚一点续跑（那时整池都解了），
 * 也不要早一秒去撞墙 —— 撞墙只会再烧一次请求并把冷却推后。
 *
 * ⚠️ 只认 **未来** 的标记：过期标记（`<= now`）由池自己的 sweep 清理，这里不该拿它
 * 当「正在限流」的证据，否则会白等一整轮。
 *
 * @param accounts - `pool.listAccountsByProvider(provider)` 的返回值（未知形状按空处理）。
 * @param model - 模型 id（限流标记的键）。
 * @param now - 当前时刻。
 * @returns 最晚的未来解禁时刻；一条都没有时 `undefined`。
 */
function modelResetAt(accounts, model, now) {
    if (typeof model !== 'string' || model === '') return undefined;
    if (!Array.isArray(accounts)) return undefined;
    let latest = 0;
    for (const account of accounts) {
        const marks = isRecord(account) ? account.modelRateLimits : undefined;
        if (!isRecord(marks)) continue;
        const at = marks[model];
        if (typeof at === 'number' && Number.isFinite(at) && at > now && at > latest) latest = at;
    }
    return latest > 0 ? latest : undefined;
}

/**
 * 计算下一次定时器该等多久。
 *
 * 夹在 [{@link MIN_FIRE_DELAY_MS}, {@link MAX_RESET_WAIT_MS}]：下界防「解禁时刻已经
 * 过去」时在同一轮里连打；上界防 `setTimeout` 收到异常大的值。
 *
 * @param now - 当前时刻。
 * @param resetAtMs - 目标解禁时刻。
 * @returns 以毫秒计的等待时长。
 */
export function nextResumeDelay(now, resetAtMs) {
    const raw = Number.isFinite(resetAtMs) ? resetAtMs - now : DEFAULT_RESET_WAIT_MS;
    if (!Number.isFinite(raw)) return DEFAULT_RESET_WAIT_MS;
    return Math.min(Math.max(raw, MIN_FIRE_DELAY_MS), MAX_RESET_WAIT_MS);
}

/**
 * 归一化一个持久化 / 客户端送来的钩子快照。
 *
 * 与 `badge-preferences.ts` 的 `sanitize*` 同策：非法字段**逐条丢弃**而不是让整份
 * 文档失效 —— 一份坏记录不该把其余待续跑的中断一起抹掉。
 *
 * @param raw - 未知形状的钩子。
 * @param now - 当前时刻（用于丢掉早就不再有效的记录）。
 * @returns 归一化后的钩子；无效时 `undefined`。
 */
export function sanitizeHook(raw, now) {
    if (!isRecord(raw)) return undefined;
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    if (sessionId === '') return undefined;
    const resetAtMs = typeof raw.resetAtMs === 'number' && Number.isFinite(raw.resetAtMs) ? raw.resetAtMs : undefined;
    if (resetAtMs === undefined) return undefined;
    // 早于「现在 - 最长等待」的记录已经毫无意义（宿主可能关了很多天）。
    if (resetAtMs < now - MAX_RESET_WAIT_MS) return undefined;
    return {
        sessionId,
        turn: typeof raw.turn === 'number' && Number.isInteger(raw.turn) && raw.turn > 0 ? raw.turn : 0,
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        kind: raw.kind === CLASS_QUOTA ? CLASS_QUOTA : CLASS_RATE,
        resetAtMs,
        armed: raw.armed !== false,
        deferrals: typeof raw.deferrals === 'number' && Number.isInteger(raw.deferrals) && raw.deferrals >= 0
            ? Math.min(raw.deferrals, MAX_DEFERRALS)
            : 0,
    };
}

/** 钩子的公开快照（写盘与 RPC 都用它，避免两处各拼一份）。 */
function hookSnapshot(hook) {
    return {
        sessionId: hook.sessionId,
        turn: hook.turn,
        provider: hook.provider,
        model: hook.model,
        kind: hook.kind,
        resetAtMs: hook.resetAtMs,
        armed: hook.armed,
        deferrals: hook.deferrals,
    };
}

/**
 * 创建引擎（宿主侧只有一个实例，见本文件末尾的 `installRateLimitResume`）。
 *
 * 所有副作用（调度、投递、落盘、读池）都由调用方注入，故这里可以用假时钟 /
 * 假调度器完整跑一遍「中断 → 等待 → 解禁 → 续跑」。
 *
 * @param options - 注入的副作用与日志出口。
 * @returns 引擎实例。
 */
export function createRateLimitResumeEngine(options = {}) {
    const log = {
        info: typeof options.log?.info === 'function' ? (message) => options.log.info(message) : () => {},
        warn: typeof options.log?.warn === 'function' ? (message) => options.log.warn(message) : () => {},
    };
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const schedule = typeof options.schedule === 'function'
        ? options.schedule
        : (task, delayMs) => setTimeout(task, delayMs);
    const cancel = typeof options.cancel === 'function' ? options.cancel : (handle) => clearTimeout(handle);
    const persist = typeof options.persist === 'function' ? options.persist : () => {};
    const readReset = typeof options.readReset === 'function' ? options.readReset : () => undefined;
    const maxHooks = Number.isInteger(options.maxHooks) && options.maxHooks > 0 ? options.maxHooks : MAX_HOOKS;

    const hooks = new Map();
    let enabled = options.enabled !== false;
    // ⚠️ 构造时就接上投递通道：`installRateLimitResume` 在创建引擎时已经把
    // `deliver` 传进来了（它内部再经 agents 作用域解析）。早期这里写成裸
    // `let deliver;` 而只认 `setDeliver()`，于是「恢复出来的钩子在 agents 就绪
    // 前到点」会走进 `typeof deliver !== 'function'` 分支 —— 表现为每次只推迟
    // 5 分钟、一次都投不出去（单测抓到的真实缺陷）。
    let deliver = typeof options.deliver === 'function' ? options.deliver : undefined;
    let disposed = false;

    function drop(hook, reason) {
        if (hooks.get(hook.sessionId) !== hook) return;
        hooks.delete(hook.sessionId);
        if (hook.timer !== undefined) {
            cancel(hook.timer);
            hook.timer = undefined;
        }
        persist();
        log.info(`[jet-hub] 限流续跑结束（${hook.sessionId}#${hook.turn}）：${reason}`);
    }

    function armTimer(hook) {
        if (hook.timer !== undefined) {
            cancel(hook.timer);
            hook.timer = undefined;
        }
        if (disposed || !hook.armed) return;
        const delay = nextResumeDelay(now(), hook.resetAtMs);
        hook.timer = schedule(() => {
            hook.timer = undefined;
            attempt(hook);
        }, delay);
    }

    /** 到点：先复核池里是否仍未解禁，再投递；投递不成按 {@link DELIVER_RETRY_MS} 重试。 */
    function attempt(hook) {
        if (disposed || hooks.get(hook.sessionId) !== hook) return;
        if (!hook.armed) return;
        const current = now();
        if (current < hook.resetAtMs - 1000) {
            // 被提前唤醒（时钟跳变 / 注入的假调度器）：照实重排，不要提前续跑。
            armTimer(hook);
            return;
        }
        const stillLimitedAt = readReset(hook.provider, hook.model);
        if (typeof stillLimitedAt === 'number' && stillLimitedAt > current) {
            hook.deferrals += 1;
            if (hook.deferrals > MAX_DEFERRALS) {
                drop(hook, `解禁时刻被反复推后（已 ${hook.deferrals} 次），放弃自动继续`);
                return;
            }
            hook.resetAtMs = stillLimitedAt;
            armTimer(hook);
            persist();
            log.info(`[jet-hub] 限流仍未解禁（${hook.sessionId}#${hook.turn}），推迟到 ${new Date(stillLimitedAt).toISOString()}`);
            return;
        }
        if (typeof deliver !== 'function') {
            // agents 服务还没就绪（或本 profile 没有 agent-loop）：稍后再试，别丢掉这个钩子。
            hook.deferrals += 1;
            if (hook.deferrals > MAX_DEFERRALS) {
                drop(hook, '宿主始终没有可用的投递通道');
                return;
            }
            hook.resetAtMs = current + DELIVER_RETRY_MS;
            armTimer(hook);
            persist();
            return;
        }
        let result;
        try {
            result = deliver(hook);
        }
        catch (error) {
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (result && result.ok === true) {
            drop(hook, '解禁后已自动继续');
            return;
        }
        const reason = result && typeof result.reason === 'string' ? result.reason : 'unknown';
        if (reason === 'no-live-agent') {
            // 会话已经不在内存里（关掉了标签页 / 宿主重启过）：没有「继续」的对象，直接放弃。
            drop(hook, '会话已不在内存中（没有 live agent）');
            return;
        }
        hook.deferrals += 1;
        if (hook.deferrals > MAX_DEFERRALS) {
            drop(hook, `投递反复失败（${reason}），放弃自动继续`);
            return;
        }
        hook.resetAtMs = current + DELIVER_RETRY_MS;
        armTimer(hook);
        persist();
        log.warn(`[jet-hub] 限流续跑投递失败（${hook.sessionId}#${hook.turn}）：${reason}`);
    }

    return {
        /**
         * 记录一次限流中断。
         * @param input - `{ sessionId, turn, provider, model, kind, resetAtMs }`。
         * @returns 新建的钩子快照（无法记录时 `undefined`）。
         */
        noteInterruption(input) {
            if (disposed) return undefined;
            const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
            if (sessionId === '') return undefined;
            const previous = hooks.get(sessionId);
            if (previous !== undefined) drop(previous, '同一会话又出现新的中断');
            if (hooks.size >= maxHooks) {
                const oldest = [...hooks.values()].sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
                if (oldest !== undefined) drop(oldest, '待续跑记录过多，淘汰最早的');
            }
            const current = now();
            const resetAtMs = Number.isFinite(input.resetAtMs) && input.resetAtMs > 0
                ? input.resetAtMs
                : current + DEFAULT_RESET_WAIT_MS;
            const hook = {
                sessionId,
                turn: typeof input.turn === 'number' && Number.isInteger(input.turn) ? input.turn : 0,
                provider: typeof input.provider === 'string' ? input.provider : '',
                model: typeof input.model === 'string' ? input.model : '',
                kind: input.kind === CLASS_QUOTA ? CLASS_QUOTA : CLASS_RATE,
                resetAtMs,
                // 初值 = 全局默认。用户随后可用报错行那个按钮逐个改。
                armed: enabled,
                deferrals: 0,
                timer: undefined,
            };
            hooks.set(sessionId, hook);
            armTimer(hook);
            persist();
            log.info(`[jet-hub] 记录限流中断（${sessionId}#${hook.turn}，${hook.provider || '?'}/${hook.model || '?'}，`
                + `解禁 ${new Date(resetAtMs).toISOString()}，${hook.armed ? '将自动继续' : '已关闭自动继续'}）`);
            return hookSnapshot(hook);
        },
        /** 宿主自己开始了新回合：这个中断已经没人在等，撤掉。 */
        noteTurnStart(sessionId) {
            const hook = hooks.get(sessionId);
            if (hook !== undefined) drop(hook, '宿主已开启新回合');
        },
        /** 用户手动发了消息：同上。 */
        noteUserMessage(sessionId) {
            const hook = hooks.get(sessionId);
            if (hook !== undefined) drop(hook, '用户手动发送了消息');
        },
        /**
         * 切换某个待续跑中断的 armed。
         * @param sessionId - 会话 id。
         * @param armed - 目标状态。
         * @returns 更新后的快照；没有待续跑记录时 `undefined`（客户端据此把按钮收掉）。
         */
        setArmed(sessionId, armed) {
            const hook = typeof sessionId === 'string' ? hooks.get(sessionId) : undefined;
            if (hook === undefined) return undefined;
            hook.armed = armed === true;
            if (hook.armed) {
                // 重新开启：解禁时刻可能已经过去，按夹逼后的最小延迟重排，不会立刻连打。
                armTimer(hook);
            }
            else if (hook.timer !== undefined) {
                cancel(hook.timer);
                hook.timer = undefined;
            }
            persist();
            return hookSnapshot(hook);
        },
        /** 改全局默认。只影响**之后**的中断（已有钩子保持各自的 armed）。 */
        setEnabled(value) {
            enabled = value === true;
            persist();
            return enabled;
        },
        /** 读当前状态（RPC 与持久化都走它）。 */
        status() {
            return { enabled, hooks: [...hooks.values()].map(hookSnapshot).sort((left, right) => left.resetAtMs - right.resetAtMs) };
        },
        /** 注入投递通道（agents 服务就绪后由 install 调用）。 */
        setDeliver(fn) {
            deliver = typeof fn === 'function' ? fn : undefined;
            // 之前因为「没有投递通道」被推迟的钩子，现在可以按原解禁时刻重排。
            for (const hook of hooks.values()) armTimer(hook);
        },
        /**
         * 从持久化文档恢复（宿主重启后接着等）。
         * @param list - 未知形状的钩子数组。
         */
        restore(list) {
            if (!Array.isArray(list)) return;
            const current = now();
            for (const raw of list) {
                const hook = sanitizeHook(raw, current);
                if (hook === undefined) continue;
                if (hooks.has(hook.sessionId)) continue;
                hooks.set(hook.sessionId, { ...hook, timer: undefined });
            }
            for (const hook of hooks.values()) armTimer(hook);
            persist();
        },
        /** 丢掉某个会话的钩子（`agent/disposed` 用）。 */
        forget(sessionId) {
            const hook = hooks.get(sessionId);
            if (hook !== undefined) drop(hook, 'agent 已释放');
        },
        /** 关闭引擎：清掉所有定时器（fiber 卸载时调用，必须幂等且不抛错）。 */
        dispose() {
            disposed = true;
            for (const hook of [...hooks.values()]) {
                if (hook.timer !== undefined) {
                    cancel(hook.timer);
                    hook.timer = undefined;
                }
            }
            hooks.clear();
            deliver = undefined;
        },
    };
}

/** 模块级单例：客户端 RPC 侧与宿主监听器共用同一个引擎。 */
let controller;

/** 内存后端：定位不到 DSH home 时的显式降级（与 `MemoryPreferenceStore` 同策）。 */
function createMemoryStore() {
    let state = { enabled: true, hooks: [] };
    return {
        load: () => state,
        save: (next) => { state = next; },
    };
}

/**
 * 文件后端：`$DSH_HOME/jet-hub/rate-limit-resume.json`。
 *
 * ⚠️ 读失败 / 文档损坏一律回落到默认值并留一条 warn，理由与
 * `badge-preferences.ts` 相同：这是**体验层**功能，配置写坏不该让插件起不来。
 */
function createFileStore(home, logger) {
    const path = join(home, 'jet-hub', RATE_LIMIT_RESUME_FILE);
    return {
        load() {
            try {
                if (!existsSync(path)) return { enabled: true, hooks: [] };
                const parsed = JSON.parse(readFileSync(path, 'utf-8'));
                if (typeof parsed !== 'object' || parsed === null) return { enabled: true, hooks: [] };
                return {
                    enabled: parsed.enabled !== false,
                    hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
                };
            }
            catch (error) {
                logger?.warn?.(`[jet-hub] 读取 ${path} 失败，限流续跑按默认（开启）处理: ${String(error)}`);
                return { enabled: true, hooks: [] };
            }
        },
        save(next) {
            try {
                mkdirSync(join(path, '..'), { recursive: true });
                const tmp = `${path}.tmp`;
                writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, ...next }, null, 2)}\n`, 'utf-8');
                renameSync(tmp, path);
            }
            catch (error) {
                logger?.warn?.(`[jet-hub] 写入 ${path} 失败: ${String(error)}`);
            }
        },
    };
}

/** 从 `request/header` 折叠结果里读 provider / model（取不到时给空串）。 */
function requestTargetOf(session) {
    let header;
    try {
        header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
    }
    catch {
        header = undefined;
    }
    const config = header !== undefined && header !== null ? header.config : undefined;
    return {
        provider: typeof config?.provider === 'string' ? config.provider : '',
        model: typeof config?.model === 'string' ? config.model : '',
    };
}

/** 读 `turn/end` 的失败载荷（未知形状给 `undefined`）。 */
function failureOf(event) {
    const reason = event?.data?.reason;
    if (reason === undefined || reason === null || typeof reason !== 'object') return undefined;
    if (reason.kind !== 'error') return undefined;
    return reason.error;
}

/**
 * 装上「限流中断后解禁再继续」。
 *
 * ⚠️ **引擎本体在 `ctx.inject(['agents'])` 之外创建**：钩子的记录、持久化与 RPC
 * 状态在**没有 agent-loop** 的 profile 里也应可用（那种 profile 里只是投递会走
 * 「no-live-agent」分支）。这与 `installLoopResume` 的取舍刻意不同：那边整个功能
 * 都依赖 agents，缺席时挂上也没有意义；这边「记下一个待续跑记录」本身就有价值
 * （宿主重启后由下一次启动恢复）。
 *
 * @param ctx - 插件上下文。
 * @param pool - 账号池（读限流标记；可选，缺席时只靠 `providerRetryAfterMs` 与兜底）。
 * @returns 无。
 */
export function installRateLimitResume(ctx, pool) {
    if (controller !== undefined) {
        // fiber 重启时旧实例可能还没 dispose（本仓库反复登记的「新旧交错」形态）：
        // 先撤旧的，再把新的挂上。
        try { controller.dispose(); } catch {
            // 旧实例已坏也无所谓
        }
        controller = undefined;
    }

    const home = resolveJetHubHome(ctx);
    const store = home === undefined ? createMemoryStore() : createFileStore(home, ctx.logger);
    const loaded = store.load();

    let agentsScope;
    const engine = createRateLimitResumeEngine({
        log: ctx.logger,
        enabled: loaded ? loaded.enabled !== false : true,
        persist: () => {
            const status = engine.status();
            store.save({ enabled: status.enabled, hooks: status.hooks });
        },
        readReset: (provider, model) => {
            try {
                if (provider === '' || model === '') return undefined;
                if (pool === undefined) return undefined;
                return modelResetAt(pool.listAccountsByProvider(provider), model, Date.now());
            }
            catch (error) {
                ctx.logger?.warn?.(`[jet-hub] 读限流标记失败（${provider}/${model}）: ${String(error)}`);
                return undefined;
            }
        },
        deliver: (hook) => deliverResume(ctx, () => agentsScope, hook),
    });

    const teardown = [];
    const sessionEventDisposer = ctx.on('session/event', (session, event) => {
        try {
            observeSessionEvent(engine, session, event);
        }
        catch (error) {
            ctx.logger?.warn?.(`[jet-hub] 限流续跑会话事件处理异常 ${session?.id}: ${String(error)}`);
        }
    });
    teardown.push(sessionEventDisposer);

    // ⚠️ 先把控制器挂上再恢复：`restore()` 会 armTimer，而它内部 persist() 会读
    // `engine.status()` —— 引擎是同一个实例，故顺序无关；但**对外可见的控制器**
    // 必须在恢复之后才就绪，否则 RPC 可能在「空引擎」上回答。
    controller = engine;
    if (loaded && Array.isArray(loaded.hooks)) engine.restore(loaded.hooks);

    ctx.inject(['agents'], (scope) => {
        agentsScope = scope;
        // 投递通道就绪：之前因缺通道被推迟的钩子会按原解禁时刻重排。
        engine.setDeliver(() => {});
        const dispose = scope.on('agent/disposed', ({ agent }) => { engine.forget(agent.id); });
        teardown.push(dispose);
    });

    ctx.effect(() => () => {
        // 幂等、绝不抛错（disposer 抛错会让 runProfile 抛 AggregateError）。
        agentsScope = undefined;
        if (controller === engine) controller = undefined;
        for (const dispose of teardown) {
            try {
                if (typeof dispose === 'function') dispose();
            }
            catch {
                // ignore
            }
        }
        try { engine.dispose(); } catch {
            // ignore
        }
    }, 'jet-hub: rate-limit resume');
}

/**
 * 处理一条会话事件。
 * @param engine - 引擎。
 * @param session - 会话对象（`id` / `requestHeader()`）。
 * @param event - 会话事件（`type` / `data`）。
 */
function observeSessionEvent(engine, session, event) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '' || event === undefined || event === null) return;
    if (event.type === 'turn/start') {
        engine.noteTurnStart(sessionId);
        return;
    }
    if (event.type === 'user/message') {
        engine.noteUserMessage(sessionId);
        return;
    }
    if (event.type !== 'turn/end') return;
    const failure = failureOf(event);
    if (failure === undefined) return;
    const kind = classifyRateLimitFailure(failure);
    if (kind === undefined) return;
    const target = requestTargetOf(session);
    const now = Date.now();
    // 先看服务端给的机器通道，再留给引擎去池里复核（`readReset`）。
    engine.noteInterruption({
        sessionId,
        turn: typeof event.data?.turn === 'number' ? event.data.turn : 0,
        provider: target.provider,
        model: target.model,
        kind,
        resetAtMs: resetAtFromFailure(failure, now),
    });
}

/**
 * 投递一条续跑消息。
 *
 * @param ctx - 插件上下文（日志出口）。
 * @param getScope - 惰性取 agents 服务所在上下文（它晚于本模块就绪）。
 * @param hook - 待续跑记录（只用 `sessionId` / `turn`）。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`（引擎据此决定重试还是放弃）。
 */
function deliverResume(ctx, getScope, hook) {
    const scope = getScope();
    if (scope === undefined || scope.agents === undefined) return { ok: false, reason: 'agents-unavailable' };
    const agent = scope.agents.get(hook.sessionId);
    if (agent === undefined) return { ok: false, reason: 'no-live-agent' };
    try {
        const message = createUserMessage({
            content: [{ type: 'text', text: RATE_LIMIT_RESUME_PROMPT }],
            // ⚠️⚠️ **自有来源标识，绝不伪造成 `'user'`**（理由见本文件头）。
            source: { kind: RATE_LIMIT_RESUME_SOURCE_KIND },
        });
        // ⚠️ 与 `loop-recovery.ts` 同款：排队动作不该继承「当时恰好是谁在运行」的发起者归属。
        const run = () => { agent.followup(message); };
        const withoutInitiator = scope.agents?.withoutInitiator;
        if (typeof withoutInitiator === 'function') withoutInitiator.call(scope.agents, run);
        else run();
        ctx.logger?.info?.(`[jet-hub] 限流解禁，已自动继续 ${hook.sessionId}#${hook.turn}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * RPC 侧的状态读取（客户端图标按钮与设置页开关都走它）。
 *
 * @param sessionId - 可选：只要这一个会话的钩子。
 * @returns `{ enabled, available, hooks }`；功能没装上时 `available: false`。
 */
export function readRateLimitResumeState(sessionId) {
    const engine = controller;
    if (engine === undefined) return { enabled: true, available: false, hooks: [] };
    const status = engine.status();
    const hooks = typeof sessionId === 'string' && sessionId !== ''
        ? status.hooks.filter((hook) => hook.sessionId === sessionId)
        : status.hooks;
    return { enabled: status.enabled, available: true, hooks };
}

/**
 * 切换某个会话的「解禁后自动继续」。
 *
 * @param sessionId - 会话 id。
 * @param armed - 目标状态。
 * @returns 更新后的钩子快照；该会话没有待续跑记录时 `undefined`
 *   （客户端据此把按钮收掉 —— 那时点下去什么也不会发生，留着就是误导）。
 */
export function setRateLimitResumeArmed(sessionId, armed) {
    const engine = controller;
    if (engine === undefined) return undefined;
    return engine.setArmed(sessionId, armed);
}

/**
 * 改全局默认（只影响**之后**的中断）。
 *
 * @param enabled - 目标状态。
 * @returns 生效后的值；功能没装上时 `undefined`。
 */
export function setRateLimitResumeEnabled(enabled) {
    const engine = controller;
    if (engine === undefined) return undefined;
    return engine.setEnabled(enabled);
}
