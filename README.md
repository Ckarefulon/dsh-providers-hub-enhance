# 🐻 dsh-providers-hub-enhance

给 [dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub) 打**增强补丁** —— 可重放、可还原、带守卫。

只补**上游仍然缺的**两件事：

| 能力 | 一句话 |
|---|---|
| **Raccoon 每日签到** | 上游写着「没有签到端点」，其实是漏查；顺带把**手机端登录奖励 +3000 积分**也打回来 |
| **限流中断后「解禁后自动继续」** | 会话因 429 / 额度耗尽中断时，报错行尾给一个可切换的图标按钮，解禁后自动续上；Jet Hub 设置弹窗里有默认开关 |

补丁改的是 `node_modules` 里的构建产物，所以本项目交付的不是「改好的文件」，而是一个补丁器：插件升级/重装之后，重跑一次就补回来。

```bash
node patch.mjs          # 打补丁
node patch.mjs --check  # 只看状态
node patch.mjs --revert # 还原
```

> [!NOTE]
> 打完补丁**必须重启 DeepSeek Harness**（宿主侧模块在进程启动时就加载了）。重启后刷新页面才会看到新功能。

## ⚠️ 2.0.0 起删掉了两项能力（上游自己实现了）

| 曾经补的 | 为什么删 |
|---|---|
| **CodeBuddy 出站守卫**（fetch 层改写四段指纹，修 `400 / 11128`） | 上游 `lib/openai-gateway/tencent-fingerprint.js` 已覆盖**同样四段**指纹（连 2026-10-28 那次真实报障都写进了注释），并且 `buddy-growth` / `buddy-compensation` **不做任何裸 HTTP**（不存在绕过路径）。再包一层 `globalThis.fetch` 只是徒增风险 |
| **账号「临期置顶」开关**（按积分包到期自动重排账号顺序） | 上游已按**积分到期档位**排序（且**默认开启**），并配了「严格手动顺序」开关来做反选。我的实现与它语义重复，两套一起动还会互相打架 |

> 这两项都是**因为上游变好而退役**，不是因为不好用。仍需要它们的话，用 1.x。

## 1. Raccoon（商汤小浣熊）每日签到

上游当前（含最新版）的结论是：

> ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放，**刻意不提供 `claim`**

这个结论是**漏查**：作者只在 `/api/web/points/v1|v2` 下找过（那里确实全是 404）。每日积分的触发器在**办公端**：

| 能力 | 端点 | 说明 |
|---|---|---|
| 每日签到 | `GET /api/web/office/v3/setting_info` | 带桌面端身份头访问一次，服务端**按天幂等**发放当日积分，并**补发**漏掉的日子 |
| 手机端首登奖励 | `POST /api/web/mobile/v1/login/points/grant` | 一次性 **+3000**，与桌面端那条**互不共享额度** |

顺带修掉一个会**静默漏分**的旧 bug：登录奖励是否已领，上游用 `/points/v1/bills` 的前 50 条判断，而那个接口混着消耗记录 —— 用得越久，发放记录越会被挤出窗口，界面就永远显示「未领取」。现在改走 `/points/v2/bills?type=income`（只返回发放记录）。

细节与协议依据见 [docs/how-it-works.md](docs/how-it-works.md)。

## 2. 限流中断后「解禁后自动继续」

被 429 / 额度耗尽打断的回合，宿主会把会话停在「本轮运行失败」。这类失败**等一会儿就会自愈**，但没人替你去点「继续」—— 于是任务就停在那儿了。

这个补丁做三件事：

1. **报错行尾的图标按钮（两态互切）**
   - 黄色延时图标 + 「解禁后自动继续」= 已开启：到解禁时刻自动把这一轮续上。
   - 红色叉图标 + 「不自动继续」= 已关闭：解禁后什么都不做，等你手动重发。
   - 点一下就在两态之间切换。按钮只在**限流类**报错行出现。
2. **Jet Hub「设置」弹窗里的总开关**（2.22 起页头改成了左侧导轨 + 设置弹窗，开关放在「中断后自动继续」分区）：决定**新中断**的默认行为，初始默认**开启**。已挂着的待续跑记录保持各自状态（不追溯），因为你可能刚逐个点过。
3. **跨重启**：待续跑记录写在 `$DSH_HOME/jet-hub/rate-limit-resume.json`，宿主重启后接着等 —— 限流解禁往往要一小时，那必然跨进程。

判据与取舍：

