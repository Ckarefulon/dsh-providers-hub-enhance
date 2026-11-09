# 🐻 dsh-providers-hub-enhance

给 [dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub) 打**增强补丁** —— 可重放、可还原、带守卫。

目前补三件事：

| 能力 | 一句话 |
|---|---|
| **CodeBuddy 出站守卫** | 腾讯国内网关的 `400 / 11128` 不再拦 DSH 的提示词；只对 `copilot.tencent.com` 生效，别的渠道一字节不碰 |
| **Raccoon 每日签到** | 顺带把上游漏掉的**手机端登录奖励 +3000 积分**也打回来 |
| **限流中断后「解禁后自动继续」** | 会话因 429 / 额度耗尽中断时，报错行尾给一个可切换的图标按钮，解禁后自动续上；Jet Hub 设置页顶部有默认开关 |

补丁改的是 `node_modules` 里的构建产物，所以本项目交付的不是「改好的文件」，而是一个补丁器：插件升级/重装之后，重跑一次就补回来。

```bash
node patch.mjs          # 打补丁
node patch.mjs --check  # 只看状态
node patch.mjs --revert # 还原
```

> [!NOTE]
> 打完补丁**必须重启 DeepSeek Harness**（宿主侧模块在进程启动时就加载了）。重启后刷新页面才会看到新功能。

---

## 1. CodeBuddy 出站守卫（400 / 11128）

走 buddy（CodeBuddy 中国版）时每轮第一步就挂，报文是：

```
本轮运行失败 400: ... code 11128 / "Illegal API invocation from an unapproved channel"
```

腾讯国内网关在服务端对 system / assistant 消息做通道校验。**触发规则的来源有四个，互不相关**，
而 DSH 默认四段全带着：

| # | 指纹 | 出处（DSH 内核） | 网关拦在哪 |
|---|---|---|---|
| 1 | `Tokens prefixed with @ are paths the user explicitly referenced…` | `@deepseek-ai/dsh-file-reference` | **任意位置**（system 与 assistant 都拦） |
| 2 | `You are an AI agent powered by DeepSeek⁻Harness.` | `@deepseek-ai/dsh-system-prompt` | **仅消息开头** |
| 3 | `You are a coding agent powered by {model} model.` | `@deepseek-ai/dsh-web-app` 的 `personaPrefix` | 句式 `coding agent powered by` |
| 4 | `You are interacting with the user through the DeepSeek⁻Harness Web GUI…` / `Current DeepSeek⁻Harness Web GUI URL` | `@deepseek-ai/dsh-harness-dev-context` | 同上（在 system 尾部） |

（`⁻` 是内核原文里的零宽空格 U+200B。）只修其中一段，其余几段照样 400 —— 这不是推理，
是 dsh-wb400-guard 对真实网关逐项 A/B 打出来的结论，本补丁把那套机制整条移植了过来。

**做法**：在宿主进程里包一层 `globalThis.fetch`，只对发往 `copilot.tencent.com` 的请求、
只对 `system` / `developer` / `assistant` 三条角色的 content 做**语义等价**改写：

| # | 改什么 | 改成什么 |
|---|---|---|
| 1 | 文件引用段里的 `@` | 等义写法 `(at)` |
| 2 | 开头的身份句 | `DeepSeek⁻Harness` → `DeepSeek-Harness`（零宽空格改连字符） |
| 3 | `coding agent powered by` | `coding agent running on`（模型名原样保留） |
| 4 | Web GUI 两句 | `… through this Web GUI` / `Current Web GUI URL` |

最后兜底把任何残留的 `DeepSeek` + 不可见分隔 + `Harness` 品牌指纹统一换成连字符写法。

**安全边界**（每条都有用例锁住）：

