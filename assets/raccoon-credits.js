/**
 * Raccoon Work 积分（余额 + 每日签到 + 一次性登录奖励）。
 *
 * ## ⚠️ 三个来源的语义（2026-11-03 修正）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/desktop/v1/login/points/grant` | ✅ `claimRaccoonLoginReward` |
 * | 手机端登录奖励 | 3000 | `POST …/mobile/v1/login/points/grant`（`app-android` 身份） | ✅ 同上（同一次调用里两条都打） |
 * | 每日赠送积分 | 300/日 | **`GET …/office/v3/setting_info`**（按天幂等） | ✅ `claimRaccoonDailyCheckin` |
 *
 * ⚠️ **旧结论「每日 300 没有签到端点」已作废**：那次只翻了 `/points/v1`、`/points/v2`
 * 两个前缀（`sign_in`/`check_in`/`daily`/`claim` 确实全是 404），漏了**办公端**的
 * `setting_info`。实测带桌面端身份头 GET 一次，服务端就按天幂等发放当日每日积分，
 * 并把漏发的日子补上（2026-11-03 首次触发补齐 11-01、11-02 两天）。
 * 「签到成功」的判据仍是**账单**：`/points/v1/bills` 里出现今天的 `points > 0`
 * 记录才算数 —— 触发请求 200 不等于真的发了。
 *
 * ⚠️ **登录奖励是幂等一次性的**（已领过返回 `granted:false`），语义与 Loomy 的
 * 新手任务同构，故仍登记为 `onboardingTasks` 而**不是** `dailyCheckin`。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */
import { RACCOON_POINTS_PREFIX, RACCOON_POINTS_V2_PREFIX, RACCOON_DESKTOP_PREFIX, RACCOON_OFFICE_PREFIX, RACCOON_MOBILE_PREFIX, RACCOON_MOBILE_PLATFORM, RACCOON_MOBILE_VERSION, RACCOON_REQUEST_TIMEOUT_MS, raccoonHeaders, } from './raccoon.js';
import { RACCOON } from './raccoon-product.js';
/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000;
/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励';
/** 手机端登录奖励在账单里的 `event_name`（与桌面端那条**互不共享额度**）。 */
export const RACCOON_MOBILE_LOGIN_REWARD_EVENT_NAME = '移动端登录奖励';
/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload, status) {
    const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload
        : {};
    const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0);
    const message = typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : (typeof record.details === 'string' ? record.details : '');
    const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
        ? record.data
        : undefined;
    return { ok: code === 0, code, message, data };
}
/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 */
async function requestJson(url, credential, product, init, fetcher) {
    try {
        const response = await fetcher(url, {
            method: init.method,
            headers: raccoonHeaders(credential, {
                // 手机端那条登录奖励必须带 `app-android` 身份，其余一律桌面端
                platform: init.platform ?? product.clientPlatform,
                version: init.version ?? product.clientVersion,
            }),
            ...init.body === undefined ? {} : { body: init.body },
            signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
        });
        const parsed = await response.json();
        return parseEnvelope(parsed, response.status);
    }
    catch (error) {
        return {
            ok: false,
            code: -1,
            message: error instanceof Error ? error.message : String(error),
            data: undefined,
        };
    }
}
/** 构造一个资源包条目。 */
function makePackage(name, remaining) {
    return {
        name,
        unit: '积分',
        remaining,
        total: remaining,
        used: 0,
        active: true,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '',
    };
}
/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(product, credential, fetcher = fetch) {
    const envelope = await requestJson(`${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`, credential, product, { method: 'GET' }, fetcher);
    if (!envelope.ok || envelope.data === undefined)
        return null;
    const available = readNumber(envelope.data.available_points);
    // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
    if (available === undefined)
        return null;
    const packages = [];
    const reward = readNumber(envelope.data.reward_points);
    const daily = readNumber(envelope.data.daily_points);
    const topup = readNumber(envelope.data.topup_points);
    const monthly = readNumber(envelope.data.monthly_points);
    if (reward !== undefined)
        packages.push(makePackage('奖励积分', reward));
    if (daily !== undefined)
        packages.push(makePackage('每日积分', daily));
    if (monthly !== undefined && monthly > 0)
        packages.push(makePackage('会员积分', monthly));
    if (topup !== undefined)
        packages.push(makePackage('充值积分', topup));
    return {
        total: available,
        // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
        packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
        expiredTotal: 0,
    };
}
/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(product, credential, fetcher = fetch) {
    // ⚠️ 两条端点**互不共享额度**：桌面端领过的账号，手机端那条照样能领
    //   （2026-11-03 实测：桌面端早已 `granted:false` 的账号，手机端第一次调仍是
    //   `granted:true` +3000）。故这里两条都打，汇总成一个结果。
    const results = await Promise.all([
        claimOneLoginReward(product, credential, false, fetcher),
        claimOneLoginReward(product, credential, true, fetcher),
    ]);
    const granted = results.filter((item) => item.granted);
    if (granted.length > 0) {
        return {
            kind: 'claimed',
            credit: granted.reduce((sum, item) => sum + item.points, 0),
            streakDays: 0,
            isStreakDay: false,
        };
    }
    // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
    // 故映射成 `already-claimed` 而**不是** `claimed` ——
    // 后者会让用户以为每天都真的加了额度。
    if (results.every((item) => item.failed)) {
        const reason = results.map((item) => item.message).filter((text) => text.length > 0).join('；');
        return { kind: 'failed', code: -1, message: reason.length > 0 ? reason : '领取登录奖励失败' };
    }
    return {
        kind: 'already-claimed',
        message: '桌面端与手机端登录奖励均已领取（每端各一次）',
    };
}
/**
 * 打一次登录奖励端点并归一化。
 *
 * 桌面端 / 手机端只差「路径 + 客户端身份头」：手机端必须是 `app-android`，
 * 否则服务端按桌面端判定、不发。
 */