- **哪些失败算限流**：`RATE_LIMIT` 错误码 / HTTP 429（**含空体 429**，网关与 CDN 常见）/ `QUOTA` `ACCOUNT_QUOTA` / 正文里的中英文限流与额度字样。⚠️ providers-hub 把「号池里该模型全被限流」报成 `QUOTA_EXCEEDED`，但该码也被「积分不足」「额度或认证失败」共用 ⇒ 只作线索，最终由文案分流。
- **等多久**：三条来源取最保守的一条 —— ① 服务端给的 `providerRetryAfterMs`；② 账号池里该 provider+模型**未来最晚**的限流标记（max：同模型多账号可能封到不同时刻，宁可晚一点也不要早一秒去撞墙）；③ 兜底 1 小时。**必须「全部启用账号都受限」才算**（与上游 `allAccountsRateLimitedForModel` 同口径）。
- **到点前会复核**：宿主先看一眼池里是否仍未解禁，被推后就顺延；延后次数有上限。
- **什么情况下放弃**：会话已不在内存（`no-live-agent`）、用户手动发了消息、宿主自己开了新回合，或反复投递失败。
- **续跑消息不冒充用户**：它带自己的来源标识 `rate-limit-resume`，**绝不**写成 `source.kind === 'user'`（那是宿主对「直接人类输入」的证明，`tool-goal` 等工具据此授权）。

## 快速开始

前置：Node.js ≥ 18，且本机已经装好 `dsh-providers-hub`。

```bash
git clone https://github.com/Ckarefulon/dsh-providers-hub-enhance.git
cd dsh-providers-hub-enhance
node patch.mjs
```

脚本会自动找 `~/.dsh/profiles/{desktop,web}` 下的插件；找不到时手动指定：

```bash
node patch.mjs --profile desktop                          # 指定 profile 名
node patch.mjs --dir "C:/Users/me/.dsh/profiles/desktop"  # 指定 profile 目录或包目录都行
```

改完重启 DSH → 刷新页面。

## 插件升级之后

`pnpm update` / 重装 / 换版本会整个替换 `node_modules`，补丁随之消失。**重跑一次即可**：

```bash
node patch.mjs
```

脚本是幂等的：已打过的文件会报「已应用」，不会重复改。

实测兼容：

| 插件版本 | 结果 |
|---|---|
| `2.22.261111` | ✅ 12 条补丁项一次打上，`--check` 报「全部文件已就位」，`--revert` 能干净还原 |
| 更早的 `1.x` 系列 | ❌ 不适用 —— 客户端落点（「设置」弹窗）是 2.22 才有的；要那两项目前已删掉的能力请用本项目的 **1.x** 标签 |

## 它怎么保证不乱改

补丁描述在 [patch-data.json](patch-data.json)，四种打法：

| mode | 用途 | 守卫 |
|---|---|---|
| `file` | 整文件替换 | 只用于若干版本间**逐字节相同**的文件；目标既非已知原版、也非已打补丁版时**拒绝覆盖** |
| `anchor` | 锚点替换 | 每条锚点必须**唯一命中**；0 次（版本变了）或 >1 次（不唯一）**立即报错、整体不写盘** |
| `anchor-asset` | 把 assets 里的一整块代码插进锚点 | 同上，外加 `marker` 幂等判据 |
| `create` | 只新建补丁自带的模块文件 | 目标已存在且内容不认识时拒绝；`--revert` 只删「清单里确实由本补丁建的那些」 |

另外几道保险：

- 首次打补丁会给每个被改的文件留一份 `<文件>.phc-orig`，`--revert` 用它还原；
- 新建文件记在 `.phc-created.json`，还原时**只删自己建的**（手改过的会保留）；
- 写盘后跑**两道进程内自检**，任一失败就自动从备份回滚：
  - **语法**（`scripts/syntax-check.mjs`）；
  - **接线**（`scripts/wiring-check.mjs`）—— 见下。

> ⚠️ 受限环境（例如 DSH 的 Windows 沙箱）里子进程可能起不来：那时脚本会**如实跳过**自检并警告，而不是把它当成语法错误。
>
> ⚠️ 同一个文件可以被**多个**补丁项改（客户端 bundle 就是），补丁器按**路径分组**、在同一份内存文本上依次应用 —— 逐项各自读盘再写盘会让后一项整体覆盖前一项。这条对**锚点**同样成立：同一个文件里，两组的锚点行不能落在彼此 `replace` 的范围内（否则第二遍永远报「待锚点替换」）。

## 为什么多了一道「接线自检」

