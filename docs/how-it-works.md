# 它是怎么工作的

这份文档记录补丁背后的协议事实与踩过的坑，方便上游修复后自行比对、或移植到别的渠道。

## 1. 上游为什么以为「没有签到」

上游在 `provider-credits.js` / `provider-registry.js` 里写着：

> ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放……

它只探测了 `/api/web/points/v1`、`/api/web/points/v2`。实测这些名字在 points 前缀下**确实都是 404**
（Go mux 的 `404 page not found`）：`sign_in`、`signin`、`sign`、`check_in`、`checkin`、
`attendance`、`daily`、`daily_grant`、`claim`、`reward(s)`、`missions`、`tasks`、`calendar`……

触发器在**办公端**：

```
GET /api/web/office/v3/setting_info
   Authorization: Bearer <access_token>
   X-Client-Platform: desktop-windows
   X-Client-Version: v1.0.35
   X-Raccoon-Language: zh
```

这个端点的本职是「拉办公端设置」（空间用量、每日提问次数等），但服务端在处理它时会
**顺带结算当日每日积分**：按天幂等，并补发漏掉的自然日。响应里可能带
`point_grant_popups` / `point_grant_toast`（当天真的发了才有内容，已发过则为空）。

## 2. 判定成功：用余额差，不要只看账单

踩过的坑（真实缺陷）：

- 触发**成功之后立刻**拉 `/points/v1/bills`，**看不到**当天那笔 —— 官方文档也写了「积分记录同步
  可能存在一定延迟」。此时若以账单为准，会把「刚刚发放成功」误报成「今天早就发过了」，
  用户看到「已领」而实际没记账，逐日累计就差了一整笔。
- 正确做法：触发前后各读一次 `/points/v1/balance`，**用 `available_points` 的差值**判定；
  差值为 0 时再查账单，用来区分「今天早些时候已到账」与「确实没发」。

## 3. 账单必须走 v2 + type=income

登录奖励的「是否已领」在上游是用 `/points/v1/bills?paging.limit=50&paging.offset=0` 的前 50 条判断的。
那个接口按时间倒序返回**全部**记录（对话消耗也在里面）。正常使用的账号每天几十条消耗，
很快就把发放记录挤出了窗口 —— 表现是：两笔 3000 明明都领过，界面却一直显示「未领取」，
用户点下去永远 `granted: false`。

改用：

```
GET /api/web/points/v2/bills?paging.limit=100&type=income
```

只返回发放记录（`biz_type` 形如 `daily_grant` / `reward_grant`），不会漂移。
有效 `type` 值实测为 `all` / `income` / `expense`，其余返回 400。

## 4. 两条登录奖励是独立的

| 端点 | 客户端身份 |
|---|---|
| `POST /api/web/desktop/v1/login/points/grant` | `X-Client-Platform: desktop-windows` + `X-Client-Version: v1.0.35` |
| `POST /api/web/mobile/v1/login/points/grant` | `X-Client-Platform: app-android` + `X-Client-Version: v1.0.3` |

- 每条一次性，幂等：重复调用返回 `granted: false`，不报错；
- **互不共享额度**：桌面端领过的账号，手机端那条照样 `granted: true` → +3000；
- 账单里的 `event_name` 分别是「桌面端登录奖励」「移动端登录奖励」，是判定「已领」的可靠依据。

## 5. 和「登录」的关系（顺带排掉的假设）

官方积分规则的原文是：每日赠送积分每天 00:00 自动发放，**是否登录不影响发放**；
但**当天登录过**，这一笔的有效期从当日 24:00 延长到 7 天（发放日 +6 天的 24:00）。

于是试过「能不能用别的方式伪造一次登录」——都不行（实测）：

- `POST /api/web/auth/v1/refresh`（续期）**不会**更新 IAM 的 `last_login_at`；
- `POST …/desktop/v1/login/points/grant`（领登录奖励）也不会；
- 真正的登录要扫码（`login_with_qrcode_code`）或短信验证码，都是人工动作。

结论：能自动做的只有**触发发放**（`setting_info`），想把有效期延到 7 天只能真的登录一次。
补丁做的就是把前者变成每天自动一次。

## 6. 补丁的落点

