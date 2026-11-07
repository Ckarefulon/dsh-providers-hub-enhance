# 更新记录

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
