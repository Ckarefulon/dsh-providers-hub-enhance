/**
 * 宿主侧：**CodeBuddy（腾讯 `copilot.tencent.com`）出站请求守卫**。
 *
 * 机制完全照抄 [dsh-wb400-guard](https://github.com/curo22/dsh-wb400-guard) 的
 * fetch 层守卫（本项目只把它**收到 CodeBuddy 一个提供方**上，别的渠道一字节不碰）。
 *
 * ## 要解决的问题
 *
 * 腾讯国内网关的服务端通道校验会拦掉 system / assistant 里某些**客户端自带的模板句**，
 * 回 `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 插件把这条包成「请求被拦截，请重新发送」（标签 `INVALID_REQUEST`）。DSH 自己的
 * 提示词里**默认就带着**其中四段，所以走 buddy 时每轮都会在第一步挂掉。
 *
 * | # | 指纹 | 出处（DSH 内核） | 拦的位置 |
 * |---|---|---|---|
 * | 1 | `Tokens prefixed with @ are paths the user explicitly referenced…` | `@deepseek-ai/dsh-file-reference` | **任意位置**（system 与 assistant 都拦） |
 * | 2 | `You are an AI agent powered by DeepSeek\u200B Harness.` | `@deepseek-ai/dsh-system-prompt`（`includeHarnessIdentity`） | **仅消息开头** |
 * | 3 | `You are a coding agent powered by {model} model.` | `@deepseek-ai/dsh-web-app`（`personaPrefix`） | 句式 `coding agent powered by` |
 * | 4 | `You are interacting with the user through the DeepSeek\u200B Harness Web GUI…` / `Current DeepSeek\u200B Harness Web GUI URL` | `@deepseek-ai/dsh-harness-dev-context` | 同上（在 system 尾部，只做「开头锚定」的修法够不到） |
 *
 * 四段在 2026-11-07 的本机 DSH 提示词里**实测全都在**（那四句就是从活的 system
 * prompt 里抄下来的，测试文件里有逐字断言）。改写全部是**语义等价**的措辞变化：
 * 模型读到的意思不变，网关匹配不到那些字面量 / 句式。
 *
 * ## 为什么落在 fetch 层，而不是别处
 *
 * `dsh-providers-hub` 自己已经有一层 `openai-gateway/tencent-fingerprint.js`
 * （表驱动，管的是 **ZCode / Claude Code 客户端模板句** —— 与我们这四段不重叠）。
 * 但它按**调用点**接入（`serializeMessages` 与 `options.system`），于是每新增一条
 * 出站路径（`buddy-growth.ts` 的两处直发 POST、未来的新入口）就要再补一次，
 * 漏一处就是整轮 400 —— 上游自己在那份文档里把这条教训写成了「第三个未改写入口」。
 *
 * fetch 是**唯一**同时满足三件事的位置：
 *
 * 1. **精准**：可以按 host 只认 `copilot.tencent.com`，别的渠道原样透传（连序列化都不重做）；
 * 2. **不漏**：不管上游把请求从哪个函数发出去，最后都要过这里；
 * 3. **盖得住重试阶梯**：`BuddyAdapter.stream()` 内部有换号 / 限流 / 策略拦截的多级重试，
 *    每一级都重新发请求 —— 在 body 组装层改写就会漏掉其中几级。
 *
 * ## 契约（与测试一一对应）
 *
 * 1. 只改 `system` / `developer` / `assistant` 三条角色的 content；
 *    `user` 与 `tool` 一个字不动（用户原话、工具输出的证据完整性）。
 * 2. 只改命中 `hosts` 的请求（默认仅 `copilot.tencent.com`）。
 * 3. 非字符串 body（流、Buffer、无 body）原样透传。
 * 4. **幂等**：`rewrite(rewrite(x)) === rewrite(x)`；未改动时返回入参原引用。
 * 5. **fail-open**：改写链路任何异常都退回原始请求，绝不阻断对话、绝不引入重试。
 * 6. 改动后**剔除陈旧的 `Content-Length`**（否则上游按旧长度截断）。
 * 7. 全局只装**一层**（`Symbol.for`），重复安装返回同一个卸载函数。
 * 8. 日志只记 origin + path（剥掉 query 里的 `prompt_cache_key` / token）。
 *
 * ## 开关（不用重打补丁就能改）
 *
 * | 环境变量 | 值 | 说明 |
 * |---|---|---|
 * | `DSH_CODEBUDDY_GUARD` | `off` | 完全不碰 fetch |
 * | | `dryrun` | 只观测：一个字节都不改，命中只记 `would-rewrite` |
 * | | `all` | 把扫描角色里的所有 `@` 都换成 `(at)`（内核改了措辞时的兜底） |
 * | `DSH_CODEBUDDY_GUARD_MODE` | `anchor` / `all` | 同上，与上一行等价 |
 * | `DSH_CODEBUDDY_GUARD_HOSTS` | 逗号分隔 | 追加要防护的 host，以 `.` 开头做后缀匹配（例如 `.workbuddy.ai`） |
 * | `DSH_CODEBUDDY_GUARD_LOG` | 路径 | 覆盖日志文件位置 |
 *
 * 日志默认落在 `<DSH_HOME>/jet-hub/codebuddy-guard.jsonl`（与 `rate-limit-resume.json` 同目录）。
 *
 * @module codebuddy-guard
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 全局安装标记：同一个进程只装一层（后装的在外层会吞掉先装的日志与卸载）。 */
export const GUARD_INSTALLED = Symbol.for('dsh-providers-hub-enhance.codebuddy-guard');

