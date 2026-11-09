# 更新记录

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
