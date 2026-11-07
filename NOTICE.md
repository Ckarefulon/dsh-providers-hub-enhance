# 第三方来源与许可

本项目自身以 MIT 发布（见 [LICENSE](LICENSE)）。它包含或派生自以下第三方作品。

## 1. dsh-providers-hub（被补丁的目标，MIT）

- 仓库/包：`dsh-providers-hub`（npm）
- 用途：`assets/raccoon.js` 与 `assets/raccoon-credits.js` 是该项目构建产物
  （`lib/raccoon.js`、`lib/raccoon-credits.js`）的**修改版本**，由 `patch.mjs` 以整文件替换的方式安装到本机
  `node_modules/dsh-providers-hub/lib/` 下；`patch-data.json` 里针对其余文件的锚点替换同样只作用于该包。
- `assets/rate-limit-resume.js`（新建的宿主模块）、`assets/client-rate-limit-resume.js` 与
  `assets/client-styles.js`（插进客户端 bundle 的代码块与 CSS）是**本项目原创**，不是该项目的派生代码；
  它们被安装进同一个包目录，故在此一并说明。
- 侧边手法（`agent.followup` 投递、「自有 source kind 不冒充 user」、`ctx.inject(['agents'])` 的挂载）参照了
  该包自带的 `lib/loop-recovery.js`，属于同一 MIT 许可下的参考实现。
- 许可：MIT，原文如下。

```
MIT License

Copyright (c) 2026 Jet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. L0NE-6/Raccoon-Daily（端点线索，MIT）

- 仓库：<https://github.com/L0NE-6/Raccoon-Daily>
- 用途：**仅作事实来源**。本项目的端点发现（办公端 `setting_info` 触发每日积分、移动端登录奖励）
  由该项目的脚本线索与作者后续的实测确认，本项目**未复制其代码**。

## 3. 商汤小浣熊（Raccoon / xiaohuanxiong.com）

- 本项目不是商汤科技的官方项目，也不包含其任何代码或资源。
- 文中出现的接口路径、积分规则描述来自公开的官方文档与对公开客户端行为的观察，仅用于互操作用途。
- 相关商标归其权利人所有。

## 4. DeepSeek Harness

- 本项目是运行在 DeepSeek Harness 上的第三方本地补丁，与其开发方无隶属关系。

## 5. dsh-auto-continue（思路参照，MIT）

- 仓库：<https://github.com/HsiangNianian/dsh-auto-continue>
- 用途：**仅作设计参照**（「听 `session/event` → 判失败类别 → 到点经 `agent.followup` 投递」这一套手法）。
  本项目**未复制其代码**：判据、解禁时刻的三条来源、钩子落盘与恢复、UI 形态都是本仓库独立实现，
  且面向的是「限流解禁」而不是「任意可恢复错误」。