- **只改受防护 host**：别家 API（DeepSeek 官方、Raccoon、WorkBuddy 国际版…）**连对象引用都原样透传**；
- **只改 system / developer / assistant**：`user` 与 `tool` 里写的邮箱 `a@b.com`、`@某人`、代码里的
  here-string、正则，一个字符都不碰；
- **幂等**：第二遍改写不再变动，未改动时返回入参原引用；
- **fail-open**：改写链路任何异常都退回原始请求，不阻断对话、不引入重试；
- **剔掉陈旧的 `Content-Length`**（body 变短后还带旧长度，上游会按旧长度截断）；
- **不落盘、不上报**：日志里的 URL 只留 origin + path，查询串（可能带 `prompt_cache_key`、token）一律剥离；
- **只装一层**：`Symbol.for` 保证重复安装不会叠成两层守卫。

开关（改环境变量即可，**不用重打补丁**）：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `DSH_CODEBUDDY_GUARD` | `off` | 完全不碰 fetch |
| | `dryrun` | 只观测：一个字节都不改，命中只记 `would-rewrite`（排障用） |
| | `all` | 扫描角色里的所有 `@` 都换成 `(at)`（内核改了措辞时的兜底） |
| `DSH_CODEBUDDY_GUARD_MODE` | `anchor` / `all` | 同上 |
| `DSH_CODEBUDDY_GUARD_HOSTS` | 逗号分隔 | 追加 host，以 `.` 开头做后缀匹配（例如 `.workbuddy.ai`） |
| `DSH_CODEBUDDY_GUARD_LOG` | 路径 | 覆盖日志位置 |

日志默认 `<DSH_HOME>/jet-hub/codebuddy-guard.jsonl`（与 `rate-limit-resume.json` 同目录）。

**怎么确认它在工作**：

```bash
npm run verify            # 或 node scripts/verify-guard.mjs
```

它会依次回答三件事：补丁的接线在不在（`index.js` 有没有装、`buddy-adapter.js` 有没有包）、
真模块能不能把四段指纹改写掉、守卫能不能装上并还原。不发网络请求。

想抓「到底哪一句会被拦」，把它设成只观测模式再发一条消息：

```powershell
$env:DSH_CODEBUDDY_GUARD = 'dryrun'   # 重启 DSH 后生效
Get-Content "$env:USERPROFILE\.dsh\jet-hub\codebuddy-guard.jsonl" -Tail 20
```

## 2. 限流中断后「解禁后自动继续」

被 429 / 额度耗尽打断的回合，宿主会把会话停在「本轮运行失败」。这类失败**等一会儿就会自愈**，但没人替你去点「继续」—— 于是任务就停在那儿了。

这个补丁做三件事：

1. **报错行尾的图标按钮（两态互切）**
   - 黄色延时图标 + 「解禁后自动继续」= 已开启：到解禁时刻自动把这一轮续上。
   - 红色叉图标 + 「不自动继续」= 已关闭：解禁后什么都不做，等你手动重发。
   - 点一下就在两态之间切换。按钮只在**限流类**报错行出现。
2. **Jet Hub 设置页顶部的总开关**：决定**新中断**的默认行为，初始默认**开启**。已挂着的待续跑记录保持各自状态（不追溯），因为你可能刚逐个点过。
3. **跨重启**：待续跑记录写在 `$DSH_HOME/jet-hub/rate-limit-resume.json`，宿主重启后接着等 —— 限流解禁往往要一小时，那必然跨进程。

判据与取舍：

