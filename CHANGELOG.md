# 更新记录

## 2.0.1 — 2026-11-14

**修「解禁后自动继续」在真机上从不投递**（报障：「按钮有了，但时间到了也没有自动继续」）。

### 缺陷

`installRateLimitResume` 的 `ctx.inject(['agents'], …)` 回调里写的是：

```js
engine.setDeliver(() => {});   // 本意：agents 到位了，重排一下定时器
```

而 `setDeliver(fn)` 除了重排，**还会替换投递函数**。于是构造时注入的那个真正经
`agents` 作用域解析 `agent.followup()` 的闭包，被换成了返回 `undefined` 的空函数。
链路表现：

```
钩子建了 ✅  定时器排了 ✅  RPC/按钮/持久化都正常 ✅
  ⇒ 到点 attempt() 调 deliver(hook)
  ⇒ 空函数返回 undefined ⇒ result.ok !== true
  ⇒ 判「投递失败」⇒ 按 5 分钟重试 ⇒ 24 次后丢弃
```

真机上「等一小时」只会被观察一次，用户看到的就是「什么都没发生」。等待 24 次重试
（2 小时）也没用，因为投递通道已经被永久换掉了。

### 修法

1. 那个入口**只做重排这一件事**，并改名 `rearm()`：一个「只为重排定时器」而存在的
   入口如果同时还能替换核心回调，调用方就一定会顺手把回调填错。
2. `deliver` 改为 `const`，只由构造参数决定，**永不替换**（`dispose()` 也不再清它）。
3. `installRateLimitResume` 改为 `engine.rearm();`。

### 测试

新增 2 条真机回归用例，按 install 的**实际调用顺序**回放（构造时注入真投递 ⇒ 中途走
一次「agents 就绪」入口 ⇒ 到点必须真投出去），并断言「可替换投递函数的入口彻底消失」。
原有用例全都抓不到这个缺陷——它们直接给 `deliver` 传假函数，从不经过真正的注入路径。
反向验证：把资产还原成缺陷版，这 2 条必然变红（实测 21 pass / 2 fail）。

## 2.0.0 — 2026-11-12

**对齐 `dsh-providers-hub@2.22.261111`，并删掉两项已被上游实现的能力。**

### 1. 修一个把整个插件打崩的缺陷（重要）

1.3.0 在 `lib/index.js` 里插入了 `installExpiryFirst(ctx, pool);`，**却漏了配套的
`import { installExpiryFirst } from './expiry-first.js';`** —— 那条 import 在用脚本
重写 `patch-data.json` 时被悄悄丢了。后果不是「功能不生效」，而是：

```
apply() 抛 ReferenceError: installExpiryFirst is not defined
  ⇒ 同一函数里后面的 registerJetHubRpc(...) 从未执行
  ⇒ /api/jet-hub 整条通道 404（面板全线 transport failure）
```

三道既有防线全都拦不住：**语法自检只编译、不解析标识符**（`f()` 里 `f` 未定义是
运行时错误）；锚点守卫的锚点全都正常命中；单元测试测的是资产模块本身，不是
「被 import 进宿主之后」的接线。

新增第 4 道防线 **`scripts/wiring-check.mjs`**：补丁插入的每个「本补丁自有函数调用」
都必须在同一个最终文件里能 **import 到或就地定义**，否则写盘后**直接回滚**。
它已接进 `patch.mjs` 的写盘自检与 CI，并有 6 条用例锁住（其中一条直接复刻事故形态）。
判据刻意做得极窄（只查自有名字，不猜上游代码）：宁可漏报，也不要用误报把好补丁挡下。

顺带修掉同类隐患：`import` 的名字若写错、或调用了未导出的名字，也会被这条挡住。

### 2. 删掉两项（上游 2.22 自己实现了）