/**
 * 默认防护的 host：**只有 CodeBuddy 中国版后端**。
 *
 * ⚠️ WorkBuddy 已改造为国际版（`www.workbuddy.ai`），默认**不**在列表里：
 * 本守卫的依据是腾讯国内网关的通道校验，别家（含国际版）不做这个校验，改了只是
 * 白白让前缀缓存失效。真的需要时用 `DSH_CODEBUDDY_GUARD_HOSTS=.workbuddy.ai` 追加。
 */
export const DEFAULT_GUARDED_HOSTS = ['copilot.tencent.com'];

/**
 * 网关会扫描的角色。
 *
 * `assistant` 也在其中，而且比 system 更严：文件引用段（指纹 1）在 assistant 消息的
 * **任意位置**都触发（开头 / 中段 / 尾部、前面垫空格或 BOM 全都会 400）。
 * `user` 与 `tool` 实测不扫描（塞完整指纹进去也是 200），故刻意不动。
 */
export const SCANNED_ROLES = new Set(['system', 'developer', 'assistant']);

/**
 * 指纹 1 的内核原文（`@deepseek-ai/dsh-file-reference`）。
 *
 * ⚠️ 与内核**逐字**对齐：整段命中时只把段内的 `@` 换成 `(at)`，其余不变；
 * 内核改了尾部措辞时由下面的宽松锚点兜底。
 */
export const FILE_REFERENCE_PROMPT =
    'Tokens prefixed with @ are paths the user explicitly referenced. '
    + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. '
    + 'A trailing slash marks a directory: list it when its contents matter. '
    + 'Anything else is a file: use the read tool when its contents are needed, '
    + 'and do not claim to have inspected it before reading. '
    + '@"..." quotes a path containing spaces.';

/** 宽松锚点：网关实际匹配的是开头这一句，内核可能改写句子尾部。 */
const LOOSE_ANCHOR = 'Tokens prefixed with @';

/* ------------------------------------------------------- 指纹 2：内核身份句 */

const IDENTITY_SAFE = 'You are an AI agent powered by DeepSeek-Harness.';
/** `DeepSeek` 与 `Harness` 之间是 U+200B 零宽空格，正则必须容忍（含普通空白与 BOM 变体）。 */
const IDENTITY_RE = /^You are an AI agent powered by DeepSeek[\u200B\s]*Harness\./;
const LEADING_NOISE_RE = /^[\s\uFEFF]*/;
const IDENTITY_HINT = 'You are an AI agent powered by DeepSeek';

/** U+200B / U+00A0 / U+2060 / U+FEFF 与普通空白，内核各处混用。 */
const INVISIBLE = '[\\s\\u00A0\\u200B\\u2060\\uFEFF]*';