| 文件 | 改动 |
|---|---|
| `lib/raccoon.js` | 常量：`RACCOON_OFFICE_PREFIX`、`RACCOON_MOBILE_PREFIX`、`RACCOON_MOBILE_PLATFORM/VERSION`、`RACCOON_POINTS_V2_PREFIX` |
| `lib/raccoon-credits.js` | `claimRaccoonDailyCheckin`（触发 + 余额差核对 + 账单兜底）、`triggerRaccoonDailyGrant`、`fetchRaccoonTodayGrants`、`fetchRaccoonIncomeBills`；登录奖励两端合打；状态改走 v2 |
| `lib/raccoon-auth.js` | `claimDailyCheckin()` 实例方法（走注入的 `fetchImpl`，测试替身/代理不被绕过） |
| `lib/provider-credits.js` | Raccoon 的 `claim` 实现（替换 `claimUnavailableReason`） |
| `lib/provider-registry.js` / `lib/client/jet-hub.js` | `credits.dailyCheckin: true`（面板才会渲染签到按钮） |
| `lib/rate-limit-resume.js` | **新建**：限流判据、解禁时刻推算、待续跑钩子（落盘 + 恢复）、`agent.followup` 投递 |
| `lib/codebuddy-guard.js` | **新建**：CodeBuddy 出站守卫（fetch 层四段指纹改写，见 §9） |
| `lib/buddy-adapter.js` | 构造改走 `guardCodeBuddyFetch(options.fetchImpl ?? fetch)` |
| `lib/index.js` | `installCodeBuddyGuard(ctx)`（放在 `apply()` 最前面）+ `installRateLimitResume(ctx, pool)`（与 `installLoopResume` 并列，管的是不同失败类） |
| `lib/jet-hub-rpc.js` | 三条端点 `resume.getState` / `resume.setArmed` / `resume.setEnabled` |
| `lib/client/jet-hub.js` | 报错行尾图标按钮（DOM 增强）+ 设置页顶部默认开关 |

`auto-checkin`（每日首次启动自动签到）不需要改：它按「账号池里真的有账号的渠道」逐渠道调
`claim`，Raccoon 有了 `claim` 就会自动带上。

## 7. 限流中断后的「解禁后自动继续」

### 判据：什么才算「等得及」

| 信号 | 归类 | 为什么 |
|---|---|---|
| `code === 'RATE_LIMIT'` | rate | providers-hub 的 `httpErrorCode(429)` 就映射到它 |
| `status === 429` | rate | **必须早于文案判据**：网关 / CDN 可以回**空体** 429 |
| `code === 'QUOTA' / 'ACCOUNT_QUOTA'` | quota | 上游按日或按窗口封，仍有解禁时刻 |
| 正文含「限流 / 频率 / too many requests / rate limit」 | rate | 部分渠道只把话写进正文 |
| 正文含「额度 / 积分不足 / 14018 / credits exhausted」 | quota | 同上 |

不该归进来的：`INVALID_REQUEST`(400)、`AUTH`(401/403)、`SERVER`(5xx) ——
那些等一会儿也不会自愈，自动续跑只会掩盖真故障。

### 解禁时刻：三条来源取**最保守**

1. `providerRetryAfterMs`（服务端指定的机器通道，`LlmError` 校验里要求 `> 0`）；
2. 账号池里该 provider + 模型的**未来最晚**限流标记（`pool.listAccountsByProvider()` 的
   `modelRateLimits[model]` 取 max）—— 取 max 是因为同一模型上 A 号可能封 1 小时、B 号封
   24 小时，「等谁」没有唯一答案；宁可晚一点（那时整池都解了）也不要早一秒去撞墙；
3. 兜底 1 小时（与 providers-hub 自己的 429 冷却同档）。

等待时长夹在 `[5 秒, 48 小时]`：下界防「解禁时刻已经过去」时在同一轮里连打；上界防
`setTimeout` 收到超过 2^31-1 的延时（Node 会给 1ms 警告并**立即触发**，那是真实的
「醒来太早」缺陷）。

### 到点之后

先**复核**池里是否仍未解禁（被推后则顺延，延后次数有上限，防「解禁时刻被反复推后」
无限循环），再经 `agent.followup` 投递。投递失败分两类：

| 形态 | 处理 |
|---|---|
| `no-live-agent` | **直接放弃**（会话已不在内存，没有「继续」的对象） |
| 其余（agents 未就绪 / 宿主抖动） | 按 5 分钟重试，钩子留着 |

### ⚠️ 续跑消息绝不冒充用户

