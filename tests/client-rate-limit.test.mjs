// 客户端半边的**真跑**测试：把插进 bundle 的那一块抽出来，在极简 React + 假 DOM 里执行。
//
// 为什么不用 jsdom：这一块只依赖 React 的 `createElement` / `useState` / `useEffect`
// / `useCallback` / `useRef` 与 DOM 的 `querySelector` / `appendChild` /
// `replaceChildren` / `MutationObserver`，自己实现够用的子集比拉一个 DOM 引擎便宜，
// 也更容易断言「到底渲染出了什么元素」。
//
// ⚠️ 夹具必须照抄宿主**真实的**类名形态（`LOmM4q_turnErrorRow`）：按后缀匹配
//（`[class*="_turnErrorRow"]`）是这一块唯一稳定的判据；把夹具写成自己的假类名
// 会让测试变成 bug 的帮凶。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK = readFileSync(join(HERE, '..', 'assets', 'client-rate-limit-resume.js'), 'utf8');

// ── 极简 React（只实现这一块真正调用的 hook）─────────────────────────────────
function makeReact() {
  const effects = [];
  const stateSlots = [];
  let slotIndex = 0;
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  });
  const useState = (initial) => {
    const index = slotIndex;
    slotIndex += 1;
    if (!(index in stateSlots)) stateSlots[index] = initial;
    return [
      stateSlots[index],
      (next) => { stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next; },
    ];
  };
  const useRef = (initial) => ({ current: initial });
  const useEffect = (effect) => { effects.push(effect); };
  const useCallback = (fn) => fn;
  return {
    createElement,
    useState,
    useRef,
    useEffect,
    useCallback,
    /** 每次渲染前重置 hook 下标（真实 React 按组件实例分组）。 */
    beginRender: () => { slotIndex = 0; effects.length = 0; },
    /** 跑一遍待执行的 effect（真实 React 在提交阶段跑）。 */
    flushEffects: () => {
      const pending = effects.splice(0);
      for (const effect of pending) {
        const cleanup = effect();
        if (typeof cleanup === 'function') effects.push(cleanup);
      }
    },
  };
}

// ── 极简 DOM ────────────────────────────────────────────────────────────────
function matchesSelector(node, selector) {
  for (const part of selector.split(',').map((s) => s.trim())) {
    const cls = /^\[class\*="(.*)"\]$/.exec(part);
    if (cls) {
      if (String(node.className).includes(cls[1])) return true;
      continue;
    }
    const attr = /^\[([a-zA-Z0-9-]+)\]$/.exec(part);
    if (attr) {
      if (node.attributes.has(attr[1])) return true;
      continue;
    }
    const tag = /^([a-zA-Z0-9]+)$/.exec(part);
    if (tag && node.tagName === tag[1].toUpperCase()) return true;
  }
  return false;
}

function makeDom() {
  const collect = (root, selector) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(root);
    return out;
  };
  const mkNode = (tag, className = '') => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className,
    children: [],
    parentNode: null,
    attributes: new Map(),
    listeners: new Map(),
    textContent: '',
    isConnected: true,
    href: undefined,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    removeAttribute(name) { this.attributes.delete(name); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at >= 0) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...next) {
      for (const old of this.children) old.parentNode = null;
      this.children = [];
      for (const child of next) this.appendChild(child);
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    dispatch(type) {
      const fn = this.listeners.get(type);
      if (typeof fn === 'function') fn({ preventDefault() {}, stopPropagation() {} });
    },
    matches(selector) { return matchesSelector(this, selector); },
    querySelectorAll(selector) { return collect(this, selector); },
    querySelector(selector) { return collect(this, selector)[0] ?? null; },
  });
  const body = mkNode('body');
  const sentinel = { children: [body], nodeType: 9 };
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; }
    observe(target) { this.targets.push(target); observers.push(this); }
    disconnect() { this.targets = []; }
    /** 测试用：主动报一条「子树里新增了节点」。 */
    emit(target, node) {
      if (!this.targets.includes(target)) return;
      this.callback([{ type: 'childList', addedNodes: [node] }]);
    }
  }
  const document = {
    body,
    createElement: (tag) => mkNode(tag),
    createElementNS: (_ns, tag) => mkNode(tag),
    querySelector: (selector) => collect(sentinel, selector)[0] ?? null,
    querySelectorAll: (selector) => collect(sentinel, selector),
  };
  return { document, MutationObserver, observers, mkNode };
}