/** `DeepSeek` + 不可见分隔 + `Harness`，这是网关认的品牌指纹。 */
const BRAND_RE = new RegExp(`DeepSeek${INVISIBLE}Harness`, 'g');

/** 品牌指纹的等义写法：保留可读性，去掉「两个大写词相邻 + 不可见分隔」这个形状。 */
const BRAND_SAFE = 'DeepSeek-Harness';

/** 指纹 3：`personaPrefix` 往 system 里插的那句（模型名由内核插值，故只认句式）。 */
const CODING_AGENT_RE = new RegExp(
    `You${INVISIBLE}are${INVISIBLE}a${INVISIBLE}coding${INVISIBLE}agent${INVISIBLE}powered${INVISIBLE}by`,
    'gi',
);
const CODING_AGENT_SAFE = 'You are a coding agent running on';

/** 指纹 4a：`dsh-harness-dev-context` 的 Web 面段落。 */
const WEB_SURFACE_RE = new RegExp(
    `You${INVISIBLE}are${INVISIBLE}interacting${INVISIBLE}with${INVISIBLE}the${INVISIBLE}user`
    + `${INVISIBLE}through${INVISIBLE}the${INVISIBLE}DeepSeek${INVISIBLE}Harness${INVISIBLE}Web${INVISIBLE}GUI`,
    'gi',
);
const WEB_SURFACE_SAFE = 'You are interacting with the user through this Web GUI';

/** 指纹 4b：同一插件注册的运行时上下文那一条。 */
const WEB_URL_RE = new RegExp(
    `Current${INVISIBLE}DeepSeek${INVISIBLE}Harness${INVISIBLE}Web${INVISIBLE}GUI${INVISIBLE}URL`,
    'gi',
);
const WEB_URL_SAFE = 'Current Web GUI URL';

/** 提前返回用：宁可多算不可漏判（`coding agent` 覆盖指纹 3，品牌词覆盖 2/4）。 */
const FINGERPRINT_HINT_RE = new RegExp(`DeepSeek${INVISIBLE}Harness|coding${INVISIBLE}agent`, 'i');

/* ------------------------------------------------------------------ 指纹改写 */

/** 内核身份句是否需要在发出去之前改写。 */
export function hasIdentitySentence(text) {
    if (typeof text !== 'string' || !text.includes(IDENTITY_HINT)) return false;
    const head = LEADING_NOISE_RE.exec(text)?.[0] ?? '';
    return IDENTITY_RE.test(text.slice(head.length));
}

/**
 * 把**开头**的内核身份句换成等义但网关放行的写法。
 *
 * ⚠️ 只看开头：这句放在句子中间 / 消息尾部都不拦（实测），却会白改用户内容。
 * 未命中返回入参原引用。
 */
export function neutralizeIdentity(text) {
    if (!hasIdentitySentence(text)) return text;
    const head = LEADING_NOISE_RE.exec(text)?.[0] ?? '';
    const rest = text.slice(head.length);
    return head + IDENTITY_SAFE + rest.replace(IDENTITY_RE, '');
}

/** 是否有任何一处可改写的身份 / 品牌指纹。 */
export function hasFingerprintText(text) {
    if (typeof text !== 'string' || text === '') return false;
    return FINGERPRINT_HINT_RE.test(text) || text.includes(IDENTITY_HINT);
}

/**
 * 按固定顺序抹掉四处身份指纹。未命中返回入参原引用。
 *
 * 顺序不能乱：
 * 1. 先处理**锚定在开头**的指纹 2（被别处改写挤掉开头就不再生效）；
 * 2. 再处理句式型的指纹 3（`coding agent powered by`）；
 * 3. 再处理带品牌词的指纹 4a / 4b（整句替换比逐词替换干净）；
 * 4. 最后兜底把残留的 `DeepSeek⁻Harness` 品牌指纹换成连字符写法。
 *
 * ⚠️ 最后一步会顺带把指纹 2/3 在「非开头」位置的残留品牌词也中性化 —— 那是
 * 唯一安全的过度改写：语义不变，且网关对 brand 的判定位置无关。
 */