| 删掉的 | 依据 |
|---|---|
| **CodeBuddy 出站守卫**（fetch 层改写四段指纹） | 上游 `lib/openai-gateway/tencent-fingerprint.js` 已覆盖**同样四段**指纹（连 2026-10-28 那次真实报障都写进了注释）；且 `buddy-growth` / `buddy-compensation` **不做任何裸 HTTP** ⇒ 不存在绕过路径。再包一层 `globalThis.fetch` 只是徒增风险 |
| **账号「临期置顶」开关**（1.3.0 刚做的那个） | 上游已**按积分到期档位排序**（`ORDER_HINT_SUBTLE` 明说「某号没有临期积分时会被排到后面」），且**默认开启**，并配了 `strictManualOrder` 开关（RPC `strictManualOrder.getEnabled` / `setEnabled`，池内持久化）来做反选。语义重复，两套一起动会互相打架 |

对应资产/测试/脚本一并删除：`assets/codebuddy-guard.js`、`assets/expiry-first.js`、
`assets/client-expiry-first-switch.js`、`tests/codebuddy-guard.test.mjs`、
`tests/expiry-first.test.mjs`、`scripts/verify-guard.mjs`（`npm run verify` 随之取消）。

> 这两项都是**因为上游变好而退役**，不是因为不好用。仍需要它们的话用 1.x。

### 3. 保留的两项在新版上重新接线

- **Raccoon 每日签到**：上游 `provider-credits.js` 仍写着
  「Raccoon Work 不支持每日签到」⇒ 仍然需要。`lib/raccoon-credits.js` 在新版里
  与已知原版**逐字节相同**，整文件替换继续有效。
- **限流中断后「解禁后自动继续」**：上游只有 `loop-recovery`（思考打转），
  **没有**限流续跑 ⇒ 仍然需要。新版页头改成了「左侧导轨 + 设置弹窗」，
  原来挂在页头那排 `.dim-jh-headerActions` 的默认开关已**搬进设置弹窗**的
  「中断后自动继续」分区（锚点：`// ② 定时签到` 之后），用的是上游自己的
  `.dim-jh-settingsSection*` 样式。

兼容性：`2.22.261111` 全部 12 条补丁项一次打上，`--check` 报「全部文件已就位」。
`1.6.261016` 仍可用（只是会少掉上面删掉的两项）。

## 1.3.0 — 2026-11-12

**新增第四项能力：「临期置顶」开关**（账号面板标题下那排操作的最前面）。

它是一个**开关，不是按钮**：打开后一直有效 —— 每次面板读到积分余额，就自动把手里
**最快会作废**的积分账号按到期先后排到列表上方；关掉就完全不碰顺序。

为什么做成开关：一次性按钮的语义是「我此刻想要这个顺序」，而这件事**会反复失效**
（每天都有新积分包进入临期窗口、有账号的包作废掉），用户得每天记得再点一次。
开关是「我要一直这样」。状态住在宿主（`$DSH_HOME/jet-hub/expiry-first.json`），
面板关掉再打开、宿主重启之后都还是那个值。

判据是 `CreditBalance.packages[].deductionEndTime`（积分包到期），**不是**卡片上那行「有效期」：

- 凭据有效期（`ProviderAccountEntry.expiresAt`）多数渠道能静默续期，过期通常不丢东西；
- 积分包一过 `deductionEndTime`，包里剩多少就归零 ⇒ 那才是真会白丢的额度。

写盘走既有的 `account.reorder`（与拖拽写的是同一份）—— 顺序**就是**自动选号的优先级，
所以这不是视图排序。**没有新增任何网络请求**：触发时机就是面板本来就有的那次余额查询。

四个判据细节（实现见新增的 `assets/expiry-first.js`，15 条用例锁住）：

| 情况 | 处理 | 为什么 |
|---|---|---|
| `active !== true` | 跳过 | 已失效的包不再计费 |
| `remaining <= 0` | 跳过 | 否则「积分早就用完的号」永远排第一 |
| 没有 `deductionEndTime` | 视作永久，不参与排序 | 没给到期时间 ≠ 马上过期 |
| `deductionEndTime <= now` | 跳过 | 那批额度已经作废，顶上去只会挤掉还有额度的号 |