`source.kind === 'user'` 是宿主对「直接人类输入」的**证明**，`tool-goal` 的增删改都据此
授权（见 providers-hub 的 `loop-recovery.ts` 模块头）。伪造它等于让自动续跑**冒用人类
授权**，UI 也会把它渲染成用户发言。故这里用自己的来源标识 `rate-limit-resume`，如实署名。

### 钩子为什么要落盘

「等 1 小时」必然跨越宿主重启（DSH 一天重启几次很正常）。只在内存里记的钩子会随进程
消失，用户第二天回来看到的就是「什么都没发生」。故写
`$DSH_HOME/jet-hub/rate-limit-resume.json`（与 `ui-preferences.json` 同目录、同原子写
tmp+rename 惯例），启动时恢复，恢复时丢弃无效 / 过旧记录。

### 客户端那半边

报错行（`.…_turnErrorRow`，类名哈希每次构建都变，**按后缀匹配**）没有任何插槽可挂，
故走 DOM 增强：一个 MutationObserver + 幂等标记。按钮是**原生 DOM** 不是 React 元素 ——
那个位置不在任何 React 树里，塞 React 元素只会渲染成 `[object Object]`（客户端 bundle
只有 `require('react')`，没有 `react-dom`）。

按钮状态**全部由宿主回答**（`resume.getState`）：本地不留状态机，所以关掉标签页再回来、
甚至宿主重启之后再打开，按钮都是对的。

### 设置页那个开关的语义

它改的是**默认值**（新中断的初值），**不追溯**已有记录 —— 追溯会把用户刚逐个点过的
按钮悄悄改回去。

## 8. 踩坑记录（探测协议时的注意事项）

- **绝不用 POST 去试探端点是否存在**：`POST /api/web/auth/v1/logout` 会真的把当前 session 销掉
  （access + refresh 全部 401，只能重新扫码）。探测只用 GET；POST-only 路由在 GET 下同样 404，
  存在性只能靠客户端 bundle / 文档确认。
- `raw.githubusercontent.com` 在某些网络（含本项目作者的开发机）会被 SNI 阻断，
  取仓库文件改用 `git/trees` + `git/blobs` 接口更稳。

## 9. CodeBuddy 出站守卫（400 / code 11128）

### 现象

走 buddy（CodeBuddy 中国版，`copilot.tencent.com`）时**每轮第一步**就挂：