/** 把那一块接进沙箱：它读 `React2` 与顶层 DOM 全局。 */
function loadBlock({ rpcCall, dom }) {
  const react = makeReact();
  const sandbox = {
    React2: react,
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    Element: Object,
    setInterval: () => 0,
    clearInterval: () => {},
    console: {
      warn: () => {},
      error: () => {},
    },
  };
  const names = [
    'installRateLimitResumeUi',
    'PhcResumeDefaultSwitch',
    'phcRenderToggle',
    'phcIsRateLimitRow',
    'phcCurrentSessionId',
    'PHC_ICON_DEFER',
    'PHC_ICON_CANCEL',
  ];
  const factory = new Function(...Object.keys(sandbox), `${BLOCK}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(sandbox)), react, sandbox, rpcCall };
}

/** 造宿主那一行的形态（哈希类名 + 三段格子）。 */
function makeTurnErrorRow(dom, message, code) {
  const row = dom.mkNode('div', 'LOmM4q_turnErrorRow');
  const dot = dom.mkNode('div', 'LOmM4q_turnErrorDot');
  const copy = dom.mkNode('div', 'LOmM4q_turnErrorCopy');
  const title = dom.mkNode('span', 'LOmM4q_turnErrorTitle');
  title.textContent = '本轮运行失败';
  const msg = dom.mkNode('span', 'LOmM4q_turnErrorMessage');
  msg.textContent = message;
  copy.appendChild(title);
  copy.appendChild(msg);
  row.appendChild(dot);
  row.appendChild(copy);
  if (code !== undefined) {
    const codeEl = dom.mkNode('code', 'LOmM4q_turnErrorCode');
    codeEl.textContent = code;
    row.appendChild(codeEl);
  }
  return row;
}

const SESSION_ID = 'session-528de4cb-ebfd-4c09-ac1c-9b6a723bb74c';

const RATE_LIMIT_HOOK = {
  sessionId: SESSION_ID,
  turn: 7,
  provider: 'raccoon',
  model: 'sn-deepseek-v4-1-flash',
  kind: 'rate',
  resetAtMs: Date.now() + 3600_000,
  armed: true,
  deferrals: 0,
};

function makeHost({ enabled = true, hooks = [] } = {}) {
  const calls = [];
  const rpcCall = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'resume.getState') {
      const list = hooks.filter((hook) => payload?.sessionId === undefined || hook.sessionId === payload.sessionId);
      return { enabled, available: true, hooks: list };
    }
    if (method === 'resume.setArmed') {
      const target = hooks.find((hook) => hook.sessionId === payload.sessionId);
      if (target === undefined) return { hook: null };
      target.armed = payload.armed;
      return { hook: { ...target } };
    }
    if (method === 'resume.setEnabled') return { enabled: payload.enabled, available: true };
    throw new Error(`unexpected ${method}`);
  };
  return { rpcCall, calls, hooks };
}

/** 让挂起的 Promise 续体跑完（`setImmediate` 在微任务之后）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('限流报错行会被增强；非限流报错行不会', async () => {
  const dom = makeDom();
  const holder = dom.mkNode('div', 'an3WzG_body');
  holder.setAttribute('data-conversation-session', SESSION_ID);
  dom.document.body.appendChild(holder);

  const rateRow = makeTurnErrorRow(dom, 'raccoon: HTTP 429 too many requests', 'RATE_LIMIT');
  const otherRow = makeTurnErrorRow(dom, '模型参数非法（400）', 'INVALID_REQUEST');
  holder.appendChild(rateRow);
  holder.appendChild(otherRow);

  const host = makeHost({ hooks: [{ ...RATE_LIMIT_HOOK }] });
  const block = loadBlock({ rpcCall: host.rpcCall, dom });
  const api = block.installRateLimitResumeUi({ rpcCall: host.rpcCall });
  api.decorateSubtree(holder);
  // ⚠️ 增强是**异步**的（先问宿主有没有待续跑记录）：不 await 就断言会拿到 null。
  await settle();

  assert.equal(rateRow.querySelector('[data-phc-resume-slot]') !== null, true, '限流行应被增强');
  assert.equal(otherRow.querySelector('[data-phc-resume-slot]'), null, '非限流行不该被增强');
  api.dispose();
});

test('按钮两态互切：黄延时 ⇄ 红叉，文案与 aria-pressed 跟着变', async () => {
  const dom = makeDom();
  const holder = dom.mkNode('div', 'x');
  holder.setAttribute('data-conversation-session', SESSION_ID);
  dom.document.body.appendChild(holder);
  const row = makeTurnErrorRow(dom, '429 Too Many Requests', 'RATE_LIMIT');
  holder.appendChild(row);

  const hooks = [{ ...RATE_LIMIT_HOOK, armed: true }];
  const host = makeHost({ hooks });
  const block = loadBlock({ rpcCall: host.rpcCall, dom });
  const api = block.installRateLimitResumeUi({ rpcCall: host.rpcCall });
  api.decorateSubtree(holder);
  await settle();

  const slot = row.querySelector('[data-phc-resume-slot]');
  assert.ok(slot, '应插入按钮格子');
  // ⚠️ 按钮是**原生 DOM**（那一行不在任何 React 树里），故断言读 attribute
  //    与子节点，而不是 React props。
  const button = slot.children[0];
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('data-armed'), '1');
  assert.equal(button.getAttribute('aria-label'), '解禁后自动继续');
  assert.equal(button.children[0].tagName, 'SVG', '图标必须是 SVG（不是 emoji/文本）');
  assert.equal(button.children[0].getAttribute('stroke-width'), '1', 'stroke-width 写在 svg 上');
  assert.equal(button.children[0].getAttribute('viewBox'), '0 0 16 16');
  assert.equal(button.children[0].children.length, block.PHC_ICON_DEFER.length, '黄延时态是闹钟字形');
  assert.equal(button.children[1].textContent, '解禁后自动继续');

  // 点一下 ⇒ 调 resume.setArmed(false) ⇒ 变红叉态
  button.dispatch('click');
  await settle();
  const setArmedCalls = host.calls.filter((call) => call.method === 'resume.setArmed');
  assert.equal(setArmedCalls.length, 1);
  assert.equal(setArmedCalls[0].payload.armed, false);
  assert.equal(hooks[0].armed, false);

  const buttonAfter = row.querySelector('[data-phc-resume-slot]').children[0];
  assert.equal(buttonAfter.getAttribute('aria-pressed'), 'false');
  assert.equal(buttonAfter.getAttribute('data-armed'), '0');
  assert.equal(buttonAfter.getAttribute('aria-label'), '不自动继续');
  assert.equal(buttonAfter.children[0].children.length, block.PHC_ICON_CANCEL.length, '红叉态是两条对角笔画');
  assert.equal(buttonAfter.children[1].textContent, '不自动继续');
  api.dispose();
});

test('宿主说「没有待续跑记录」时按钮被收掉', async () => {
  const dom = makeDom();
  const holder = dom.mkNode('div', 'x');
  holder.setAttribute('data-conversation-session', SESSION_ID);
  dom.document.body.appendChild(holder);
  const row = makeTurnErrorRow(dom, '限流中，请稍后重试', 'RATE_LIMIT');
  holder.appendChild(row);

  const host = makeHost({ hooks: [] });
  const block = loadBlock({ rpcCall: host.rpcCall, dom });
  const api = block.installRateLimitResumeUi({ rpcCall: host.rpcCall });
  api.decorateSubtree(holder);
  await settle();

  assert.equal(row.querySelector('[data-phc-resume-slot]'), null, '没有待续跑记录就不该留按钮');
  assert.equal(row.getAttribute('data-phc-rate-limit-resume'), null, '标记也要摘掉，便于下次重新尝试');
  api.dispose();
});

test('设置页开关：初值来自宿主，切换会提交', async () => {
  const dom = makeDom();
  const host = makeHost({ enabled: true });
  const block = loadBlock({ rpcCall: host.rpcCall, dom });

  block.react.beginRender();
  const element = block.PhcResumeDefaultSwitch({ rpcCall: host.rpcCall });
  assert.equal(element.type, 'label');
  const input = element.props.children[0];
  assert.equal(input.type, 'input');
  assert.equal(input.props.type, 'checkbox');
  assert.equal(input.props.className, 'dim-jh-switch', '必须复用宿主的开关样式');
  assert.equal(input.props.checked, true, '初始默认开启');
  assert.equal(element.props.children[1].props.children, '解禁后自动继续');
  // 开关是**默认值**开关：提示必须说清「不追溯已有记录」。
  assert.match(element.props.title, /默认值/);

  block.react.flushEffects();
  await settle();
  assert.equal(host.calls.filter((call) => call.method === 'resume.getState').length, 1, '挂载时应读一次状态');

  // 用户关掉它 ⇒ 提交 resume.setEnabled(false)
  input.props.onChange({ target: { checked: false } });
  await settle();
  const setEnabledCalls = host.calls.filter((call) => call.method === 'resume.setEnabled');
  assert.equal(setEnabledCalls.length, 1);
  assert.equal(setEnabledCalls[0].payload.enabled, false);
});

test('MutationObserver：新插入的报错行也会被增强', async () => {
  const dom = makeDom();
  const holder = dom.mkNode('div', 'x');
  holder.setAttribute('data-conversation-session', SESSION_ID);
  dom.document.body.appendChild(holder);

  const host = makeHost({ hooks: [{ ...RATE_LIMIT_HOOK }] });
  const block = loadBlock({ rpcCall: host.rpcCall, dom });
  const api = block.installRateLimitResumeUi({ rpcCall: host.rpcCall });

  // 流式渲染才刚把这行挂上来：观察器必须能接住。
  const row = makeTurnErrorRow(dom, 'HTTP 429', 'RATE_LIMIT');
  holder.appendChild(row);
  const observer = dom.observers.at(-1);
  assert.ok(observer, '应装上 MutationObserver');
  observer.emit(dom.document.body, row);
  await settle();

  assert.equal(row.querySelector('[data-phc-resume-slot]') !== null, true);
  api.dispose();
});