外加：只有字符串 `expiredTime` 的渠道（officeace 那种形状）用 `Date.parse` 兜底；
没有临期积分的账号留在末尾且保持拖拽顺序（稳定排序）；**平手回落到原下标**。

三条「不写盘」红线（真机上最容易混成「开关没反应」）：

1. 一个临期都算不出来（余额还没查 / 查询失败 / 渠道没有到期概念）⇒ **一个字都不写盘**。
   `balance: null` 与「没有临期」在数据里同形，照排等于按 `undefined` 重排，
   用户拖好的顺序会被一次查询失败打乱；
2. 算出来了但已经是最优顺序 ⇒ 不发 reorder；
3. reorder 抛错 ⇒ 只记一条 warn，不上抛 —— 余额已经查回来了，让排序失败把整份余额
   一并报废是拿功能换装饰。

⚠️ **默认关**：它会改写用户自己拖出来的顺序，未经同意不该自动动。

⚠️ **标签不叫「按临期排序」**：上游的聚合面板里已经有一个同名按钮（`aggregate` 页，
逐个渠道探测余额后重排**该模型内**的候选渠道）—— 同名会让用户以为两者是同一件事。
本开关叫「临期置顶」，且只在账号面板出现。

⚠️ **写入侧必须用 `pool.listAccountsByProvider`（存储序）**，不能用 `listAccounts`：
后者会稳定地把限流中的账号沉到最后（那是**视图**排序，刻意不动存储顺序）。拿它的
返回顺序去算新顺序再写回，等于把「限流沉底」这个纯展示决定**固化进存储顺序** ——
限流一解除，那个号就真的留在末尾了。

接线（`lib/jet-hub-rpc.js` 共 3 处 + `lib/index.js` 1 处 + 客户端 2 处）：
两条端点 `expiry.getState` / `expiry.setEnabled`；`credits.balances` 的**返回处**
（`handleMethod` 返回之前，与既有的 `credits.claimAll` 清缓存同一个位置）一处覆盖所有
provider —— 那个 case 里有四个 `return`，逐分支加必然漏（其中两条的返回语句一字不差）。

顺带：`scripts/ci-syntax-check.mjs` 与 `tests/syntax-check.test.mjs` 的真产物清单都加上了
两个新资产（记忆里的老坑：新增资产不进清单，那条防线就永远看不到它），
新增 `tests/expiry-first.test.mjs`（15 条）。

## 1.2.1 — 2026-11-09

**修三个「退化判据」（Node 18 上 `--experimental-vm-modules` 缺席时走的进程内语法检查）
误报合法代码的缺陷**。1.2.0 的 CI 在 Node 18 上就是这么红的：

```
scripts/verify-guard.mjs 语法错误: await is only valid in async functions and the top level bodies of modules（退化判据）
```

1. **顶层 await 被误报**。ESM 允许 `const fs = await import('node:fs')`，而脚本的函数体
   不允许 —— 退化判据当时是直接 `compileFunction(残余体)`，于是把合法代码判成语法错误。
   现在把残余体包进 `async () => { … }` 再编译：**只**放行「顶层 await」这一条 ESM 差异，
   非 async 函数里的 await、其余语法错误照旧被抓到。
2. **shebang 被误报**。`#!` 只在源文本**第 0 位**合法；包进 async 箭头函数后它落到函数体
   中间 ⇒ `Invalid or unexpected token`（`patch.mjs`、`scripts/verify-guard.mjs` 都带 shebang）。
   现在 `stripEsmSyntax` 先等长挖掉开头的 shebang；非开头的 `#!` 仍然报错。
3. **等长替换把自己的括号截掉了**（老缺陷，被第 1 条的新用例顺手抓到）。
   `withScriptSafeSubstitutions` 把 `import(` 换成 `'__import('.padEnd(7).slice(0,7)`
   —— `'__import('` 本身比 7 长，`padEnd` 不截短，`slice` 于是砍掉了左括号，留下 `__impor`，
   编译报 `Unexpected string`。现在用一个只做「截断 + 补 `_`」的等长标识符助手，
   括号**一定**保留。