- **哪些失败算限流**：`RATE_LIMIT` 错误码 / HTTP 429（**含空体 429**，网关与 CDN 常见）/ `QUOTA` `ACCOUNT_QUOTA` / 正文里的中英文限流与额度字样。
- **等多久**：三条来源取最保守的一条 —— ① 服务端给的 `providerRetryAfterMs`；② 账号池里该 provider+模型**未来最晚**的限流标记（取 max 是因为同模型多账号可能封到不同时刻，宁可晚一点也不要早一秒去撞墙）；③ 兜底 1 小时。
- **到点前会复核**：宿主先看一眼池里是否仍未解禁，被推后就顺延；延后次数有上限，避免「解禁时刻被反复推后」无限循环。
- **什么情况下放弃**：会话已不在内存（`no-live-agent`）、用户手动发了消息、宿主自己开了新回合，或反复投递失败。
- **续跑消息不冒充用户**：它带自己的来源标识 `rate-limit-resume`，**绝不**写成 `source.kind === 'user'`（那是宿主对「直接人类输入」的证明，`tool-goal` 等工具据此授权）。

## 3. Raccoon（商汤小浣熊）每日签到

上游当前（以及 2.13.x 最新版）的结论是：

> ⚠️ **raccoon 没有签到端点**：每日 300 积分由服务端按日自动发放，**刻意不提供 `claim`**

这个结论是**漏查**：作者只在 `/api/web/points/v1|v2` 下找过（那里确实全是 404）。每日积分的触发器在**办公端**：

| 能力 | 端点 | 说明 |
|---|---|---|
| 每日签到 | `GET /api/web/office/v3/setting_info` | 带桌面端身份头访问一次，服务端**按天幂等**发放当日积分，并**补发**漏掉的日子 |
| 手机端首登奖励 | `POST /api/web/mobile/v1/login/points/grant` | 一次性 **+3000**，与桌面端那条**互不共享额度** |

顺带修掉一个会**静默漏分**的旧 bug：登录奖励是否已领，上游用 `/points/v1/bills` 的前 50 条判断，而那个接口混着消耗记录 —— 用得越久，发放记录越会被挤出窗口，界面就永远显示「未领取」。现在改走 `/points/v2/bills?type=income`（只返回发放记录）。

细节与协议依据见 [docs/how-it-works.md](docs/how-it-works.md)。

## 快速开始

前置：Node.js ≥ 18，且本机已经装好 `dsh-providers-hub` 插件。

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
| `1.6.261016` | ✅ 补丁后的文件与人工验证过的版本**逐字节一致** |
| `2.13.261102` | ✅ 全部锚点命中，签到功能验证通过 |

## 它怎么保证不乱改

补丁描述在 [patch-data.json](patch-data.json)，四种打法：

| mode | 用途 | 守卫 |
|---|---|---|
| `file` | 整文件替换 | 只用于若干版本间**逐字节相同**的文件；目标既非已知原版、也非已打补丁版时**拒绝覆盖** |
| `anchor` | 锚点替换 | 每条锚点必须**唯一命中**；0 次（版本变了）或 >1 次（不唯一）**立即报错、整体不写盘** |
| `anchor-asset` | 把 assets 里的一整块代码插进锚点 | 同上，外加 `marker` 幂等判据 |
| `create` | 只新建补丁自带的模块文件 | 目标已存在且内容不认识时拒绝；`--revert` 只删「清单里确实由本补丁建的那些」 |

另外三道保险：

- 首次打补丁会给每个被改的文件留一份 `<文件>.phc-orig`，`--revert` 用它还原；
- 新建文件记在 `.phc-created.json`，还原时**只删自己建的**（手改过的会保留）；
- 写盘后会做一次**语法自检**（`node --check`），失败就自动从备份回滚。

> ⚠️ 受限环境（例如 DSH 的 Windows 沙箱）里子进程可能起不来：那时脚本会**如实跳过**自检并警告，而不是把它当成语法错误。
>
> ⚠️ 同一个文件可以被**多个**补丁项改（客户端 bundle 就是），补丁器按**路径分组**、在同一份内存文本上依次应用 —— 逐项各自读盘再写盘会让后一项整体覆盖前一项。

## 补了什么（代码层面）