```
400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

插件把这条包成「请求被拦截，请重新发送」，标签 `INVALID_REQUEST`。换账号、换模型、
换机器都一样；WorkBuddy 国际版（`www.workbuddy.ai`）不校验。

### 四段指纹（互不相关，必须一起修）

| # | 指纹 | 内核出处 | 位置语义 |
|---|---|---|---|
| 1 | `Tokens prefixed with @ are paths the user explicitly referenced…` | `@deepseek-ai/dsh-file-reference` | **位置无关**；assistant 里也拦，而且连前导空格 / tab / 换行 / BOM 都绕不过 |
| 2 | `You are an AI agent powered by DeepSeek\u200B Harness.` | `@deepseek-ai/dsh-system-prompt`（`includeHarnessIdentity`） | **仅消息开头**（前垫一整行能过、垫空格或 BOM 不能过） |
| 3 | `You are a coding agent powered by {model} model.` | `@deepseek-ai/dsh-web-app` 的 `personaPrefix` | 句式 `coding agent powered by`（换模型名救不了） |
| 4 | `You are interacting with the user through the DeepSeek\u200B Harness Web GUI…` / `Current DeepSeek\u200B Harness Web GUI URL` | `@deepseek-ai/dsh-harness-dev-context` | 在 system **尾部**，只做「开头锚定」的修法完全够不到 |

上表的**取证强度**要如实分开写：

- 四段的位置语义与「改写后放行」是 [dsh-wb400-guard](https://github.com/curo22/dsh-wb400-guard)
  在真实网关上逐项 A/B 打出来的（同账号同请求头，只换 body 里的 system 文本，
  含逐词删词消融）；
- 本机 2026-11-07 的**活** system prompt 里四段**全在**（`tests/codebuddy-guard.test.mjs`
  逐字断言，不是从文档转抄的常量）；
- **本补丁没有**在本机对 `copilot.tencent.com` 做 A/B（那需要真实 buddy 凭据）。
  故「改写后不再 400」这条结论借的是上游的实测，我们这边能证的是「改写确实发生了、
  范围与语义都对」。

### 为什么落在 fetch 层

上游自己已经有一层 `lib/openai-gateway/tencent-fingerprint.js`（表驱动），但它是
**按调用点**接入的（`serializeMessages` + `options.system`），管的是 ZCode / Claude Code
的两条客户端模板句 —— 与上面四段**不重叠**。而且按调用点接入意味着每新增一条出站路径
就要再补一次：上游自己在那个文件的注释里把 `buddy-growth.ts` 的两处直发 POST 登记成
「第三个未改写入口」，承认漏一处就是整轮 400。

fetch 同时满足三件事：**精准**（按 host 过滤，别家原样透传）、**不漏**（不管从哪个函数
发出去）、**盖得住重试阶梯**（`stream()` 内部的换号 / 限流 / 策略拦截每一级都重新发请求，
在 body 组装层改写会漏掉其中几级）。

### 为什么还要包适配器实例

`BuddyAdapter` 的构造函数里是 `this.fetchImpl = options.fetchImpl ?? fetch` ——
`fetch` 在**构造那一刻**就被求值并存进实例。若插件加载顺序让守卫晚于构造装上，
只包 `globalThis.fetch` 是**盖不到**这个实例的。故补丁同时改构造：

```js
this.fetchImpl = guardCodeBuddyFetch(options.fetchImpl ?? fetch);
```

`guardCodeBuddyFetch` 用 WeakMap 记忆化，并且当 `inner` 已经是装好的全局守卫时**直接返回
它** —— 两条接线重叠也不会叠成两层（两层会双倍改写 + 双倍日志，`--check` 看不出来，
只有日志里出现两条 `rewritten` 才暴露）。

### 语义与安全边界

| 约束 | 原因 |
|---|---|
| 只改 `system` / `developer` / `assistant` | `user` 是用户原话、`tool` 是回读给模型看的证据，实测网关也不拦它们 |
| `@` 只改**整段**文件引用里的，不做「见到 @ 就换」 | 裸 `@"`（PowerShell here-string / C# 逐字字符串）实测完全不触发；兜底只会把用户代码静默改坏 |
| 身份句只在**开头**改写 | 句中 / 尾部不拦，改了只是白改用户内容 |
| 幂等 | `rewrite(rewrite(x)) === rewrite(x)`；未改动时返回入参原引用（省掉不必要的重序列化） |
| fail-open | 改写链路任何异常都退回原请求；守卫**绝不**引入重试，也**不吞**网络错误 |
| 剔掉陈旧的 `Content-Length` | body 变短后还带旧长度，上游会按旧长度截断 |
| 只装一层（`Symbol.for`） | 后装的在外层会吞掉先装的日志与卸载 |
| 日志只留 origin + path | 查询串可能带 `prompt_cache_key` / token |

### 前缀缓存

改写是**确定性**的，每一轮对同一段文本产出同一份字节，故服务端前缀缓存只在「装上守卫
之前 vs 之后」那一次 miss，之后照旧命中。这也是为什么 `mode` 默认是 `anchor`
（只动四处）而不是 `all`（把所有 `@` 都换）—— 后者会让「用户改了一个 `@`」之类的
微妙差异变多，白丢缓存。

### 怎么验证

```bash
node scripts/verify-guard.mjs
```

三层：接线（`index.js` 装了没、`buddy-adapter.js` 包了没、模块在不在）→ 模块（真 import，
跑一遍四段改写 + 幂等 + host 作用域）→ 安装（假 ctx 上装一次，确认 `globalThis.fetch`
被替换、`ctx.effect` 拿到卸载函数、卸载后还原）。**不发网络请求**。

想看「到底哪一句会触发」，设 `DSH_CODEBUDDY_GUARD=dryrun` 再发一条消息，然后读
`$DSH_HOME/jet-hub/codebuddy-guard.jsonl` 里的 `would-rewrite` 记录。


## 10. 「临期置顶」为什么不按凭据有效期排

账号卡片上有两处「期限」，含义完全不同：

| 卡片上的位置 | 字段 | 过期会发生什么 |
|---|---|---|
| 有效期 | `ProviderAccountEntry.expiresAt` | **凭据 / 登录态过期**。多数渠道能静默续期（`refreshable`），续期成功后 `expiry-sync` 会把新值写回账号池 ⇒ 通常**不造成损失** |
| 积分行 | `CreditBalance.packages[].deductionEndTime` | **额度作废**。时刻一过，包里剩多少就归零 ⇒ 真的白丢钱 |