2.0.0 之前的一版在 `lib/index.js` 里插入了 `installExpiryFirst(ctx, pool);`，**却漏了配套的 import**。后果不是「功能不生效」，而是：

```
apply() 抛 ReferenceError: installExpiryFirst is not defined
  ⇒ 同一函数里后面的 registerJetHubRpc(...) 从未执行
  ⇒ /api/jet-hub 整条通道 404（面板全线 transport failure）
```

三道既有防线全都拦不住它：**语法自检只编译、不解析标识符**（`f()` 里 `f` 未定义是运行时错误）；锚点守卫的锚点全都正常命中了；单元测试测的是资产模块本身，不是「被 import 进宿主之后」的接线。

现在 `scripts/wiring-check.mjs` 补上这一格：凡是补丁插入的「本补丁自有函数调用」，都必须在同一个最终文件里能**import 到或就地定义**，否则写盘后直接回滚。判据刻意做得极窄（只查自有名字，不猜上游代码），宁可漏报也不误报。

## 补了什么（代码层面）

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 装上 `installRateLimitResume(ctx, pool)` |
| `lib/rate-limit-resume.js` | **新建**：限流判据、解禁时刻推算、待续跑钩子（含落盘与恢复）、`agent.followup` 投递 |
| `lib/jet-hub-rpc.js` | 三条端点 `resume.getState` / `resume.setArmed` / `resume.setEnabled` |
| `lib/client/jet-hub.js` | 报错行尾图标按钮（DOM 增强）+ 设置弹窗「中断后自动继续」分区的默认开关 |
| `lib/raccoon-credits.js` | 新增 `claimRaccoonDailyCheckin` / `triggerRaccoonDailyGrant` / `fetchRaccoonTodayGrants`；登录奖励两端合并；状态改走 v2 income 账单 |
| `lib/raccoon.js` | 办公端 / 移动端前缀与客户端身份常量 |
| `lib/raccoon-auth.js` | `claimDailyCheckin()` 实例方法（走注入的 `fetchImpl`） |
| `lib/provider-credits.js` | Raccoon 的 `claim` 实现（替换原来的 `claimUnavailableReason`） |
| `lib/provider-registry.js` | 能力表登记 `dailyCheckin: true`，面板才会渲染签到按钮 |

## 常见问题

**为什么 2.0.0 少了两个功能？**
因为上游 2.22 自己实现了（见上面的表格）。补丁只该补**上游缺的**东西，重复实现两套会互相打架。

**签到报「每日积分触发失败」？**
多半是凭据过期。插件自己的续期会处理；持续失败就在面板里重新登录该账号。

**签到显示「今日已到账」，但余额没感觉涨？**
每日积分是**当日额度**，会先被消耗。另外账单有同步延迟，触发后立刻拉账单看不到当天那笔是正常的 —— 本补丁用**余额前后差**判定就是为了绕开这个延迟。

**会不会多领/重复领？**
不会。触发端点是按天幂等的；登录奖励每个账号每端只能领一次（服务端返回 `granted:false`）。

**勾了「解禁后自动继续」，按钮过一会儿自己消失了？**
那是正常的：宿主在解禁时刻投递成功后就把记录清掉了（点下去已经没有意义，留着只会误导）。另外你自己发了一条消息、或宿主开了新回合，也会撤掉它。

**设置弹窗里开关关了，报错行按钮还是显示「解禁后自动继续」？**
那个开关决定的是**新中断的初值**，不追溯已有记录 —— 这是有意的（否则你刚逐个点过的按钮会被悄悄改回去）。在报错行上点一下即可改这一个。

**能卸载吗？**
```bash
node patch.mjs --revert
```
还原后重启 DSH 即可。

## 免责声明

- 本项目是**非官方**的本地补丁，与商汤科技、DeepSeek Harness、`dsh-providers-hub` 作者均无隶属关系。
- 补丁只修改本机 `node_modules` 里的构建产物，不修改插件配置、不上报任何数据、不包含任何账号凭据。
- 请遵守所用服务的用户协议，使用风险自负。

## 致谢

- 端点线索来自 [L0NE-6/Raccoon-Daily](https://github.com/L0NE-6/Raccoon-Daily)（小浣熊每日积分脚本）。
- 宿主侧续跑的手法参照了 [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) 与 `dsh-providers-hub` 自己的 `loop-recovery`。
- 被补丁的目标是 [dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub)（MIT）。
- 第三方来源与许可细节见 [NOTICE.md](NOTICE.md)。

## License

[MIT](LICENSE)