| 文件 | 改动 |
|---|---|
| `lib/codebuddy-guard.js` | **新建**：fetch 层守卫（四段指纹改写 / host 过滤 / 幂等 / fail-open / dryRun / JSONL 日志 / 单例安装） |
| `lib/index.js` | `apply()` **最前面**装 `installCodeBuddyGuard(ctx)`；另装上 `installRateLimitResume(ctx, pool)` |
| `lib/buddy-adapter.js` | 构造改走 `guardCodeBuddyFetch(options.fetchImpl ?? fetch)`（兜住加载顺序） |
| `lib/rate-limit-resume.js` | **新建**：限流判据、解禁时刻推算、待续跑钩子（含落盘与恢复）、`agent.followup` 投递 |
| `lib/jet-hub-rpc.js` | 三条端点 `resume.getState` / `resume.setArmed` / `resume.setEnabled` |
| `lib/client/jet-hub.js` | 报错行尾图标按钮（DOM 增强）+ 设置页顶部默认开关 |
| `lib/raccoon-credits.js` | 新增 `claimRaccoonDailyCheckin` / `triggerRaccoonDailyGrant` / `fetchRaccoonTodayGrants`；登录奖励两端合并；状态改走 v2 income 账单 |
| `lib/raccoon.js` | 办公端 / 移动端前缀与客户端身份常量 |
| `lib/raccoon-auth.js` | `claimDailyCheckin()` 实例方法（走注入的 `fetchImpl`） |
| `lib/provider-credits.js` | Raccoon 的 `claim` 实现（替换原来的 `claimUnavailableReason`） |
| `lib/provider-registry.js` | 能力表登记 `dailyCheckin: true`，面板才会渲染签到按钮 |

## 常见问题

**守卫会不会影响我别的渠道（Raccoon / DeepSeek 官方 / 国际版）？**
不会。只有 host 命中 `copilot.tencent.com` 的请求才会被看；别家请求原样透传同一个对象引用，
连序列化都不重做。

**会不会改坏我的对话？**
只动 system / developer / assistant，且只动那四处指纹。user 消息、工具输出、代码里的
`@` 与邮箱都不碰。改动都是语义等价的措辞变化。

**守卫会不会和 dsh-wb400-guard 打架？**
不会。两个都是「只对 `copilot.tencent.com`、只改那四段指纹」的同一套改写，各自幂等：
先装的那层改完，后装的那层扫一遍发现无指纹可改就原样放过（`stats.passedThrough` +1）。
本补丁的价值在于**不依赖它**：没装 wb400-guard 时 CodeBuddy 同样是通的；装了则是双保险。

**升级 providers-hub 之后守卫就没了？**
对 —— 补丁改的是 `node_modules`，升级会整个换掉。重跑一次 `node patch.mjs` 再重启即可。

**守卫上写着「UI 里没有开关」？**
它按环境变量开关（见上面那张表），刻意不占 Jet Hub 设置页的版面：默认就该是开的。

**勾了「解禁后自动继续」，按钮过一会儿自己消失了？**
那是正常的：宿主在解禁时刻投递成功后就把记录清掉了（点下去已经没有意义，留着只会误导）。另外你自己发了一条消息、或宿主开了新回合，也会撤掉它。

**设置页开关关了，报错行按钮还是显示「解禁后自动继续」？**
那个开关决定的是**新中断的初值**，不追溯已有记录 —— 这是有意的（否则你刚逐个点过的按钮会被悄悄改回去）。在报错行上点一下即可改这一个。

**签到报「每日积分触发失败」？**
多半是凭据过期。插件自己的续期会处理；持续失败就在面板里重新登录该账号。

**签到显示「今日已到账」，但余额没感觉涨？**
每日积分是**当日额度**，会先被消耗。另外账单有同步延迟，触发后立刻拉账单看不到当天那笔是正常的 —— 本补丁用**余额前后差**判定就是为了绕开这个延迟。

**会不会多领/重复领？**
不会。触发端点是按天幂等的；登录奖励每个账号每端只能领一次（服务端返回 `granted:false`）。

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
