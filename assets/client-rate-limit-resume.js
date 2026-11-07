// plugin-src/client/rate-limit-resume.js
//
// 这是本补丁新增的一整块（上游没有它），由 patch.mjs 插进
// `lib/client/jet-hub.js` 的 `apply()` 之前。它是 lazy-CJS bundle 的一段，
// 只能用外部作用域里已有的东西（`React2` / `require('react')` 已经消费完毕），
// 不要在这里再 import 任何模块。
//
// ── 它做两件事 ──────────────────────────────────────────────────────────────
//
// 1. **限流中断行尾的图标按钮**（两态互切：黄色延时 = 解禁后自动继续 /
//    红色叉 = 不自动继续）。宿主 `@deepseek-ai/dsh-client-ui-chat` 把终态失败渲染成
//    `.LOmM4q_turnErrorRow`，类名哈希每次构建都变，故按后缀 `_turnErrorRow` 找。
//    这一行**没有**任何插槽可挂 —— 但也正因为它是 DOM，一个 MutationObserver 就够，
//    比替换整个 `conversation.chat.node` 的 `turn-error` 渲染器便宜得多，也不会跟
//    宿主的文案/配色/无障碍语义打架。
//
// 2. **Jet Hub 设置页顶部的总开关**（React 元素，因为它长在 React 树里）。
//
// ── ⚠️⚠️ 行尾按钮必须用**原生 DOM**，不能用 React 元素 ──────────────────────
//
// 第一版把 `React2.createElement(...)` 直接交给 `replaceChildren`，那是错的：
// 那个位置是**宿主自己的 DOM**（不在任何 React 树里），React 元素塞进原生 DOM
// 只会渲染成 `[object Object]`。这条链路没有 `react-dom`（客户端 bundle 只能
// `require('react')`），所以这里老老实实 `document.createElement` ——
// 与 dsh-gitbar-lite 等插件的 DOM 增强同一手法。
//
// ── 状态全部在宿主侧 ────────────────────────────────────────────────────────
//
// 三条 RPC（`resume.getState` / `resume.setArmed` / `resume.setEnabled`）由
// `lib/rate-limit-resume.js` 提供。本地**不留任何状态机**：按钮显示什么完全由宿主
// 回答「这个会话还有没有待续跑的限流中断、它 armed 没有」。关掉标签页再回来按钮
// 还是对的 —— 这也正是它必须放宿主侧的理由（限流解禁要等一小时，必然跨标签页
// 与宿主重启）。
//
// ── 图标规范 ────────────────────────────────────────────────────────────────
//
// 照 `@deepseek-ai/dsh-client-ui-primitives` 的规范自己画：16px 盒子、
// `viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"` 写在**每条 path** 上、
// `stroke-width` 写在 `<svg>` 上而不是 path 上。**不用 emoji / 文本字符** ——
// emoji 是平台字体的彩色字形，不跟随 `currentColor` 和主题，和宿主那批 1px 描边
// 图标放一起一眼就是两回事。
//
// 颜色只用宿主 token：`var(--dsw-alias-state-warn-primary)`（黄）与
// `var(--dsw-alias-state-error-primary)`（红），不写死色值，跟随主题。

/** 报错行上「本行已增强过」的标记（幂等判据）。 */
var PHC_RESUME_ROW_ATTR = "data-phc-rate-limit-resume";
/** 行尾插入的按钮格子。 */
var PHC_RESUME_SLOT_ATTR = "data-phc-resume-slot";
var PHC_RESUME_SLOT_CLASS = "dim-jh-resumeSlot";

