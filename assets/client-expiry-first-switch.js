// plugin-src/client/expiry-first-switch.js
//
// 「临期置顶」的客户端半边（本补丁新增）。由 patch.mjs 插进 `lib/client/jet-hub.js`
// 的 `JET_HUB_RPC_CHANNEL` 那一行之后，是 lazy-CJS bundle 的一段 ——
// 只能用外部作用域里已有的东西（`React2` 已经就位），不要在这里再 import 任何模块。
//
// ── 它是什么 ────────────────────────────────────────────────────────────────
//
// **一个开关**（不是按钮）：放在账号面板标题下面那排操作按钮的最前面。
// 打开后是**一直生效的行为** —— 每次面板读到余额（`credits.balances`）就把该 provider
// 的账号池顺序重排成「临期最近的在前」；关掉就什么都不做。
//
// ── ⚠️ 为什么是开关而不是「一键排序」按钮 ────────────────────────────────────
//
// 一次性按钮的语义是「我此刻想要这个顺序」，而这件事**会反复失效**：每天都有新的
// 积分包进入临期窗口、有账号的包作废掉。用户必须每天记得再点一次 —— 那不如让他
// 说一次「我要这样」然后一直这样。故状态住在宿主（`expiry-first.json`），
// 面板关掉再打开、宿主重启之后开关都还是那个值。
//
// ── 状态全部在宿主 ──────────────────────────────────────────────────────────
//
// 两条 RPC（`expiry.getState` / `expiry.setEnabled`）由 `lib/expiry-first.js` 提供。
// 本地不留状态：开关显示什么完全由宿主回答，且**宿主说不可用时把整个开关收掉**
// （插件装上了但引擎没起来时，摆一个永远不生效的开关比不摆更糟）。
//
// ── ⚠️ 失败时**不要**禁用开关 ─────────────────────────────────────────────
//
// 读取失败只是一次抖：禁用会把用户**唯一一条自救路径**（再点一次）堵掉 ——
// 与设置页其它开关（渠道原生搜索、本机网关）的既有取向一致。

/**
 * 「临期置顶」开关。
 *
 * @param {object} props - `{ rpcCall }`。
 * @returns {object|null} React 元素；宿主说不可用时返回 `null`（整块收掉）。
 */
function PhcExpiryFirstSwitch(props) {
  var rpcCall = props.rpcCall;
  var stateHook = React2.useState(null);
  // `null` = 还没问过宿主（别渲染成「关」—— 那会让用户看到一次错误的状态闪动）。
  var state = stateHook[0];
  var setState = stateHook[1];
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
      var res = await rpcCall("expiry.getState", {});
      if (!mountedHook.current.current) return;
      if (res && res.available === false) {
        // 引擎没起来：整块收掉，不留一个点了没反应的开关。
        setState(null);
        setFailed(false);
        return;
      }
      setState({ enabled: res ? res.enabled === true : false, available: true });
      setFailed(false);
    }
    catch (caught) {
      console.warn("[jet-hub] 读取「临期置顶」开关失败:", caught);
      if (!mountedHook.current.current) return;
      // 读取失败**不**禁用开关（见文件头）：显示默认（关）并标记 failed。
      setState({ enabled: false, available: true });
      setFailed(true);
    }
  }, [rpcCall]);
  React2.useEffect(function () {
    void load();
  }, [load]);

  var commit = React2.useCallback(async function (next) {
    setBusy(true);
    try {
      var res = await rpcCall("expiry.setEnabled", { enabled: next });
      if (!mountedHook.current.current) return;
      if (res && res.available === false) {
        setState(null);
        setFailed(false);
        return;
      }
      setState({ enabled: res ? res.enabled === true : next, available: true });
      setFailed(false);
      // ⚠️ 宿主在打开时会按缓存的余额**立刻**重排一遍，但它写的是账号池顺序，
      //    而面板自己那份 `accounts` 数组不会自己更新 —— 故让宿主先排完，再由
      //    面板重新读一次列表。这一步由外面的 `onChanged` 回调完成（可选）。
      if (typeof props.onChanged === "function") props.onChanged();
    }
    catch (caught) {
      console.warn("[jet-hub] 保存「临期置顶」开关失败:", caught);
      if (!mountedHook.current.current) return;
      // 回滚成读取到的真实状态（不能让界面显示一个宿主没接受的值）。
      await load();
    }
    finally {
      if (mountedHook.current.current) setBusy(false);
    }
  }, [rpcCall, load, props.onChanged]);

  if (state === null) return null;

  return React2.createElement(
    "label",
    {
      className: "dim-jh-nativeSearch",
      title: failed
        ? "⚠️ 开关状态读取失败，当前显示的是默认值（关闭）。点击即可重新提交一次。"
        : "临期置顶：打开后，每次读到积分余额就把「临期积分最近作废」的账号按到期先后排到列表上方。"
          + "\n判据是**积分包到期**（到期后剩余额度直接作废），不看上面那行「有效期」—— 那个多数渠道能自动续期，过期基本不丢东西。"
          + "\n没有临期积分的账号留在末尾，并保持你拖出来的相对顺序。⚠️ 这个顺序就是自动选号的优先级，会写盘，与拖拽写的是同一份。"
    },
    React2.createElement("input", {
      type: "checkbox",
      className: "dim-jh-switch",
      role: "switch",
      checked: state.enabled === true,
      disabled: busy,
      "aria-label": "临期置顶",
      onChange: function onChange(event) {
        // 立刻推算出目标值再提交：读 `event.target.checked` 在受控组件里
        // 会在同一轮渲染里被 React 复原，重放到异步续体里读就是旧值。
        void commit(event.target.checked === true);
      }
    }),
    React2.createElement("span", null, "临期置顶")
  );
}