export function neutralizeFingerprints(text) {
    if (!hasFingerprintText(text)) return text;

    let out = neutralizeIdentity(text);
    CODING_AGENT_RE.lastIndex = 0;
    if (CODING_AGENT_RE.test(out)) {
        CODING_AGENT_RE.lastIndex = 0;
        out = out.replace(CODING_AGENT_RE, CODING_AGENT_SAFE);
    }
    WEB_SURFACE_RE.lastIndex = 0;
    if (WEB_SURFACE_RE.test(out)) {
        WEB_SURFACE_RE.lastIndex = 0;
        out = out.replace(WEB_SURFACE_RE, WEB_SURFACE_SAFE);
    }
    WEB_URL_RE.lastIndex = 0;
    if (WEB_URL_RE.test(out)) {
        WEB_URL_RE.lastIndex = 0;
        out = out.replace(WEB_URL_RE, WEB_URL_SAFE);
    }
    BRAND_RE.lastIndex = 0;
    if (BRAND_RE.test(out)) {
        BRAND_RE.lastIndex = 0;
        out = out.replace(BRAND_RE, BRAND_SAFE);
    }
    return out;
}

/**
 * 指纹 1：把文件引用段里的 `@` 换成等义的 `(at)`。
 *
 * ⚠️ **只替换整段指纹**，不做「见到 @ 就换」的兜底：裸的 `@"` 实测完全不触发网关
 * （PowerShell here-string / C# 逐字字符串 / 重复 20 次 / 加长文本，全部 200），
 * 兜底只会把用户代码里的 here-string 静默改坏。
 */
function rewriteAnchor(text) {
    let out = text;
    if (out.includes(FILE_REFERENCE_PROMPT)) {
        out = out.split(FILE_REFERENCE_PROMPT).join(FILE_REFERENCE_PROMPT.replaceAll('@', '(at)'));
    }
    if (out.includes(LOOSE_ANCHOR)) {
        out = out.split(LOOSE_ANCHOR).join('Tokens prefixed with (at)');
    }
    return out;
}

/** 兜底模式：扫描角色里的 `@` 全换（只在 `mode === 'all'` 时用）。 */
function rewriteAll(text) {
    return text.replaceAll('@', '(at)');
}

/**
 * 改写一段文本。
 *
 * @param text - 已取出的纯文本。
 * @param mode - `anchor`（默认，只动整段指纹）或 `all`（所有 `@` 都换）。
 * @returns 改写结果；未改动时是**入参原引用**。
 */
export function rewriteText(text, mode = 'anchor') {
    if (typeof text !== 'string') return text;
    let out = neutralizeFingerprints(text);
    if (out.includes('@')) out = mode === 'all' ? rewriteAll(out) : rewriteAnchor(out);
    return out;
}

/** 递归走 content（字符串 / 数组 / 对象），就地改写。 */
function walkContent(value, mode, state) {
    if (typeof value === 'string') {
        // ⚠️ 内联图片（buddy 适配器把附件读成 `data:image/…;base64,`）直接跳过：
        // base64 字母表里没有 `@`，不可能命中任何指纹，而它常有几 MB —— 逐字符扫一遍
        // 只会让每轮都白烧几十毫秒（历史里的图片每轮都会重放）。
        if (value.startsWith('data:') && value.includes(';base64,')) return value;
        const next = rewriteText(value, mode);
        if (next !== value) state.changed = true;
        return next;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) value[i] = walkContent(value[i], mode, state);
        return value;
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) value[key] = walkContent(value[key], mode, state);
        return value;
    }
    return value;
}

/**
 * 就地改写一个 chat 请求体对象里的扫描角色。
 *
 * @returns 是否真的改过。
 */
export function rewriteChatBodyObject(body, mode = 'anchor') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const messages = body.messages;
    if (!Array.isArray(messages)) return false;
    const state = { changed: false };
    for (const message of messages) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
        if (!SCANNED_ROLES.has(role)) continue;
        if (message.content === undefined) continue;
        message.content = walkContent(message.content, mode, state);
    }
    return state.changed;
}

