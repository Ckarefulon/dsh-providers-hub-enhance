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
| `lib/index.js` | `installRateLimitResume(ctx, pool)`（与 `installLoopResume` 并列：那边管「思考打转」，这边管「被服务端限流」，互不吞并） |
| `lib/jet-hub-rpc.js` | 三条端点 `resume.getState` / `resume.setArmed` / `resume.setEnabled` |
| `lib/client/jet-hub.js` | 报错行尾图标按钮（DOM 增强）+ 设置弹窗「中断后自动继续」分区的默认开关 |

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

⚠️ 2.22 起上游页头改成了「左侧导轨 + 设置弹窗」，原来挂在那排 `.dim-jh-headerActions`
里的开关已**搬进设置弹窗**的「中断后自动继续」分区（锚点是 `// ② 定时签到` 之后，
样式复用上游自己的 `.dim-jh-settingsSection*`）。

## 8. 踩坑记录（探测协议时的注意事项）

- **绝不用 POST 去试探端点是否存在**：`POST /api/web/auth/v1/logout` 会真的把当前 session 销掉
  （access + refresh 全部 401，只能重新扫码）。探测只用 GET；POST-only 路由在 GET 下同样 404，
  存在性只能靠客户端 bundle / 文档确认。
- `raw.githubusercontent.com` 在某些网络（含本项目作者的开发机）会被 SNI 阻断，
  取仓库文件改用 `git/trees` + `git/blobs` 接口更稳。

## 9. 已删除的两项（上游 2.22 自己实现了）

| 曾经补的 | 为什么删 |
|---|---|
| CodeBuddy 出站守卫（fetch 层改写四段指纹，修 `400 / 11128`） | 上游 `lib/openai-gateway/tencent-fingerprint.js` 已覆盖**同样四段**指纹（连 2026-10-28 那次真实报障都写进了它的注释），且 `buddy-growth` / `buddy-compensation` **不做任何裸 HTTP** ⇒ 不存在绕过路径。再包一层 `globalThis.fetch` 只是徒增风险 |
| 账号「临期置顶」开关（按积分包到期自动重排账号顺序） | 上游已按**积分到期档位**排序（`ORDER_HINT_SUBTLE` 明说「某号没有临期积分时会被排到后面」），**默认开启**，并配了 `strictManualOrder`（RPC `strictManualOrder.getEnabled` / `setEnabled`，池内持久化）来做反选。语义重复，两套一起动会互相打架 |

> 想复原这两项的技术细节：翻 1.3.0 的 `patch-data.json` 与对应资产。它们退役的原因是**上游变好**，不是不可用。