async function claimOneLoginReward(product, credential, mobile, fetcher) {
    const prefix = mobile ? RACCOON_MOBILE_PREFIX : RACCOON_DESKTOP_PREFIX;
    const envelope = await requestJson(`${product.apiBase}${prefix}/login/points/grant`, credential, product, {
        method: 'POST',
        ...mobile ? { platform: RACCOON_MOBILE_PLATFORM, version: RACCOON_MOBILE_VERSION } : {},
    }, fetcher);
    if (!envelope.ok) {
        return {
            granted: false,
            points: 0,
            failed: true,
            message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
        };
    }
    if (envelope.data?.granted !== true) {
        return { granted: false, points: 0, failed: false, message: '' };
    }
    const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
        ? envelope.data.popup
        : undefined;
    return {
        granted: true,
        points: readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS,
        failed: false,
        message: '',
    };
}
/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(product, credential, fetcher = fetch) {
    const items = await fetchRaccoonIncomeBills(product, credential, fetcher);
    if (items === null) {
        return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS * 2 };
    }
    // ⚠️ 两端各一条：只看到桌面端那条就把整张卡判成「已领取」，手机端那 3000
    //   会永远拿不到（用户无从发现）。故必须**两条都在**才算 claimed。
    const found = new Map();
    for (const item of items) {
        if (item.biz_type !== 'reward_grant')
            continue;
        const name = item.event_name;
        if (name !== RACCOON_LOGIN_REWARD_EVENT_NAME && name !== RACCOON_MOBILE_LOGIN_REWARD_EVENT_NAME)
            continue;
        if (found.has(name))
            continue;
        const billPoints = readNumber(item.points);
        found.set(name, billPoints !== undefined && billPoints > 0 ? billPoints : RACCOON_LOGIN_REWARD_POINTS);
    }
    const claimed = found.has(RACCOON_LOGIN_REWARD_EVENT_NAME) && found.has(RACCOON_MOBILE_LOGIN_REWARD_EVENT_NAME);
    let points = 0;
    points += found.get(RACCOON_LOGIN_REWARD_EVENT_NAME) ?? RACCOON_LOGIN_REWARD_POINTS;
    points += found.get(RACCOON_MOBILE_LOGIN_REWARD_EVENT_NAME) ?? RACCOON_LOGIN_REWARD_POINTS;
    return { claimed, points };
}
/* ────────────────────────── 每日签到（每日积分发放触发器） ──────────────────────────
 *
 * ⚠️ 上游**没有** `sign_in` / `check_in` 这种端点（2026-11-03 实测：`/points/v1`、
 *    `/points/v2` 下 `sign_in` / `check_in` / `daily` / `claim` / `attendance` 等
 *    一票名字全是 Go mux 的 `404 page not found`）。真正的触发器是**办公端**的
 *    `GET /api/web/office/v3/setting_info`：
 *
 * - 带**桌面端身份头**访问一次，服务端就按天幂等地发放当日「每日赠送积分」，
 *   并顺手补发漏掉的日子（实测首次触发补齐了前两天各 300）；
 * - 响应里的 `point_grant_popups` / `point_grant_toast` 是上游「今天发了什么」的
 *   提示（已发过则为空），有就直接用，没有就**以账单为准**。
 *
 * 所以「签到」= 打这个只读端点 + 用账单核对：两个动作都不产生副作用，
 * 重复调用只会返回「今天已经发过了」。成功判据是账单里真的出现今天的入账
 * —— 触发请求 200 不等于发了（这正是本项目在别的渠道踩过的假成功）。
 */
