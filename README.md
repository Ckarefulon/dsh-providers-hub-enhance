# 🐻 dsh-raccoon-checkin

给 [dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub) 的 **Raccoon（商汤小浣熊）** 渠道补上**每日签到** —— 顺带把上游漏掉的**手机端登录奖励 +3000 积分**也打回来。

补丁改的是 `node_modules` 里的构建产物，所以本项目交付的不是「改好的文件」，而是一个**可重放、可还原、带守卫**的补丁器：插件升级/重装之后，重跑一次就补回来。

```bash
node patch.mjs          # 打补丁
node patch.mjs --check  # 只看状态
node patch.mjs --revert # 还原
```

> [!NOTE]
> 打完补丁**必须重启 DeepSeek Harness**（宿主侧模块在进程启动时就加载了），重启后刷新页面，Raccoon 卡片上才会出现「一键领取积分」。

---

## 为什么需要它

上游当前（以及 2.13.x 最新版）的结论是：

> ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放，**刻意不提供 `claim`**

这个结论是**漏查**：作者只在 `/api/web/points/v1|v2` 下找过，而那里确实没有 `sign_in` / `check_in` / `daily` / `claim`（全是 404）。但每日积分的触发器在**办公端**：

| 能力 | 端点 | 说明 |
|---|---|---|
| 每日签到 | `GET /api/web/office/v3/setting_info` | 带桌面端身份头访问一次，服务端**按天幂等**发放当日每日积分，并**补发**漏掉的日子 |
| 手机端首登奖励 | `POST /api/web/mobile/v1/login/points/grant` | 一次性 **+3000**，与桌面端那条**互不共享额度** |

实测（2026-11-03，三个真实账号）：

- 一个连续多日没签到的账号，一次触发补回了**前两天的 300 + 当天的 300**；
- 桌面端奖励早已领过的账号，手机端那条照样 `granted: true` → **+3000**。

顺带修掉一个会**静默漏分**的旧 bug：登录奖励是否已领，上游用 `/points/v1/bills` 的前 50 条判断，而那个接口混着消耗记录 —— 用得越久，发放记录越会被挤出窗口，界面就永远显示「未领取」、点下去永远 `granted: false`。现在改走 `/points/v2/bills?type=income`（只返回发放记录）。

细节与协议依据见 [docs/how-it-works.md](docs/how-it-works.md)。

## 快速开始

前置：Node.js ≥ 18，且本机已经装好 `dsh-providers-hub` 插件。

```bash
git clone https://github.com/Ckarefulon/dsh-raccoon-checkin.git
cd dsh-raccoon-checkin
node patch.mjs
```

脚本会自动找 `~/.dsh/profiles/{desktop,web}` 下的插件；找不到时手动指定：

```bash
node patch.mjs --profile desktop                          # 指定 profile 名
node patch.mjs --dir "C:/Users/me/.dsh/profiles/desktop"  # 指定 profile 目录或包目录都行
```

改完重启 DSH → 刷新页面 → Raccoon 卡片上出现「一键领取积分」，之后每日签到（含「每日首次启动自动签到」）都会把它带上。

## 插件升级之后

`pnpm update` / 重装 / 换版本会整个替换 `node_modules`，补丁随之消失。**重跑一次即可**：

```bash
node patch.mjs
```

脚本是幂等的：已打过的文件会报「已应用」，不会重复改。

实测兼容：

| 插件版本 | 结果 |
|---|---|
| `1.6.261016` | ✅ 补丁后的文件与人工验证过的版本**逐字节一致** |
| `2.13.261102`（当前最新） | ✅ 全部锚点命中，功能验证通过 |

## 它怎么保证不乱改

补丁描述在 [patch-data.json](patch-data.json)，两种打法：

- **整文件替换**（`lib/raccoon.js`、`lib/raccoon-credits.js`）：只用于在已知版本之间**逐字节相同**的文件，并带 SHA256 守卫 —— 目标既不等于「已知原版」也不等于「已打补丁版」时**拒绝覆盖**（说明上游改过这个文件）。
- **锚点替换**（`provider-credits` / `provider-registry` / `raccoon-auth` / client bundle）：每条锚点必须**唯一命中**；命中 0 次（版本变了）或多次（锚点不唯一）就**立即报错、整体不写盘**，绝不产出半截补丁。

另外还有两道保险：

- 首次打补丁会给每个被改的文件留一份 `<文件>.rcc-orig`，`--revert` 用它还原；
- 写盘后会做一次**语法自检**（`node --check`），失败就自动从备份回滚 —— 语法错误会让 DSH 直接起不来，宁可不落地。

## 补了什么（代码层面）

| 文件 | 改动 |
|---|---|
| `lib/raccoon-credits.js` | 新增 `claimRaccoonDailyCheckin` / `triggerRaccoonDailyGrant` / `fetchRaccoonTodayGrants`；登录奖励改为桌面端 + 手机端两边都打；状态查询改走 v2 income 账单 |
| `lib/raccoon.js` | 新增办公端 / 移动端前缀与客户端身份常量 |
| `lib/raccoon-auth.js` | `claimDailyCheckin()` 实例方法（走注入的 `fetchImpl`） |
| `lib/provider-credits.js` | Raccoon 的 `claim` 实现（替换原来的 `claimUnavailableReason`） |
| `lib/provider-registry.js`、`lib/client/jet-hub.js` | 能力表登记 `dailyCheckin: true`，面板才会渲染签到按钮 |

## 常见问题

**签到报「每日积分触发失败」？**
多半是凭据过期。插件自己的续期会处理；持续失败就在面板里重新登录该账号。

**签到显示「今日已到账」，但余额没感觉涨？**
每日积分是**当日额度**，会先被消耗（官方扣减顺序：每日 → 每月 → 奖励 → 加油包）。另外账单有同步延迟，触发后立刻拉账单看不到当天那笔是正常的 —— 本补丁用**余额前后差**判定，就是为了绕开这个延迟。

**会不会多领/重复领？**
不会。触发端点是按天幂等的；登录奖励每个账号每端只能领一次（服务端返回 `granted:false`）。

**能卸载吗？**
```bash
node patch.mjs --revert
```
还原后重启 DSH 即可。

**支持其他 provider 吗？**
不支持。这是针对 Raccoon 的定点补丁，无权改别的渠道。

## 免责声明

- 本项目是**非官方**的本地补丁，与商汤科技、DeepSeek Harness、`dsh-providers-hub` 作者均无隶属关系。
- 补丁只修改本机 `node_modules` 里的构建产物，不修改插件配置、不上报任何数据、不包含任何账号凭据。
- 请遵守所用服务的用户协议，使用风险自负。

## 致谢

- 端点线索来自 [L0NE-6/Raccoon-Daily](https://github.com/L0NE-6/Raccoon-Daily)（小浣熊每日积分脚本）。
- 被补丁的目标是 [dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub)（MIT）。
- 第三方来源与许可细节见 [NOTICE.md](NOTICE.md)。

## License

[MIT](LICENSE)