/** 黄色延时（就绪）图标：闹钟 + 一条「到点自己走」的箭头。 */
var PHC_ICON_DEFER = ["M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z", "M8 5.9v2.5l1.7 1", "M12.4 3.1h2.1v2.1", "M14.4 3.2 11.9 5.4"];
/** 红色叉：两条对角笔画（与宿主 `IconCloseOutline` 同形的 45 度交叉）。 */
var PHC_ICON_CANCEL = ["M4.4 4.4 11.6 11.6", "M11.6 4.4 4.4 11.6"];
/** SVG 命名空间：`createElement` 造不出 SVG（会得到形状无效的 HTML 元素）。 */
var PHC_SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 造一个 16px、1px 描边的图标（原生 SVG 节点）。
 *
 * @param {string[]} strokes - 每条描边的 path `d`。
 * @param {string} className - 额外类名。
 * @returns {Element}
 */
function phcIcon(strokes, className) {
  var svg = document.createElementNS(PHC_SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  // ⚠️ `stroke-width` 写在 `<svg>` 上而不是每条 path 上（宿主规范，见模块头）。
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (var d of strokes) {
    var path = document.createElementNS(PHC_SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  return svg;
}

/**
 * 画/更新一行的切换按钮（幂等：同一行重复调用只重建内容，不叠格子）。
 *
 * @param {Element} row - 宿主的 `.…_turnErrorRow`。
 * @param {{armed: boolean, busy: boolean}} state - 当前显示状态。
 * @param {Function} onToggle - 收到**目标** armed（不是被点击的当前态）。
 */
function phcRenderToggle(row, state, onToggle) {
  var armed = state.armed === true;
  var busy = state.busy === true;
  var holder = row.querySelector("[" + PHC_RESUME_SLOT_ATTR + "]");
  if (holder === null) {
    holder = document.createElement("span");
    holder.setAttribute(PHC_RESUME_SLOT_ATTR, "");
    holder.className = PHC_RESUME_SLOT_CLASS;
    // 插到**最后**：`.turnErrorRow` 是 `grid-template-columns: 10px minmax(0,1fr) auto`，
    // 前两格是状态点与文案、第三格是错误码。新格子落进 `auto` 轨道 ⇒ 紧跟错误码。
    row.appendChild(holder);
  }
  var button = document.createElement("button");
  button.type = "button";
  button.className = armed ? "dim-jh-resumeToggle" : "dim-jh-resumeToggle dim-jh-resumeToggleOff";
  button.setAttribute("data-armed", armed ? "1" : "0");
  // 语义：这是**开关**（两态互切），故 `aria-pressed` 而不是 `aria-checked`；
  // `title` 说清「点一下会变成什么」—— 图标按钮没有文字，提示必须自带下一步。
  button.setAttribute("aria-pressed", armed ? "true" : "false");
  button.setAttribute("aria-label", armed ? "解禁后自动继续" : "不自动继续");
  button.title = armed
    ? "解禁后自动继续：当前为开。限流解禁后会自动把这一轮续上。点击切换为「不自动继续」。"
    : "不自动继续：当前为关。限流解禁后不会自动续跑，需要你手动重发。点击切换为「解禁后自动继续」。";
  button.disabled = busy;
  button.appendChild(phcIcon(armed ? PHC_ICON_DEFER : PHC_ICON_CANCEL, "dim-jh-resumeIcon"));
  var text = document.createElement("span");
  text.className = "dim-jh-resumeText";
  text.textContent = armed ? "解禁后自动继续" : "不自动继续";
  button.appendChild(text);
  button.addEventListener("click", function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    onToggle(!armed);
  });
  holder.replaceChildren(button);
}

/**
 * 当前会话 id：宿主把 `data-conversation-session=session-…` 放在会话内容根上。
 *
 * ⚠️ 这是**唯一**稳定的会话身份通道：侧边栏行的 `data-row-key` 也带 id，但它属于
 * 另一棵树（用户可能正看着 A 会话而侧边栏选中 B）。只认内容根那一个。
 *
 * @returns {string | undefined}
 */
function phcCurrentSessionId() {
  var holder = document.querySelector("[data-conversation-session]");
  var value = holder ? holder.getAttribute("data-conversation-session") || "" : "";
  return value === "" ? undefined : value;
}

/**
 * 这一行是不是「限流类」的中断 —— 判据是它自己的文案/错误码节点。
 *
 * ⚠️ 两种判据都要认：`RATE_LIMIT` 这种错误码只出现在 `.turnErrorCode` 里，而
 * 部分渠道的限流只把话写进正文（providers-hub 十来个适配器各有各的形态）。
 *
 * @param {Element} row
 * @returns {boolean}
 */
function phcIsRateLimitRow(row) {
  var copy = row.querySelector('[class*="_turnErrorMessage"]');
  var code = row.querySelector('[class*="_turnErrorCode"]');
  var text = (copy ? copy.textContent : "") + " " + (code ? code.textContent : "");
  if (text.trim() === "") return false;
  return /429|RATE_LIMIT|rate.?limit|限流|频率|额度|积分不足|余额不足|quota|too many requests|耗尽/i.test(text);
}

/**
 * 装上「解禁后自动继续」的客户端半边。
 *
 * @param {object} options - `{ rpcCall }`：已裹好 `unwrapRpcResult` 的 RPC 出口。
 * @returns {{ dispose: Function, decorateSubtree: Function }} 卸载与「立刻扫一遍」。
 */
function installRateLimitResumeUi(options) {
  var rpcCall = options.rpcCall;
  /**
   * 每个会话的显示状态。
   *
   * ⚠️⚠️ 必须能区分**三种**情况，否则会踩到真机坑：
   * - **没有条目** = 还没问过宿主（读取进行中）；
   * - `NO_HOOK` = 问过了，宿主说「这个会话没有待续跑记录」⇒ 把按钮收掉；
   * - `{ armed, busy, resetAtMs }` = 有记录，按它渲染。
   *
   * 早期把后两种都写成 `undefined`，于是「先被 MutationObserver 挂上标记、读取
   * 尚未返回时又有人调 render」这一步会把**刚拿到的状态**当成「没有记录」，
   * 连带把 renderers 里的行删掉 ⇒ 按钮永远不出现。
   */
  var NO_HOOK = [];
  var states = new Map();
  var renderers = new Map();
  var disposed = false;
  var pollTimer;

  function scheduleRender(sessionId) {
    if (disposed) return;
    var row = renderers.get(sessionId);
    if (row === undefined || row === null) return;
    if (!row.isConnected) { renderers.delete(sessionId); return; }
    // 还没问过宿主：什么都别做（等 sync 的续体来调这一次）。
    if (!states.has(sessionId)) return;
    var state = states.get(sessionId);
    if (state === NO_HOOK) {
      // 宿主明确说「没有待续跑记录」：把按钮收掉（留着它点了也不会有事发生）。
      row.removeAttribute(PHC_RESUME_ROW_ATTR);
      var slot = row.querySelector("[" + PHC_RESUME_SLOT_ATTR + "]");
      if (slot) slot.remove();
      renderers.delete(sessionId);
      states.delete(sessionId);
      return;
    }
    phcRenderToggle(row, state, function (next) {
      void toggle(sessionId, next);
    });
  }

  /**
   * 问宿主这个会话的待续跑状态。
   * @returns 有记录时 `{ armed, busy, resetAtMs }`；宿主说没有时 `NO_HOOK`；
   *   **读取失败**时 `undefined` —— 那与「没有记录」是两件事，不该收掉按钮。
   */
  async function readState(sessionId) {
    if (sessionId === undefined) return undefined;
    try {
      var res = await rpcCall("resume.getState", { sessionId: sessionId });
      var hooks = res && Array.isArray(res.hooks) ? res.hooks : [];
      var hook = hooks.find(function (candidate) {
        return candidate && candidate.sessionId === sessionId;
      });
      if (hook === undefined) return NO_HOOK;
      return { armed: hook.armed !== false, busy: false, resetAtMs: hook.resetAtMs };
    }
    catch (caught) {
      // 读取失败**不要**把按钮收掉：那会让「宿主一时抖了」变成「功能消失」。
      console.warn("[jet-hub] 读取限流续跑状态失败:", caught);
      return undefined;
    }
  }

  async function sync(sessionId, row) {
    if (sessionId === undefined) return;
    if (!row.isConnected) return;
    renderers.set(sessionId, row);
    var next = await readState(sessionId);
    if (disposed) return;
    // ⚠️ 读取失败（`undefined`）时**保持原状**：可能按钮已经画好了，收掉它等于
    // 「宿主抖了一下就看不到功能了」。
    if (next !== undefined) states.set(sessionId, next);
    scheduleRender(sessionId);
  }

  async function toggle(sessionId, next) {
    var current = states.get(sessionId);
    if (current !== undefined && current !== NO_HOOK) {
      // 乐观切换：一次 RPC 往返在弱网下能到几百毫秒，按钮不动会像卡住了。
      states.set(sessionId, { armed: next, busy: true, resetAtMs: current.resetAtMs });
      scheduleRender(sessionId);
    }
    try {
      var res = await rpcCall("resume.setArmed", { sessionId: sessionId, armed: next });
      if (disposed) return;
      var hook = res && res.hook;
      if (hook === undefined || hook === null) {
        // 宿主说这个会话已经没有待续跑记录了（例如用户在别处重发了消息）。
        states.set(sessionId, NO_HOOK);
      }
      else {
        states.set(sessionId, { armed: hook.armed !== false, busy: false, resetAtMs: hook.resetAtMs });
      }
    }
    catch (caught) {
      console.warn("[jet-hub] 切换限流续跑失败:", caught);
      // 回滚到点击前的状态：不能让界面显示一个宿主没接受的值。
      var before = states.get(sessionId);
      if (before !== undefined && before !== NO_HOOK) {
        states.set(sessionId, { armed: !next, busy: false, resetAtMs: before.resetAtMs });
      }
    }
    scheduleRender(sessionId);
  }

  /** 单行增强（幂等）。 */
  function decorateRow(row) {
    var sessionId = phcCurrentSessionId();
    if (sessionId === undefined) return;
    if (row.getAttribute(PHC_RESUME_ROW_ATTR) === "1") {
      // 已经增强过：只按最新状态刷一遍（文案/图标可能变了）。
      if (renderers.get(sessionId) === row) scheduleRender(sessionId);
      return;
    }
    if (!phcIsRateLimitRow(row)) return;
    row.setAttribute(PHC_RESUME_ROW_ATTR, "1");
    void sync(sessionId, row);
  }

  function decorateSubtree(node) {
    if (!(node instanceof Element)) return;
    if (node.matches('[class*="_turnErrorRow"]')) decorateRow(node);
    for (var row of node.querySelectorAll('[class*="_turnErrorRow"]')) decorateRow(row);
  }

  var observer;
  if (typeof MutationObserver === "function" && typeof document !== "undefined") {
    observer = new MutationObserver(function (records) {
      for (var record of records) {
        if (record.type !== "childList") continue;
        for (var node of record.addedNodes) decorateSubtree(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // 首屏可能已经有报错行：立刻扫一遍（MutationObserver 只报**之后**的变化）。
    decorateSubtree(document.body);
    // 兜底轮询：解禁时刻过了以后按钮文案不变，但「宿主已经自动续跑、该把按钮
    // 收掉」这件事只有宿主知道。30 秒一次，且只在页面上确实有增强过的行时才发请求。
    pollTimer = setInterval(function () {
      if (disposed || renderers.size === 0) return;
      for (var sessionId of Array.from(renderers.keys())) {
        var row = renderers.get(sessionId);
        if (row === undefined || !row.isConnected) { renderers.delete(sessionId); continue; }
        void sync(sessionId, row);
      }
    }, 30000);
  }

  return {
    /** 卸载：断开观察、停轮询、把已插入的按钮全部摘掉（幂等）。 */
    dispose: function dispose() {
      if (disposed) return;
      disposed = true;
      if (observer !== undefined) observer.disconnect();
      if (pollTimer !== undefined) clearInterval(pollTimer);
      for (var slot of document.querySelectorAll("[" + PHC_RESUME_SLOT_ATTR + "]")) slot.remove();
      renderers.clear();
      states.clear();
    },
    /** 供诊断/单测：立刻扫一遍给定子树。 */
    decorateSubtree: decorateSubtree
  };
}

/**
 * Jet Hub 设置页顶部的「解禁后自动继续」总开关（React 元素 —— 它长在 React 树里）。
 *
 * ⚠️ 它是**默认值**开关，不是全局暂停：语义正是「设置默认是否自动继续」。
 * 已有待续跑记录保持各自的 armed（用户可能逐个关过），改这里不追溯 ——
 * 追溯会让「我刚才点的那个按钮」被悄悄改回去。
 *
 * @param {object} props - `{ rpcCall }`。
 * @returns {object} React 元素。
 */
function PhcResumeDefaultSwitch(props) {
  var rpcCall = props.rpcCall;
  var enabledHook = React2.useState(true);
  var enabled = enabledHook[0];
  var setEnabled = enabledHook[1];
  var busyHook = React2.useState(false);
  var busy = busyHook[0];
  var setBusy = busyHook[1];
  var failedHook = React2.useState(false);
  var failed = failedHook[0];
  var setFailed = failedHook[1];
  var mountedHook = React2.useRef({ current: true });

  React2.useEffect(function () {
    var mounted = mountedHook.current;
    mounted.current = true;
    return function () { mounted.current = false; };
  }, []);

  var load = React2.useCallback(async function () {
    try {
      var res = await rpcCall("resume.getState", {});
      if (!mountedHook.current.current) return;
      setEnabled(res ? res.enabled !== false : true);
      setFailed(false);
    }
    catch (caught) {
      console.warn("[jet-hub] 读取「解禁后自动继续」默认值失败:", caught);
      if (!mountedHook.current.current) return;
      // 读取失败时**不**禁用开关：那是唯一一条自救路径（与页面其它开关同取向）。
      setFailed(true);
    }
  }, [rpcCall]);
  React2.useEffect(function () {
    void load();
  }, [load]);

  var commit = React2.useCallback(async function (next) {
    setBusy(true);
    try {
      var res = await rpcCall("resume.setEnabled", { enabled: next });
      if (!mountedHook.current.current) return;
      setEnabled(res ? res.enabled !== false : next);
      setFailed(false);
    }
    catch (caught) {
      console.warn("[jet-hub] 保存「解禁后自动继续」默认值失败:", caught);
      if (!mountedHook.current.current) return;
      await load();
    }
    finally {
      if (mountedHook.current.current) setBusy(false);
    }
  }, [rpcCall, load]);

  return React2.createElement(
    "label",
    {
      className: "dim-jh-nativeSearch",
      title: failed
        ? "⚠️ 开关状态读取失败，当前显示的是默认值（开启）。点击即可重新提交一次。"
        : "解禁后自动继续：会话因限流（429 / 额度耗尽）中断时，等到解禁时刻自动把这一轮续上。"
          + "这里改的是**默认值** —— 只影响新的中断；报错行尾那个按钮可以逐个覆盖，已挂着的待续跑记录不会被追溯修改。"
    },
    React2.createElement("input", {
      type: "checkbox",
      className: "dim-jh-switch",
      checked: enabled,
      disabled: busy,
      onChange: function onChange(event) { void commit(event.target.checked); }
    }),
    React2.createElement("span", null, "解禁后自动继续")
  );
}