新增 3 条用例（顶层 await / shebang / 真实资产在退化判据下也通过），并把
`assets/codebuddy-guard.js`、`scripts/verify-guard.mjs` 纳入语法检查与真实产物用例 ——
否则这两个新文件在 CI 上永远不会被这条防线看到。

## 1.2.0 — 2026-11-07

**新增第三项能力：CodeBuddy（腾讯 `copilot.tencent.com`）出站守卫**。机制整条移植自
[dsh-wb400-guard](https://github.com/curo22/dsh-wb400-guard) 的 fetch 层守卫，但**只对
CodeBuddy 一个提供方生效**（别家渠道的请求连对象引用都原样透传）。

要解决的现象：走 buddy 时每轮第一步就挂，报文是

```
本轮运行失败 400: ... code 11128 / "Illegal API invocation from an unapproved channel"
```

网关在服务端对 system / assistant 消息做通道校验，而 DSH 自己的提示词里**默认带着四段**
指纹（文件引用段里的 `@`、内核身份句、`personaPrefix` 的 coding agent 句、Web GUI 两段）。
四段互不相关，改一段救不了另外三段 —— 实测 2026-11-07 的本机提示词**四段全在**。

为什么不用上游已有的那层改写：`lib/openai-gateway/tencent-fingerprint.js` 是**按调用点**
接入的（`serializeMessages` 与 `options.system`），它管的是 ZCode / Claude Code 的客户端
模板句，与我们这四段不重叠；而且每新增一条出站路径就要再补一次（上游自己在文档里把这
条教训写成了「第三个未改写入口」）。故这里落在 **fetch 层**：

- 精准（按 host 过滤）、不漏（不管从哪个函数发出去）、盖得住 `stream()` 内部的换号重试阶梯；
- 只改 `system` / `developer` / `assistant` 的 content，`user` 与 `tool` 一个字不动；
- **幂等**（`rewrite(rewrite(x)) === rewrite(x)`，未改动返回入参原引用）；
- **fail-open**（改写链路任何异常都退回原请求，绝不阻断对话、不引入重试）；
- 改动后**剔除陈旧的 `Content-Length`**；
- 全局只装**一层**（`Symbol.for`），卸载挂 `ctx.effect`；
- 日志只记 origin + path（剥掉 query 里的 `prompt_cache_key` / token），落在
  `$DSH_HOME/jet-hub/codebuddy-guard.jsonl`。

接线两处（缺一不可）：

1. `lib/index.js` 的 `apply()` **最前面**装全局守卫 —— 本函数稍后会 `registerBuddyLlm()`，
   而 `BuddyAdapter` 在**构造那一刻**就把 `fetch` 存进了实例，晚一步装就盖不到它；
2. `lib/buddy-adapter.js` 的构造改走 `guardCodeBuddyFetch(options.fetchImpl ?? fetch)` ——
   兜住「插件加载顺序让守卫晚于构造」这种情形（同一份 fetch 只包一层，WeakMap 记忆化）。

开关（改环境变量即可，不用重打补丁）：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `DSH_CODEBUDDY_GUARD` | `off` | 完全不碰 fetch |
| | `dryrun` | 只观测：一个字节都不改，命中只记 `would-rewrite` |
| | `all` | 扫描角色里的 `@` 全换（内核改了措辞时的兜底） |
| `DSH_CODEBUDDY_GUARD_HOSTS` | 逗号分隔 | 追加 host，以 `.` 开头做后缀匹配（如 `.workbuddy.ai`） |
| `DSH_CODEBUDDY_GUARD_LOG` | 路径 | 覆盖日志位置 |

新增 `scripts/verify-guard.mjs`（`npm run verify`）：一条命令回答「守卫此刻在不在工作」——
查接线、import 真模块跑四段改写、在假 ctx 上装一次再卸掉。它**不发网络请求**。

测试：65 条（补丁器 9 / 宿主引擎 21 / 客户端 5 / 语法 6 / 新守卫 24），全绿。守卫用例里的
四段指纹是**逐字抄自本机活的 DSH system prompt**，不是从别人文档转抄的常量。

## 1.1.1 — 2026-11-07

**修三个真机上「功能等于没装」的缺陷**。报障原话：「除了设置里多了个按钮，报错后没有我说的
那个按钮，也没有自动继续。」—— 设置页的开关是纯 React 组件（数据是常量），所以它出现了；
而按钮与自动继续都依赖宿主侧**真的创建出钩子**，那条链路断在三处判据上：

1. **`QUOTA_EXCEEDED` 不被认为是限流**（`classifyRateLimitFailure`）。providers-hub 把
   「账号池里该模型的号全被限流」报成 `QUOTA_EXCEEDED`（`index.js` 的
   `throwIfAllAccountsRateLimited`，buddy / codearts / gemini / opencode / loomy 同型），
   而上游自己的 `account-probe.js` 也是这么认的。原判据只认 `RATE_LIMIT` / `QUOTA` /
   `ACCOUNT_QUOTA`，于是这条报错从结构化码这一路直接漏掉。
   **注意 `QUOTA_EXCEEDED` 不等于限流**：trae 的「积分不足」、accio 的「额度或认证失败」
   共用这个码，那是真·额度耗尽 —— 故它只作线索，最终由文案分流。
2. **文案兜底漏了中文原文**。原正则写的是同义词（`频率限制` / `请求过于频繁`），而真机报错
   写的是「可用账号均**在限流中**」「所有账号均**受限**」「将于 ⋯ **解禁**」。已按上游源码里
   **真实出现过的字符串**重写。
3. **解禁时刻取了 `max` 而不是 `min`**（`modelResetAt`）。上游 `allAccountsRateLimitedForModel`
   取 `Math.min` —— 只要有一个号解禁，请求就能落上去。取 max 会让用户白等（A 号 1 分钟解禁、
   B 号被额度封 24 小时 ⇒ 等一天）。同时补上「**全部**启用账号都受限才算」这一条，否则
   「A 已解禁、B 还在限」会被误判成要等到 B。

补丁器：

- **修 `create` 模式在「补丁自身升级」时误报冲突**：改了资产内容后 `sync-hashes` 换了哈希，
  再打补丁会被守卫按「已存在且哈希对不上」拒绝，要求手动 `--force`。但那个文件明明是
  **本补丁自己**建的 —— 归属证据就在 `.phc-created.json` 里，而守卫当时只查了内容哈希。
  现在清单登记过即允许原地更新（动作显示为「更新（本补丁先前创建的文件）」）。
- **修测试夹具不清理**：`mkdtempSync` 造在系统临时目录且从不删除，实测一度堆积上百个
  `phc-test-*` 目录。改用 `t.after()` 登记清理（断言失败也执行）。

测试：41 条（补丁器 9 / 宿主引擎 21 / 客户端 5 / 语法 6），全绿。**新增的都是真机回归用例**：
文案样本逐条抄自 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 与上游 `lib/*.js` 的 throw 站点；
并做过**反向验证** —— 把三处判据还原成修前的样子，这些用例必然变红（4 条失败），确认它们
真的抓得住 bug，而不是同义反复。

> 教训记在 `assets/rate-limit-resume.js` 与 `tests/rate-limit-resume.test.mjs` 的注释里：
> 凡「按文案判」的分支，用例必须用**上游源码里真实存在的**字符串。这次全部用例都用想象中
> 的样例（`QUOTA` / `积分不足`），于是 33 条全绿而功能在真机上完全不工作。

## 1.1.0 — 2026-11-07

**项目改名为 `dsh-providers-hub-enhance`**（原 `dsh-raccoon-checkin`）：现在它不只补签到，
所以从「Raccoon 专用」升格成「providers-hub 增强」。包名、bin、仓库地址一并更新，
旧名不再是入口。

新功能：

- 新增**限流中断后「解禁后自动继续」**（宿主侧 `lib/rate-limit-resume.js`）：
  - 监听 `session/event`，在 `turn/end` 且失败属限流/额度类时为该会话记一条待续跑钩子；
    解禁时刻取「`providerRetryAfterMs` / 账号池里该模型未来最晚的限流标记 / 兜底 1 小时」
    三者中最保守的一条。
  - 到点先复核池里是否仍未解禁（被推后就顺延，延后次数有上限），再经 `agent.followup`
    投递续跑消息；续跑消息带**自有来源标识** `rate-limit-resume`，绝不冒充 `user`。
  - 会话不再存活 / 用户手动发消息 / 宿主开新回合时撤掉钩子；投递失败按 5 分钟重试，
    只有 `no-live-agent` 才直接放弃。
  - 钩子落盘到 `$DSH_HOME/jet-hub/rate-limit-resume.json`，**跨宿主重启**接着等。
- 新增报错行尾的**两态图标按钮**（客户端）：黄色延时 = 「解禁后自动继续」、
  红色叉 = 「不自动继续」，点击互切；只在限流类报错行出现，状态全部由宿主回答。
- 新增 Jet Hub **设置页顶部的「解禁后自动继续」开关**：设置新中断的默认行为，初始默认开启；
  不追溯已有记录（那会把用户刚逐个点过的按钮悄悄改回去）。
- 新增三条 RPC 端点：`resume.getState` / `resume.setArmed` / `resume.setEnabled`。
  控制器是模块级单例 —— **没有**给 `registerJetHubRpc` 加形参（那边的注释明令禁止位置形参）。

补丁器 `patch.mjs`：

- 新增 **`create`** 模式（只新建补丁自带的模块文件；带 SHA256 守卫与
  `.phc-created.json` 清单，`--revert` 只删自己建的）与 **`anchor-asset`** 模式
  （把 assets 里的一整块代码插进锚点，带 `marker` 幂等判据）。
- **按路径分组**处理：同一个文件被多个补丁项改时，在同一份内存文本上依次应用
  （逐项读盘再写盘会让后一项整体覆盖前一项 —— 有专门用例锁住这一点）。
- 语法自检区分「语法真的错了」与「子进程起不来（受限环境 EPERM）」：
  后者**如实跳过并警告**，不再让受限终端里永远打不上补丁。
- 改成可 import 的 `runPatch()` + CLI 入口：测试可以在**进程内**跑真补丁器
  （DSH 的 Windows 沙箱禁 `spawn`，走子进程会让全部用例静默跳过）。

测试：三套（补丁器 8 条 / 宿主引擎 14 条 / 客户端真跑 5 条），全绿。客户端用例在
极简 React + 假 DOM 里跑**资产源码本体**；宿主引擎用例覆盖 429 空体、额度耗尽、
解禁时刻被推后顺延、`no-live-agent` 放弃、重试不丢钩子等分支。

## 1.0.0 — 2026-11-03

首个公开版本。

- 新增 Raccoon（商汤小浣熊）**每日签到**：`GET /api/web/office/v3/setting_info` 触发发放（按天幂等、自动补发漏发日），
  用**余额前后差**核对到账，账单兜底。
- 新增**手机端登录奖励** +3000（`POST /api/web/mobile/v1/login/points/grant` + `app-android` 身份），
  与桌面端那条互不共享额度。
- 修复登录奖励状态判断的漏分缺陷：改走 `/points/v2/bills?type=income`，
  不再被对话消耗记录挤出窗口导致「永远显示未领取」。
- 补丁器 `patch.mjs`：整文件 SHA256 守卫、锚点唯一性校验、`--check` / `--revert` /
  `--profile` / `--json`，写盘后 `node --check` 语法自检失败自动回滚。
- 能力表登记 `dailyCheckin`，宿主与客户端 bundle 同步，面板才会渲染签到按钮。
- 实测兼容 `dsh-providers-hub@1.6.261016` 与 `2.13.261102`。