/** UTC+8 的当天日期（`YYYY-MM-DD`）—— 上游每日积分按北京零点切日。 */
export function raccoonUtc8Date(nowMs = Date.now()) {
    return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
/**
 * 触发一次「每日积分发放」（按天幂等）。
 *
 * @returns `ok: false` 表示上游拒绝/网络失败（`message` 带原因）；
 *          `ok: true` 时 `toast` / `popups` 是上游自带的发放提示，可能为空。
 */
export async function triggerRaccoonDailyGrant(product, credential, fetcher = fetch) {
    const envelope = await requestJson(`${product.apiBase}${RACCOON_OFFICE_PREFIX}/setting_info`, credential, product, { method: 'GET' }, fetcher);
    if (!envelope.ok) {
        const reason = envelope.message.length > 0 ? envelope.message : `HTTP ${envelope.code}`;
        return { ok: false, message: `每日积分触发失败：${reason}`, toast: '', popups: [] };
    }
    const data = envelope.data ?? {};
    const toast = typeof data.point_grant_toast === 'string' ? data.point_grant_toast : '';
    const popups = Array.isArray(data.point_grant_popups)
        ? data.point_grant_popups.filter((item) => typeof item === 'object' && item !== null)
        : [];
    return { ok: true, message: '', toast, popups };
}
/**
 * 拉「收入」账单（只含发放记录，不含消耗）。
 *
 * ⚠️ **必须走 v2 + `type=income`**，不能用 `/points/v1/bills` 的前 N 条：
 * 那个接口按时间倒序返回全部记录（消耗也在里面），一个正常使用的账号每天几十条
 * 消耗，几十页之内就把发放记录挤出窗口 —— 实测就会出现「明明两笔 3000 都领过，
 * 状态却显示未领取」，用户点下去又永远 `granted:false`。
 *
 * @returns `null` 表示查不到（调用方不得编造 0）。
 */
async function fetchRaccoonIncomeBills(product, credential, fetcher) {
    const envelope = await requestJson(`${product.apiBase}${RACCOON_POINTS_V2_PREFIX}/bills?paging.limit=100&type=income`, credential, product, { method: 'GET' }, fetcher);
    if (!envelope.ok || envelope.data === undefined)
        return null;
    const items = Array.isArray(envelope.data.items) ? envelope.data.items : [];
    return items.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
}
/**
 * 读账单，汇总「今天（UTC+8）到账的积分」。
 *
 * @returns `null` 表示账单查不到（调用方必须当成失败，不能编造 0）。
 */
export async function fetchRaccoonTodayGrants(product, credential, fetcher = fetch) {
    const items = await fetchRaccoonIncomeBills(product, credential, fetcher);
    if (items === null)
        return null;
    const today = raccoonUtc8Date();
    const entries = [];
    for (const item of items) {
        const points = readNumber(item.points);
        if (points === undefined || points <= 0)
            continue;
        const createdAt = typeof item.created_at === 'string' ? item.created_at : '';
        // ⚠️ 上游 created_at 带 +08:00 偏移，直接截前 10 位就是北京日期
        if (createdAt.slice(0, 10) !== today)
            continue;
        entries.push({
            name: typeof item.event_name === 'string' ? item.event_name : '积分发放',
            points,
        });
    }
    return {
        total: entries.reduce((sum, entry) => sum + entry.points, 0),
        entries,
    };
}
/**
 * 每日签到：触发每日积分发放，再用账单核对。
 *
 * - 今天账单里有入账 ⇒ `claimed`（`credit` 是今天到账合计，含上游补发的历史缺额）；
 * - 今天没有入账 ⇒ `already-claimed`（服务端按天幂等：今天已经发过了）；
 * - 触发或账单失败 ⇒ `failed`（带原因，**不虚报成功**）。
 *
 * ⚠️ `coversToday` 恒为 true：这个渠道的结果**就是**按今天的账单算出来的。
 */
export async function claimRaccoonDailyCheckin(product, credential, fetcher = fetch) {
    // ⚠️ 判据用**余额前后差**，不是只用账单：账单有同步延迟（官方文档原文
    //   「积分记录同步可能存在一定延迟」，实测触发后立刻拉账单还看不到今天这笔，
    //   但余额已经 +300）。只用账单会把「刚发放成功」误报成「今天早就发过了」，
    //   用户看到的是「已领」而实际到账，逐日累计就差了一整笔。
    const before = await fetchRaccoonCreditBalance(product, credential, fetcher);
    const triggered = await triggerRaccoonDailyGrant(product, credential, fetcher);
    if (!triggered.ok) {
        return { kind: 'failed', code: -1, message: triggered.message, coversToday: true };
    }
    const after = await fetchRaccoonCreditBalance(product, credential, fetcher);
    if (before !== null && after !== null) {
        const gained = Math.round((after.total - before.total) * 100) / 100;
        if (gained > 0) {
            return {
                kind: 'claimed',
                credit: gained,
                streakDays: 0,
                isStreakDay: false,
                unit: 'credit',
                coversToday: true,
            };
        }
    }
    // 余额差为 0（或余额查询失败）时再问账单：今天早些时候真的到过账吗？
    const today = await fetchRaccoonTodayGrants(product, credential, fetcher);
    if (today !== null && today.total > 0) {
        const detail = today.entries.slice(0, 3).map((entry) => `${entry.name}+${entry.points}`).join('，');
        return {
            kind: 'already-claimed',
            message: `今日已到账 ${today.total}（${detail}）`,
            coversToday: true,
        };
    }
    return {
        kind: 'already-claimed',
        message: triggered.toast.length > 0
            ? triggered.toast
            : '今日每日积分此前已到账（触发按天幂等，不会重复发放）',
        coversToday: true,
    };
}
/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
    fetchBalance: (credential, fetcher) => fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
    claimLoginReward: (credential, fetcher) => claimRaccoonLoginReward(RACCOON, credential, fetcher),
    fetchOnboardingStatus: (credential, fetcher) => fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
    claimDailyCheckin: (credential, fetcher) => claimRaccoonDailyCheckin(RACCOON, credential, fetcher),
    triggerDailyGrant: (credential, fetcher) => triggerRaccoonDailyGrant(RACCOON, credential, fetcher),
};
//# sourceMappingURL=raccoon-credits.js.map