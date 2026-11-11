/**
 * 宿主侧：「临期置顶」—— 把**临期积分最近作废**的账号自动移到账号列表上方。
 *
 * ## 它做什么
 *
 * 一个**总开关**（Jet Hub 账号面板标题旁）。开关打开后，每次面板读到余额
 * （`credits.balances`）就把该 provider 的账号池顺序重排成「临期最近的在前」，
 * 走 `pool.reorderAccounts`（与拖拽写的是同一份存储顺序）。
 *
 * ## ⚠️ 为什么判据是「积分包到期」而不是卡片上那行「有效期」
 *
 * | 卡片上的位置 | 字段 | 过期会发生什么 |
 * |---|---|---|
 * | 有效期 | `ProviderAccountEntry.expiresAt` | 凭据 / 登录态过期。多数渠道能**静默续期**（`refreshable`），`expiry-sync` 会把新值写回池 ⇒ 通常**不丢东西** |
 * | 积分行 | `CreditBalance.packages[].deductionEndTime` | **额度作废**。时刻一过，包里剩多少就归零 ⇒ 真的白丢 |
 *
 * 故「临期」取后者：该账号手里**最早会作废且还有余量**的积分包的到期时刻。
 *
 * ## ⚠️ 五个判据细节（都是真机上会咬人的）
 *
 * 1. `active !== true` 或 `remaining <= 0` 的包**不算** —— 否则「积分早就用完的号」
 *    会永远排第一。
 * 2. 没有 `deductionEndTime` 的包 = **永久**（服务端没给到期时间），**不是**「马上过期」。
 * 3. 已经过去的 `deductionEndTime` 不算（`end <= now`）：那批额度已经作废了，把它的
 *    账号顶到最上只会挤掉真正还有额度的号。
 * 4. 有的渠道只给字符串 `expiredTime`（officeace 的 `creditGroups[].expiresAt`），
 *    按 `Date.parse(换空格为 T)` 兜底 —— 与客户端既有的 `packageExpiryMs` 同一口径。
 * 5. **平手回落到原下标**（稳定序）。否则点一次开关就会打乱用户自己拖好的号。
 *
 * ## ⚠️ 为什么用 `listAccountsByProvider`（存储序）而不是 `listAccounts`（视图序）
 *
 * `listAccounts` 会**稳定地把限流中的账号沉到最后**（那是视图排序，刻意不动存储顺序）。
 * 若拿它的返回顺序去算新顺序再写回，等于把「限流沉底」这个纯展示决定**固化进存储顺序**
 * —— 限流一解除，那个号就真的留在末尾了。故写入侧一律走 {@link pool.listAccountsByProvider}。
 *
 * ## ⚠️ 为什么状态放宿主、且落盘
 *
 * 开关是「一直有效的行为」，不是一次点击：面板关掉再打开、宿主重启之后再打开，
 * 它都得还是那个值。故写 `$DSH_HOME/jet-hub/expiry-first.json`（与
 * `rate-limit-resume.json` / `ui-preferences.json` 同目录、同原子写惯例）。
 *
 * @module expiry-first
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveJetHubHome } from './jet-hub-store.js';

/** 持久化文档的文件名（与 `ui-preferences.json` 同目录）。 */
export const EXPIRY_FIRST_FILE = 'expiry-first.json';
const SCHEMA = 'dsh-providers-hub-enhance/expiry-first/v1';

/**
 * 读成「有限正数」；否则 `undefined`（**不编造 0** —— 0 会被当成「已作废」）。
 */
function readMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 单个资源包的到期时刻（毫秒）；永久 / 无期限返回 `undefined`。
 *
 * ⚠️ 只看**有效且还有余量**的包：已失效（`active !== true`）或空包（`remaining <= 0`）
 * 一律返回 `undefined`，否则「积分早就用完的账号」会长期霸占排序头部。
 */