所以「临期期限近」= 该账号手里**最早会作废且还有余量**的积分包的到期时刻，
判据逐条如下（`assets/expiry-first.js` 的 `packageExpiryMs`）：

| 情况 | 处理 | 为什么 |
|---|---|---|
| `active !== true` | 跳过 | 已失效的包不再计费，算进去只是噪音 |
| `remaining <= 0` | 跳过 | 否则「积分早就用完的号」会永远排第一 |
| 没有 `deductionEndTime` | 视作**永久**，不参与排序 | 服务端没给到期时间 ≠ 马上过期；反过来把永久包排最前会让真正临期的号掉到后面 |
| `deductionEndTime <= now` | 跳过 | 那批额度已经作废了，再把它顶到前面只会挤掉还有额度的号 |
| 只有字符串 `expiredTime` | `Date.parse(换空格为 T)` 兜底 | officeace 这类渠道（`creditGroups[].expiresAt`）只给字符串；与客户端既有的 `packageExpiryMs` 同一口径 |

顺序本身**就是**自动选号的优先级（`account-pool.ts` 的 `getAvailableAccount` 按数组序取第一个
可用账号），所以这里走的是**真的写盘**（`account.reorder`，与拖拽写的是同一份），
而不是一个只影响渲染的视图排序。

### ⚠️ 写入侧必须用 `listAccountsByProvider`，不能用 `listAccounts`

`listAccounts` 会**稳定地把限流中的账号沉到最后**（工单 08，纯视图排序，刻意**不动**存储
顺序）。若拿它的返回顺序去算新顺序再写回，等于把「限流沉底」这个纯展示决定**固化进存储
顺序** —— 限流一解除，那个号就真的留在末尾了（而不是自己回到原位）。故写入侧一律读
`pool.listAccountsByProvider(provider)`（存储序）。

### 触发时机：挂在 `credits.balances` 的返回处，不逐 provider 分支加

开关打开后，重排的挂点是 `jet-hub-rpc.js` 里 `handleMethod` 返回**之前**那一处
（与既有的 `credits.claimAll` 清临期折算缓存同一个位置）：

```js
if (call.method === 'credits.balances' && result?.ok === true
    && Array.isArray(result.value?.accounts)) {
    await applyExpiryFirstFromBalances(call.payload.provider, result.value.accounts);
}
```

`credits.balances` 那个 case 里有**四个** `return`（opencode / qoder / officeace / 查表分派），
逐分支去加必然漏一个 —— 而且 opencode 与 qoder 两条的返回语句还**一字不差**
（拿它当锚点会命中 2 次）。挂在分派处一处覆盖全部，与既有手法一致。

### 三条「不写盘」红线

1. 渠道没有积分余额接口（`supportsCreditBalance(provider) === false`）⇒ 开关根本不渲染；
2. 一个临期都算不出来（余额还没查 / 查询失败 / 渠道本来就没有到期概念）⇒ **一个字都不写盘**。
   ⚠️ 这一条最要紧：`balance: null`（查询失败）与「没有临期」在数据里同形，照排等于把所有
   账号按 `undefined` 重排一遍，用户拖好的顺序会被一次查询失败打乱；
3. 算出来了但已经是最优顺序 ⇒ 不发 `account.reorder`（`plan.reordered === false` 判据）。
   另外 `reorder` 抛错只记一条 warn、不上抛 —— 余额已经查回来了，让排序失败把整份余额
   一并报废是拿功能换装饰。

> 复用的既有 RPC：`account.reorder`（`jet-hub-rpc.js` 已有端点，集合一致性校验也在宿主侧）。
> 余额本来就已由 `credits.balances` 拉到面板里 ⇒ 本功能**没有新增任何网络请求**。
> 新增的只有两条**本地**端点：`expiry.getState` / `expiry.setEnabled`。

### 开关状态落盘

`$DSH_HOME/jet-hub/expiry-first.json`（与 `rate-limit-resume.json` / `ui-preferences.json`
同目录，同「tmp + rename」原子写惯例）。**默认关**：它会改写用户自己拖出来的顺序，
未经同意不该自动动。读失败 / 文档损坏一律回落到默认（关）并留一条 warn —— 这是体验层
功能，配置写坏不该让插件起不来。