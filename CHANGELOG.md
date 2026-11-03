# 更新记录

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