export function packageExpiryMs(pkg) {
    if (pkg === null || typeof pkg !== 'object') return undefined;
    if (pkg.active !== true) return undefined;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    const dedicated = readMs(pkg.deductionEndTime);
    if (dedicated !== undefined) return dedicated;
    // 字符串期限兜底（`'2026-11-12 04:00:00'`；`Date.parse` 认 ISO，故把空格换成 T）。
    const text = typeof pkg.expiredTime === 'string' ? pkg.expiredTime.trim() : '';
    if (text.length === 0) return undefined;
    const parsed = Date.parse(text.replace(' ', 'T'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 一个账号**最早会作废**的额度时刻（毫秒）；没有临期积分返回 `undefined`。
 *
 * @param creditsEntry - `credits.balances` 里那一条：`{ balance, error, extra }`。
 *   余额查询失败（`balance === null`）或尚未返回（`undefined`）都返回 `undefined`
 *   —— 那与「这个号没有临期积分」是两件事，故调用方**不得**把它当成「按 0 排」。
 */
export function accountExpiryAt(creditsEntry, now = Date.now()) {
    const balance = creditsEntry === null || typeof creditsEntry !== 'object' ? undefined : creditsEntry.balance;
    const packages = balance !== null && typeof balance === 'object' && Array.isArray(balance.packages)
        ? balance.packages
        : [];
    const at = Number.isFinite(now) ? now : Date.now();
    let earliest;
    for (const pkg of packages) {
        const end = packageExpiryMs(pkg);
        if (end === undefined || end <= at) continue;
        if (earliest === undefined || end < earliest) earliest = end;
    }
    return earliest;
}

/**
 * 排序计划：临期最近的在前；无临期积分的按原有相对顺序排在后面。
 *
 * ⚠️ **稳定**：同一天到期的两个账号、以及两个都没有临期积分的账号，都保持原有相对
 * 顺序 —— 否则开关一开就顺手打乱用户自己拖出来的号。
 *
 * @returns `{ orderedIds, entries, withExpiry, withoutExpiry, reordered }`
 *   - `entries`：逐账号的 `{ id, nickname, expiry }`（`expiry` 可能是 `undefined`）；
 *   - `reordered`：与传入顺序是否**真的不同**（调用方据此决定要不要写盘）。
 */
export function sortAccountsByExpiry(accounts, creditsById, now = Date.now()) {
    const list = Array.isArray(accounts) ? accounts : [];
    const at = Number.isFinite(now) ? now : Date.now();
    const map = creditsById !== null && typeof creditsById === 'object' ? creditsById : {};
    const entries = [];
    for (let index = 0; index < list.length; index += 1) {
        const account = list[index];
        if (account === null || typeof account !== 'object') continue;
        if (typeof account.id !== 'string' || account.id.length === 0) continue;
        entries.push({
            id: account.id,
            nickname: typeof account.nickname === 'string' && account.nickname.length > 0 ? account.nickname : account.id,
            expiry: accountExpiryAt(map[account.id], at),
            index,
        });
    }
    const ordered = entries.slice().sort((a, b) => {
        const aKnown = a.expiry !== undefined;
        const bKnown = b.expiry !== undefined;
        // 有临期的整体排在无临期之前。
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        if (aKnown && bKnown && a.expiry !== b.expiry) return a.expiry - b.expiry;
        // 平手回落到原有下标 ⇒ 稳定序（`Array.prototype.sort` 本身也稳定，双保险）。
        return a.index - b.index;
    });
    const orderedIds = [];
    let withExpiry = 0;
    let reordered = false;
    for (let i = 0; i < ordered.length; i += 1) {
        orderedIds.push(ordered[i].id);
        if (ordered[i].expiry !== undefined) withExpiry += 1;
        if (ordered[i].id !== entries[i].id) reordered = true;
    }
    return {
        orderedIds,
        entries: ordered,
        withExpiry,
        withoutExpiry: ordered.length - withExpiry,
        reordered,
    };
}

/** 内存后端：定位不到 DSH home 时的显式降级（与 `createMemoryStore` 同策）。 */
function createMemoryStore() {
    let state = { enabled: false };
    return {
        load: () => state,
        save: (next) => { state = next; },
    };
}

/**
 * 文件后端：`$DSH_HOME/jet-hub/expiry-first.json`。
 *
 * ⚠️ 读失败 / 文档损坏一律回落默认（**关**）并留一条 warn：这是体验层功能，
 * 配置写坏不该让插件起不来。默认关而不是默认开 —— 它会**改写账号顺序**，
 * 那是用户自己的数据，未经同意不该自动动。
 */
function createFileStore(home, logger) {
    const path = join(home, 'jet-hub', EXPIRY_FIRST_FILE);
    return {
        load() {
            try {
                if (!existsSync(path)) return { enabled: false };
                const parsed = JSON.parse(readFileSync(path, 'utf-8'));
                if (parsed === null || typeof parsed !== 'object') return { enabled: false };
                return { enabled: parsed.enabled === true };
            }
            catch (error) {
                logger?.warn?.(`[jet-hub] 读取 ${path} 失败，「临期置顶」按默认（关闭）处理: ${String(error)}`);
                return { enabled: false };
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

/**
 * 创建引擎。**不碰文件、不碰池** —— 全部由调用方注入，故可在测试里裸跑。
 *
 * @param options - `{ enabled, save, logger }`。
 */
export function createExpiryFirstEngine(options = {}) {
    const logger = options.logger;
    const save = typeof options.save === 'function' ? options.save : () => {};
    let enabled = options.enabled === true;

    return {
        status() {
            return { enabled };
        },
        /**
         * 改开关并落盘。
         *
         * @returns 生效后的布尔值（**以落盘后的状态为准**，不是入参）。
         */
        setEnabled(next) {
            const value = next === true;
            if (value === enabled) return enabled;
            enabled = value;
            save({ enabled });
            logger?.info?.(`[jet-hub] 「临期置顶」已${value ? '打开' : '关闭'}`);
            return enabled;
        },
        /**
         * 按已读到的余额给某个 provider 重排账号顺序。
         *
         * @param provider - provider id。
         * @param accounts - **存储序**的账号数组（`pool.listAccountsByProvider`）。
         * @param creditsById - `accountId → { balance, error, extra }`。
         * @param reorder - `(provider, orderedIds) => Promise<void>`。
         * @returns `{ applied, plan }`：`applied` 表示真的写盘了。
         */
        async apply(provider, accounts, creditsById, reorder) {
            if (!enabled) return { applied: false, plan: undefined };
            const plan = sortAccountsByExpiry(accounts, creditsById, Date.now());
            if (plan.orderedIds.length === 0) return { applied: false, plan };
            // 一个临期都算不出来 ⇒ **一个字都不写盘**。`balance: null`（查询失败）与
            // 「没有临期」在数据里同形，照排等于按 `undefined` 重排一遍，用户拖好的
            // 顺序会被一次查询失败打乱，而且过程中没有任何提示解释原因。
            if (plan.withExpiry === 0) return { applied: false, plan };
            if (!plan.reordered) return { applied: false, plan };
            try {
                await reorder(provider, plan.orderedIds);
            }
            catch (error) {
                // 顺序写失败不该反噬余额查询：面板照常显示余额，顺序保持原样。
                logger?.warn?.(`[jet-hub] 「临期置顶」重排 ${provider} 失败: ${String(error)}`);
                return { applied: false, plan };
            }
            logger?.info?.(`[jet-hub] 「临期置顶」已重排 ${provider}：${plan.withExpiry} 个临期账号在前`
                + (plan.withoutExpiry > 0 ? `，${plan.withoutExpiry} 个无临期在后` : ''));
            return { applied: true, plan };
        },
    };
}

/** 模块级单例：客户端 RPC 侧与余额查询侧共用同一个引擎。 */
let controller;

/**
 * 装上「临期置顶」。
 *
 * ⚠️ 不给 `jet-hub-rpc.js` 加位置形参（那边注释明令禁止：可选位置形参会静默把表
 * 落进错位置，本仓库实测复发 6 次）。控制器放模块级单例，由本文件导出、
 * RPC 侧 `import { … } from './expiry-first.js'` 现读 —— 与 `rate-limit-resume.js`
 * 同一手法。
 *
 * @param ctx - 插件上下文。
 * @param pool - 账号池（读写顺序）。
 * @returns 无。
 */
export function installExpiryFirst(ctx, pool) {
    if (controller !== undefined) {
        // fiber 重启时旧实例可能还没 dispose（本仓库反复登记的「新旧交错」形态）。
        try { controller.dispose?.(); } catch {
            // 旧实例已坏也无所谓
        }
        controller = undefined;
    }
    const home = resolveJetHubHome(ctx);
    const store = home === undefined ? createMemoryStore() : createFileStore(home, ctx.logger);
    const loaded = store.load();

    const engine = createExpiryFirstEngine({
        logger: ctx.logger,
        enabled: loaded.enabled === true,
        save: (next) => store.save(next),
    });

    controller = {
        engine,
        pool,
        /** 最近一次读到的余额（按 provider 缓存），供「刚打开开关」时立刻生效。 */
        lastBalances: new Map(),
        dispose() {
            controller = undefined;
        },
    };
}

/** RPC：读开关状态。功能没装上时 `available: false`（客户端据此把开关收掉）。 */
export function readExpiryFirstState() {
    const current = controller;
    if (current === undefined) return { enabled: false, available: false };
    return { enabled: current.engine.status().enabled, available: true };
}

/**
 * RPC：改开关。
 *
 * ⚠️ 打开时若手里已有余额缓存（本会话读过一次余额），**立刻**按它重排一遍 ——
 * 否则用户拨开开关后要等下一次余额刷新才看到变化，会以为开关没生效。
 *
 * @returns `{ enabled, available }`。
 */
export async function setExpiryFirstEnabled(enabled) {
    const current = controller;
    if (current === undefined) return { enabled: false, available: false };
    const value = current.engine.setEnabled(enabled);
    if (value && current.pool !== undefined) {
        for (const [provider, creditsById] of current.lastBalances) {
            const accounts = accountsOf(current.pool, provider);
            if (accounts === undefined) continue;
            // ⚠️ 逐 provider 顺序执行、单条失败不影响其余：一个 provider 的顺序写失败
            //    不该让别的 provider 也没被排上（与 `collectCreditBalances` 同一取向）。
            await current.engine.apply(provider, accounts, creditsById, reorderWith(current.pool));
        }
    }
    return { enabled: value, available: true };
}

/** 读某个 provider 的**存储序**账号（absent 时 `undefined`）。 */
function accountsOf(pool, provider) {
    try {
        if (typeof pool.listAccountsByProvider !== 'function') return undefined;
        const list = pool.listAccountsByProvider(provider);
        return Array.isArray(list) ? list : undefined;
    }
    catch {
        return undefined;
    }
}

/** 写顺序的函数（缺方法时静默不动 —— 老版本池不该让功能崩）。 */
function reorderWith(pool) {
    return async (provider, orderedIds) => {
        if (typeof pool.reorderAccounts !== 'function') throw new Error('账号池不支持 reorderAccounts');
        await pool.reorderAccounts(provider, orderedIds);
    };
}

/**
 * 余额查询侧：记下这一轮的余额，开关打开时顺手重排。
 *
 * 调用点是 `jet-hub-rpc.js` 的 `credits.balances`（**唯一**会真的去查余额的面板端点），
 * 故「自动」的实际触发时机就是「面板读到余额的那一刻」。
 *
 * ⚠️ 整段失败只记日志、**绝不上抛**：余额已经查回来了，让排序失败把它一并报废
 * 是拿功能换装饰（与 `syncAccountExpiry` 的既有取向一致）。
 *
 * @param provider - provider id。
 * @param values - `credits.balances` 的结果数组（`[{ accountId, balance, error, extra }]`）。
 * @returns `{ applied, plan }`；未装上/开关关闭时 `applied: false`。
 */
export async function applyExpiryFirstFromBalances(provider, values) {
    const current = controller;
    if (current === undefined) return { applied: false, plan: undefined };
    const creditsById = {};
    for (const item of Array.isArray(values) ? values : []) {
        if (item === null || typeof item !== 'object') continue;
        if (typeof item.accountId !== 'string') continue;
        creditsById[item.accountId] = item;
    }
    // 缓存**无条件**更新（哪怕开关是关的）：用户很可能先看一轮余额、再拨开关，
    // 那时就靠这份缓存立刻生效。
    current.lastBalances.set(provider, creditsById);
    if (!current.engine.status().enabled) return { applied: false, plan: undefined };
    const accounts = accountsOf(current.pool, provider);
    if (accounts === undefined) return { applied: false, plan: undefined };
    return current.engine.apply(provider, accounts, creditsById, reorderWith(current.pool));
}