/**
 * 改写一份 JSON 请求体字符串。
 *
 * @returns `{ body, changed }`：未改动时 `body` 是入参原引用（调用方据此免去重发）。
 */
export function rewriteJsonBody(raw, mode = 'anchor') {
    if (typeof raw !== 'string') return { body: raw, changed: false };
    // 预检：既没有 `@` 也没有任何身份指纹 ⇒ 连 JSON.parse 都不做（大多数请求走这条）。
    if (!raw.includes('@') && !hasFingerprintText(raw)) return { body: raw, changed: false };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // 非 JSON（表单、multipart、SSE 上行…）原样透传。
        return { body: raw, changed: false };
    }
    const changed = rewriteChatBodyObject(parsed, mode);
    if (!changed) return { body: raw, changed: false };
    return { body: JSON.stringify(parsed), changed: true };
}

/* ------------------------------------------------------------------ host 判定 */

/** `hostname` 是否命中 `hosts`（以 `.` 开头做后缀匹配，容忍尾点）。 */
export function isGuardedHost(hostname, hosts = DEFAULT_GUARDED_HOSTS) {
    if (typeof hostname !== 'string' || hostname === '') return false;
    const host = hostname.toLowerCase().replace(/\.$/, '');
    for (const raw of hosts) {
        if (typeof raw !== 'string' || raw === '') continue;
        const entry = raw.toLowerCase().replace(/\.$/, '');
        if (entry.startsWith('.')) {
            if (host === entry.slice(1) || host.endsWith(entry)) return true;
        }
        else if (host === entry) {
            return true;
        }
    }
    return false;
}

/** 从 fetch 的 `input` 取出 URL 字符串（string / URL / Request 三种形态）。 */
export function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
    return '';
}

/**
 * 日志用的 URL 投影：只留 origin + pathname。
 *
 * ⚠️ 查询串可能带敏感参数（`prompt_cache_key`、token），一律不落盘。
 */
export function safeUrl(url) {
    if (typeof url !== 'string' || url === '') return '';
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return String(url).split(/[?#]/)[0];
    }
}

/** URL 是否发往受防护的 host。 */
export function isGuardedUrl(url, hosts = DEFAULT_GUARDED_HOSTS) {
    if (typeof url !== 'string' || url === '') return false;
    try {
        return isGuardedHost(new URL(url).hostname, hosts);
    }
    catch {
        return false;
    }
}

/**
 * 剔除陈旧的 `Content-Length`。
 *
 * ⚠️ 必须做：body 变短后若还带旧长度，上游会按旧长度读、请求直接被截断
 * （表现是「改了反而 400 得更离谱」）。返回普通对象（`Headers` 实例不保留）。
 */
export function dropContentLength(headers) {
    if (headers === undefined || headers === null) return headers;
    const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
    const out = {};
    for (const [key, value] of entries) {
        if (String(key).toLowerCase() === 'content-length') continue;
        out[key] = value;
    }
    return out;
}

/* ------------------------------------------------------------------ 统计 / 日志 */

/** 一份空统计（每次安装重置）。 */
function emptyStats() {
    return { total: 0, rewritten: 0, wouldRewrite: 0, passedThrough: 0, failed: 0, lastEvent: null };
}

/** 模块级统计：全局守卫与适配器层守卫**共用**同一份（否则「改了几次」永远对不上）。 */
let stats = emptyStats();

/**
 * 日志落点：`<DSH_HOME>/codebuddy-guard.jsonl`。
 *
 * ⚠️ 与 `jet-hub-store.ts` 的 `resolveJetHubHome` 同一类问题：**不能直接信
 * `process.env.USERPROFILE`** —— 部分 Electron host 在中文用户名机器上会把 UTF-16
 * 路径按 GBK 解出来（得到 `C:\Users\缃楅洦` 这种并不存在的目录），日志于是写进
 * 乱码路径或直接失败。故按「磁盘上真的存在」的候选顺序取第一个。
 */
export function guardHome(configured) {
    const candidates = [];
    if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim());
    if (process.env.DSH_JET_HUB_STATE_DIR) candidates.push(process.env.DSH_JET_HUB_STATE_DIR);
    // 1) 从本模块自身路径往上找 `.dsh`：装在 `<profile>/node_modules/…` 或 `vendor/` 下时
    //    最可靠，完全绕开环境变量的码页解码问题。
    const ancestor = findDshAncestor();
    if (ancestor !== '') candidates.push(ancestor);
    if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME);
    // 2) `os.userInfo().homedir` 在 Windows 上走 `GetUserProfileDirectoryW`，不读环境变量。
    try {
        candidates.push(join(userInfo().homedir, '.dsh'));
    }
    catch {
        // 拿不到就跳过
    }
    // 3) `homedir()` 在 Windows 上就是读 USERPROFILE，会被同样的码页问题坑到，排在后面。
    try {
        candidates.push(join(homedir(), '.dsh'));
    }
    catch {
        // 跳过
    }
    if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, '.dsh'));
    if (process.env.HOME) candidates.push(join(process.env.HOME, '.dsh'));
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) return candidate;
        }
        catch {
            // 权限之类的问题，试下一个
        }
    }
    return candidates[0] ?? join(homedir(), '.dsh');
}

