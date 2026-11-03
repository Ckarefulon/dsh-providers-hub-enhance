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

`auto-checkin`（每日首次启动自动签到）不需要改：它按「账号池里真的有账号的渠道」逐渠道调
`claim`，Raccoon 有了 `claim` 就会自动带上。

## 7. 踩坑记录（探测协议时的注意事项）

- **绝不用 POST 去试探端点是否存在**：`POST /api/web/auth/v1/logout` 会真的把当前 session 销掉
  （access + refresh 全部 401，只能重新扫码）。探测只用 GET；POST-only 路由在 GET 下同样 404，
  存在性只能靠客户端 bundle / 文档确认。
- `raw.githubusercontent.com` 在某些网络（含本项目作者的开发机）会被 SNI 阻断，
  取仓库文件改用 `git/trees` + `git/blobs` 接口更稳。