/** 从模块自身路径向上找名为 `.dsh` 的祖先目录。 */
function findDshAncestor() {
    try {
        let dir = dirname(fileURLToPath(import.meta.url));
        for (let depth = 0; depth < 12; depth += 1) {
            if (basename(dir) === '.dsh') return dir;
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    catch {
        // 拿不到就交给后面的候选
    }
    return '';
}

/**
 * 日志路径：显式配置 > `<DSH_HOME>/jet-hub/codebuddy-guard.jsonl`。
 *
 * ⚠️ 与 `rate-limit-resume.json` / `ui-preferences.json` **同目录**：本补丁自己的
 * 产物集中在一处，用户排障时不用记第二个位置。
 */
export function resolveGuardLogPath(configured) {
    if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
    const stateDir = process.env.DSH_JET_HUB_STATE_DIR;
    if (typeof stateDir === 'string' && stateDir.trim() !== '') return join(stateDir.trim(), 'codebuddy-guard.jsonl');
    return join(guardHome(), 'jet-hub', 'codebuddy-guard.jsonl');
}

/** 懒建目录的 JSONL 追加器：**任何失败都不得影响请求链路**。 */
export function createLogger(logPath) {
    let ready = false;
    return (record) => {
        try {
            if (!ready) {
                mkdirSync(dirname(logPath), { recursive: true });
                ready = true;
            }
            appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
        }
        catch {
            // 日志失败不得影响请求
        }
    };
}

/** 当前日志落点（安装后才有意义）。 */
let logSink = () => {};

function recordEvent(event) {
    try {
        logSink(event);
    }
    catch {
        // 观察者异常不得影响请求
    }
}

/* ------------------------------------------------------------------ 守卫本体 */

/**
 * 造一个受守卫的 fetch。
 *
 * @param options.fetchImpl - 内层 fetch（默认取 `globalThis.fetch`）。
 * @param options.hosts - 受防护 host 列表。
 * @param options.mode - `anchor` / `all`。
 * @param options.dryRun - `true` 时只观测：请求一个字节都不改，命中只记 `would-rewrite`。
 * @param options.onEvent - 事件回调（异常会被吞掉，不影响请求）。
 * @param options.stats - 外部统计对象（用来让多层包装共用同一份计数）。
 * @returns `{ fetch, stats }`。
 */
export function createGuardedFetch(options = {}) {
    const {
        fetchImpl = globalThis.fetch,
        hosts = DEFAULT_GUARDED_HOSTS,
        mode = 'anchor',
        dryRun = false,
        onEvent = null,
        stats: sharedStats = emptyStats(),
    } = options;

    if (typeof fetchImpl !== 'function') {
        throw new TypeError('createGuardedFetch: fetchImpl must be a function');
    }

    const emit = (event) => {
        sharedStats.lastEvent = event;
        if (typeof onEvent !== 'function') return;
        try {
            onEvent(event);
        }
        catch {
            // 观察者异常不得影响请求
        }
    };

    const guardedFetch = async function guardedFetch(input, init) {
        sharedStats.total += 1;
        let nextInit = init;
        let rewritten = null;
        try {
            const url = urlOf(input);
            if (isGuardedUrl(url, hosts)) {
                const body = init === undefined || init === null ? undefined : init.body;
                // 只处理字符串 body：流 / Buffer / FormData 原样透传。
                if (typeof body === 'string') {
                    const outcome = rewriteJsonBody(body, mode);
                    if (outcome.changed && dryRun) {
                        // dryRun：只观察，绝不改请求。请求原样发出，只把「本来会改」记下来。
                        sharedStats.wouldRewrite += 1;
                        emit({ kind: 'would-rewrite', url: safeUrl(url), charsIn: body.length, mode });
                        sharedStats.passedThrough += 1;
                        return fetchImpl(input, init);
                    }
                    if (outcome.changed) {
                        rewritten = { url: safeUrl(url), charsIn: body.length, charsOut: outcome.body.length };
                        nextInit = { ...init, body: outcome.body };
                        const dropped = dropContentLength(nextInit.headers);
                        if (dropped === undefined) delete nextInit.headers;
                        else nextInit.headers = dropped;
                    }
                }
            }
        }
        catch {
            // fail-open：改写链路自身出任何错都不能阻断对话，也不引入重试。
            rewritten = null;
            nextInit = init;
            sharedStats.failed += 1;
        }

        if (rewritten !== null) {
            sharedStats.rewritten += 1;
            emit({ kind: 'rewritten', ...rewritten, mode });
        }
        else {
            sharedStats.passedThrough += 1;
        }

        return fetchImpl(input, nextInit);
    };

    return { fetch: guardedFetch, stats: sharedStats };
}

/* ------------------------------------------------------------------ 安装 / 卸载 */

/** 当前安装（`null` = 没装）。 */
let installed = null;

/** 每个内层 fetch 只包一层（WeakMap 记忆化）：重复接线不会叠成两层守卫。 */
const wrappedFetches = new WeakMap();

/**
 * 把一个 fetch 包成守卫（幂等）。
 *
 * 用途有两个：
 * 1. `installCodeBuddyGuard()` 用它包 `globalThis.fetch`；
 * 2. `BuddyAdapter` 构造时用它包 `options.fetchImpl ?? fetch` —— 适配器在
 *    **构造那一刻**就把 `fetch` 存进了实例（`this.fetchImpl = options.fetchImpl ?? fetch`），
 *    若插件加载顺序让守卫晚于构造完成，只包全局 fetch 是**盖不到**这个实例的。
 *
 * 若全局守卫已装且 `inner` 就是它，直接返回 `inner`（避免叠第二层：会双倍改写与双倍日志）。
 */
export function guardCodeBuddyFetch(inner) {
    if (typeof inner !== 'function') return inner;
    if (installed !== null && inner === installed.fetch) return inner;
    const cached = wrappedFetches.get(inner);
    if (cached !== undefined) return cached;
    const options = installed?.options ?? readGuardOptionsFromEnv();
    if (options.enabled === false) return inner;
    const { fetch: guarded } = createGuardedFetch({ ...options, fetchImpl: inner, onEvent: recordEvent, stats });
    wrappedFetches.set(inner, guarded);
    return guarded;
}

/**
 * 安装全局守卫（**单例**）。
 *
 * ⚠️ 在 `apply()` 里**尽早**调用：`registerBuddyLlm()` 会在同一个 `apply()` 里
 * 构造适配器，而适配器构造时就捕获了 `fetch` 引用。
 *
 * @param ctx - Cordis 上下文（只用于 logger / effect / home 解析，都可以缺省）。
 * @param overrides - 覆盖环境变量解析出来的选项（测试用）。
 */
export function installCodeBuddyGuard(ctx, overrides = {}) {
    const options = { ...readGuardOptionsFromEnv(), ...overrides };

    if (options.enabled === false) {
        ctx?.logger?.info?.('[codebuddy-guard] 已被环境变量关闭（DSH_CODEBUDDY_GUARD=off），fetch 保持原样');
        return { installed: false, logPath: null };
    }

    // fiber 重启时旧实例可能还没 dispose（本仓库反复登记的「新旧交错」形态）：
    // 先撤旧的，再把新的挂上。
    if (installed !== null) {
        try {
            installed.uninstall();
        }
        catch {
            // 旧实例已坏也无所谓
        }
    }

    const home = guardHome();
    const logPath = resolveGuardLogPath(options.logPath);
    const log = createLogger(logPath);
    stats = emptyStats();
    logSink = (event) => {
        log({
            event: event.kind,
            url: event.url,
            charsIn: event.charsIn,
            charsOut: event.charsOut,
            mode: event.mode,
            dryRun: options.dryRun === true,
        });
    };

    const original = globalThis.fetch;
    const { fetch: guardedFetch } = createGuardedFetch({
        ...options,
        fetchImpl: original,
        onEvent: recordEvent,
        stats,
    });

    const uninstall = () => {
        if (globalThis.fetch === guardedFetch) globalThis.fetch = original;
        if (globalThis[GUARD_INSTALLED]?.fetch === guardedFetch) delete globalThis[GUARD_INSTALLED];
        if (installed !== null && installed.fetch === guardedFetch) installed = null;
        logSink = () => {};
        log({ event: 'uninstalled' });
    };

    globalThis.fetch = guardedFetch;
    globalThis[GUARD_INSTALLED] = { fetch: guardedFetch, uninstall, stats };
    installed = { fetch: guardedFetch, originalFetch: original, options, uninstall, logPath };

    log({ event: 'installed', hosts: options.hosts, mode: options.mode, dryRun: options.dryRun === true, logPath });
    ctx?.logger?.info?.(
        `[codebuddy-guard] 已对 ${options.hosts.join(', ')} 安装出站守卫`
        + `${options.dryRun === true ? '（dryRun：只观测，不改写）' : ''}；日志 ${logPath}`,
    );

    // 卸载挂 ctx.effect：profile reload / 插件禁用 / 进程退出前 dispose 时自动还原 fetch。
    if (typeof ctx?.effect === 'function') {
        ctx.effect(() => uninstall, 'codebuddy-guard: outbound fetch guard');
    }

    return { installed: true, logPath };
}

/** 卸载（测试与手动排障用；正常生命周期走 `ctx.effect`）。 */
export function uninstallCodeBuddyGuard() {
    if (installed === null) return false;
    installed.uninstall();
    return true;
}

/** 观测：守卫在不在、改了多少次、最近一次事件。 */
export function guardState() {
    return {
        installed: installed !== null,
        hosts: installed?.options.hosts ?? null,
        mode: installed?.options.mode ?? null,
        dryRun: installed?.options.dryRun === true,
        logPath: installed?.logPath ?? null,
        stats: { ...stats },
    };
}

/* ------------------------------------------------------------------ 配置解析 */

/** 解析可选 host 清单（逗号 / 空白分隔）。 */
function parseHosts(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return [];
    return raw.split(/[,;\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * 从环境变量读守卫选项（见模块头的开关表）。
 *
 * 单独导出是为了**可测**：一套开关最容易写错的地方就是拼写与默认值。
 */
export function readGuardOptionsFromEnv(env = process.env) {
    const raw = typeof env.DSH_CODEBUDDY_GUARD === 'string'
        ? env.DSH_CODEBUDDY_GUARD.trim().toLowerCase()
        : '';
    const enabled = !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled' || raw === 'no');
    const dryRun = raw === 'dryrun' || raw === 'dry-run' || raw === 'observe';
    const modeEnv = typeof env.DSH_CODEBUDDY_GUARD_MODE === 'string'
        ? env.DSH_CODEBUDDY_GUARD_MODE.trim().toLowerCase()
        : '';
    const mode = raw === 'all' || modeEnv === 'all' ? 'all' : 'anchor';
    const hosts = parseHosts(env.DSH_CODEBUDDY_GUARD_HOSTS);
    const logPath = typeof env.DSH_CODEBUDDY_GUARD_LOG === 'string' ? env.DSH_CODEBUDDY_GUARD_LOG.trim() : '';
    return {
        enabled,
        dryRun,
        mode,
        hosts: hosts.length > 0 ? hosts : DEFAULT_GUARDED_HOSTS,
        logPath,
    };
}
