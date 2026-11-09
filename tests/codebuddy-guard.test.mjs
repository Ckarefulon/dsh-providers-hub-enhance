// CodeBuddy 出站守卫的**真跑**测试。
//
// 被测模块是 `assets/codebuddy-guard.js`（补丁会原样拷成 `lib/codebuddy-guard.js`），
// 它**零外部依赖**（只用 node: 内置模块），因此可以直接 import —— 不必像
// `rate-limit-resume.test.mjs` 那样切函数体。
//
// ⚠️ 这里断言的**四段指纹**是从本机活的 DSH system prompt 里逐字抄下来的
// （2026-11-07 的会话）：不是从别人文档里转抄的常量。上游改了措辞时，
// 这份文件会先红 —— 那正是我们想要的信号。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    DEFAULT_GUARDED_HOSTS,
    FILE_REFERENCE_PROMPT,
    createGuardedFetch,
    dropContentLength,
    guardCodeBuddyFetch,
    guardState,
    hasIdentitySentence,
    installCodeBuddyGuard,
    isGuardedHost,
    isGuardedUrl,
    neutralizeFingerprints,
    neutralizeIdentity,
    readGuardOptionsFromEnv,
    rewriteChatBodyObject,
    rewriteJsonBody,
    rewriteText,
    safeUrl,
    uninstallCodeBuddyGuard,
} from '../assets/codebuddy-guard.js';

/** 指纹 2 的内核原文（`DeepSeek` 与 `Harness` 之间是 U+200B 零宽空格）。 */
const IDENTITY = 'You are an AI agent powered by DeepSeek\u200B Harness.';
/** 指纹 3：`personaPrefix` 那句（模型名由内核插值，这里用 buddy 的真实档位）。 */
const PERSONA = 'You are a coding agent powered by the buddy/hy4-preview model.';
/** 指纹 4a：Web 面段落（活的 system prompt 原文开头）。 */
const WEB_SURFACE = 'You are interacting with the user through the DeepSeek\u200B Harness Web GUI '
    + 'whose URL the runtime context names. When the user refers to "this page" without naming '
    + 'another target, they mean this GUI.';
/** 指纹 4b：同一插件注册的运行时上下文。 */
const WEB_URL = 'Current DeepSeek\u200B Harness Web GUI URL: "http://127.0.0.1:3807".';

/** 一份「四段全在」的 DSH system prompt（结构照抄真机，只压缩了无关段落）。 */
const LIVE_SYSTEM = [
    IDENTITY,
    '',
    PERSONA,
    '',
    FILE_REFERENCE_PROMPT,
    '',
    WEB_SURFACE,
    '',
    WEB_URL,
].join('\n');

const CHAT_URL = 'https://copilot.tencent.com/v2/chat/completions';

/**
 * 网关认的**品牌指纹**：`DeepSeek` + 不可见分隔 + `Harness`。
 *
 * 指纹 2（身份句）与兜底改写用的是同一个形状 —— 连字符写法 `DeepSeek-Harness`
 * 是网关放行的，所以这条正则同时充当「指纹 2 已消失」与「品牌词已中性化」的判据。
 */
const BRAND_FINGERPRINT = /DeepSeek[\s\u200B\u00A0\u2060\uFEFF]*Harness/;

/** 造一个 chat 请求体字符串。 */
function chatBody(messages, extra = {}) {
    return JSON.stringify({ model: 'hy4-preview', stream: true, messages, ...extra });
}

/** 收下 fetch 调用的假实现。 */
function makeFakeFetch() {
    const calls = [];
    const fetch = async (input, init) => {
        calls.push({ input, init });
        return new Response('ok', { status: 200 });
    };
    return { calls, fetch };
}

/* --------------------------------------------------------------- host 判定 */

test('只有 CodeBuddy 的 host 受防护（后缀条目按 `.` 前缀匹配）', () => {
    assert.deepEqual(DEFAULT_GUARDED_HOSTS, ['copilot.tencent.com']);
    assert.equal(isGuardedHost('copilot.tencent.com'), true);
    assert.equal(isGuardedHost('COPILOT.TENCENT.COM.'), true);
    // 国际版与别家渠道**刻意**不在默认列表里。
    assert.equal(isGuardedHost('www.workbuddy.ai'), false);
    assert.equal(isGuardedHost('api.deepseek.com'), false);
    assert.equal(isGuardedHost(''), false);
    // 追加条目：后缀式。
    assert.equal(isGuardedHost('a.workbuddy.ai', ['.workbuddy.ai']), true);
    assert.equal(isGuardedHost('workbuddy.ai', ['.workbuddy.ai']), true);
    // 子串不算：`evil-copilot.tencent.com.attacker.test` 必须被拒。
    assert.equal(isGuardedHost('evil-copilot.tencent.com.attacker.test'), false);
    assert.equal(isGuardedUrl(`${CHAT_URL}?prompt_cache_key=secret`), true);
    assert.equal(isGuardedUrl('not a url'), false);
});

test('日志用的 URL 剥掉查询串（token / prompt_cache_key 不落盘）', () => {
    assert.equal(safeUrl(`${CHAT_URL}?prompt_cache_key=abc&x=1`), CHAT_URL);
    assert.equal(safeUrl(''), '');
});

/* --------------------------------------------------------------- 四段指纹 */

test('指纹 1：文件引用段里的 @ 改成等义的 (at)', () => {
    const out = rewriteText(FILE_REFERENCE_PROMPT);
    assert.notEqual(out, FILE_REFERENCE_PROMPT);
    assert.equal(out.includes('@'), false, '段内不应残留 @');
    assert.ok(out.startsWith('Tokens prefixed with (at) are paths the user explicitly referenced.'));
    assert.ok(out.endsWith('(at)"..." quotes a path containing spaces.'));
});

test('指纹 1 只认整段：裸 @、邮箱、here-string 一个都不动', () => {
    for (const text of ['mail me at a@b.com', '@someone 看一下', 'var s = @"c:\\x";', 'Tokens prefixed are paths']) {
        assert.equal(rewriteText(text), text, `不该改写: ${text}`);
    }
});

test('指纹 2：只看消息开头的身份句（含零宽空格与前导 BOM）', () => {
    assert.equal(hasIdentitySentence(IDENTITY), true);
    assert.equal(hasIdentitySentence(`\uFEFF \n${IDENTITY}`), true);
    assert.equal(neutralizeIdentity(IDENTITY), 'You are an AI agent powered by DeepSeek-Harness.');
    // 放在句中 / 行首前置一整行时**不动**（网关也不拦，改了只是白改用户内容）。
    const mid = `前言一行\n${IDENTITY}`;
    assert.equal(neutralizeIdentity(mid), mid);
    assert.equal(hasIdentitySentence(mid), false);
});

test('指纹 3：`coding agent powered by` 换成 running on，模型名原样保留', () => {
    const out = rewriteText(PERSONA);
    assert.equal(out, 'You are a coding agent running on the buddy/hy4-preview model.');
    assert.ok(out.includes('buddy/hy4-preview'), '模型名不能被吃掉');
});

test('指纹 4：Web 面两句都中性化', () => {
    const out = neutralizeFingerprints(`${WEB_SURFACE}\n\n${WEB_URL}`);
    assert.ok(out.startsWith('You are interacting with the user through this Web GUI'));
    assert.ok(!/DeepSeek\s*Harness\s*Web\s*GUI/i.test(out));
    assert.ok(out.includes('Current Web GUI URL: "http://127.0.0.1:3807".'));
});

test('兜底：残留的 `DeepSeek + 不可见分隔 + Harness` 一律换成连字符写法', () => {
    const out = neutralizeFingerprints('An agent built on DeepSeek\u200B Harness, nothing else.');
    assert.equal(out, 'An agent built on DeepSeek-Harness, nothing else.');
});

/* --------------------------------------------------------------- 角色范围 */

test('只改 system / developer / assistant，user 与 tool 一个字不动', () => {
    const body = {
        messages: [
            { role: 'user', content: LIVE_SYSTEM },
            { role: 'tool', content: LIVE_SYSTEM },
            { role: 'system', content: LIVE_SYSTEM },
            { role: 'developer', content: LIVE_SYSTEM },
            { role: 'assistant', content: LIVE_SYSTEM },
        ],
    };
    assert.equal(rewriteChatBodyObject(body), true);
    assert.equal(body.messages[0].content, LIVE_SYSTEM);
    assert.equal(body.messages[1].content, LIVE_SYSTEM);
    for (const index of [2, 3, 4]) {
        assert.notEqual(body.messages[index].content, LIVE_SYSTEM, `角色的正文应被改写: ${body.messages[index].role}`);
    }
});

test('assistant 里的指纹在**任意位置**都要改（比 system 严）', () => {
    const middle = `已完成的步骤都在这。\n\n${FILE_REFERENCE_PROMPT}\n\n结束。`;
    const body = { messages: [{ role: 'assistant', content: middle }] };
    assert.equal(rewriteChatBodyObject(body), true);
    assert.equal(body.messages[0].content.includes('@'), false);
});

test('content 是 parts 数组时也要进去改', () => {
    const body = {
        messages: [{
            role: 'system',
            content: [{ type: 'text', text: `${IDENTITY}\n${FILE_REFERENCE_PROMPT}` }],
        }],
    };
    assert.equal(rewriteChatBodyObject(body), true);
    const text = body.messages[0].content[0].text;
    assert.ok(text.includes('DeepSeek-Harness'));
    assert.equal(text.includes('@'), false);
});

test('内联图片（data URL）原样跳过：不误判成「改过」，也不逐字符扫几 MB', () => {
    const image = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(500)}`;
    const clean = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }] };
    assert.equal(rewriteChatBodyObject(clean), false, '纯图片消息不该被认为改动过');
    assert.equal(clean.messages[0].content[0].image_url.url, image);

    // 同一份请求里既有图片又有指纹：指纹被改、图片一个字节不动。
    const mixed = {
        messages: [
            { role: 'system', content: LIVE_SYSTEM },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] },
        ],
    };
    assert.equal(rewriteChatBodyObject(mixed), true);
    assert.equal(mixed.messages[1].content[0].image_url.url, image);
});

/* --------------------------------------------------------------- 契约 */

test('幂等：改第二遍不再变动，且未改动时返回入参原引用', () => {
    const once = rewriteText(LIVE_SYSTEM);
    assert.equal(rewriteText(once), once);

    const raw = chatBody([{ role: 'system', content: '干净的提示词，什么都没有。' }]);
    const out = rewriteJsonBody(raw);
    assert.equal(out.changed, false);
    assert.equal(out.body, raw, '未改动时必须返回同一个字符串引用');
});

test('非 JSON / 非字符串 body 原样透传', () => {
    assert.deepEqual(rewriteJsonBody('field=value&x=1'), { body: 'field=value&x=1', changed: false });
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(rewriteJsonBody(bytes).body, bytes);
    assert.equal(rewriteJsonBody(undefined).changed, false);
});

test('Content-Length 必须剔掉，其它头保留', () => {
    const dropped = dropContentLength({ 'Content-Length': '4096', 'x-app': 'buddy', 'Content-Type': 'application/json' });
    assert.deepEqual(dropped, { 'x-app': 'buddy', 'Content-Type': 'application/json' });
    const headers = new Headers({ 'content-length': '10', 'x-app': 'buddy' });
    assert.deepEqual(dropContentLength(headers), { 'x-app': 'buddy' });
});

/* --------------------------------------------------------------- 守卫本体 */

test('受防护 host：body 被改写、Content-Length 被剔掉、响应原样返回', async () => {
    const fake = makeFakeFetch();
    const guard = createGuardedFetch({ fetchImpl: fake.fetch });
    const body = chatBody([{ role: 'system', content: LIVE_SYSTEM }]);
    const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        body,
    };

    const response = await guard.fetch(CHAT_URL, init);

    assert.equal(response.status, 200);
    assert.equal(fake.calls.length, 1);
    const sent = fake.calls[0].init;
    assert.notEqual(sent.body, body, 'body 应被替换成改写后的字符串');
    assert.equal(sent.headers['Content-Length'], undefined);
    assert.equal(sent.headers['Content-Type'], 'application/json');
    // 入参对象本身不被就地修改（上游可能复用 init）。
    assert.equal(init.body, body);
    assert.equal(init.headers['Content-Length'], String(body.length));

    const parsed = JSON.parse(sent.body);
    assert.equal(parsed.messages[0].content.includes('@'), false);
    assert.ok(parsed.messages[0].content.includes('DeepSeek-Harness'));
    // 别的字段一个不动（prompt_cache_key 是前缀缓存的关键，不能被重排或丢掉）。
    assert.equal(parsed.model, 'hy4-preview');
    assert.equal(guard.stats.total, 1);
    assert.equal(guard.stats.rewritten, 1);
});

test('不受防护的 host：连 init 引用都不重做', async () => {
    const fake = makeFakeFetch();
    const guard = createGuardedFetch({ fetchImpl: fake.fetch });
    const body = chatBody([{ role: 'system', content: LIVE_SYSTEM }]);
    const init = { method: 'POST', body };

    await guard.fetch('https://api.deepseek.com/chat/completions', init);

    assert.equal(fake.calls[0].init, init, '必须原样透传同一个 init 对象');
    assert.equal(guard.stats.passedThrough, 1);
    assert.equal(guard.stats.rewritten, 0);
});

test('dryRun：只观测，请求一个字节都不改', async () => {
    const fake = makeFakeFetch();
    const events = [];
    const guard = createGuardedFetch({
        fetchImpl: fake.fetch,
        dryRun: true,
        onEvent: (event) => events.push(event),
    });
    const body = chatBody([{ role: 'system', content: LIVE_SYSTEM }]);
    const init = { body };

    await guard.fetch(CHAT_URL, init);

    assert.equal(fake.calls[0].init, init);
    assert.equal(guard.stats.wouldRewrite, 1);
    assert.equal(guard.stats.rewritten, 0);
    assert.deepEqual(events.map((event) => event.kind), ['would-rewrite']);
});

test('fail-open：改写链路炸了也要把原请求发出去', async () => {
    const fake = makeFakeFetch();
    const guard = createGuardedFetch({ fetchImpl: fake.fetch });
    // 坏 JSON（连 parse 都过不了）⇒ 原样发出。
    const broken = '{"messages":[{"role":"system","content":"@ broken';
    await guard.fetch(CHAT_URL, { body: broken });
    assert.equal(fake.calls[0].init.body, broken);
    // 合法 JSON 但 messages 不是数组 ⇒ 不改。
    await guard.fetch(CHAT_URL, { body: '{"messages":"nope"}' });
    assert.equal(fake.calls[1].init.body, '{"messages":"nope"}');
    assert.equal(guard.stats.rewritten, 0);
});

test('内层 fetch 抛错时异常照常冒泡（守卫不吞网络错误）', async () => {
    const guard = createGuardedFetch({
        fetchImpl: async () => {
            throw new Error('boom');
        },
    });
    await assert.rejects(() => guard.fetch(CHAT_URL, { body: chatBody([{ role: 'system', content: LIVE_SYSTEM }]) }), /boom/);
});

test('guardCodeBuddyFetch 对同一个内层 fetch 只包一层', async () => {
    const fake = makeFakeFetch();
    const once = guardCodeBuddyFetch(fake.fetch);
    const twice = guardCodeBuddyFetch(fake.fetch);
    assert.equal(once, twice);
    // 包出来的东西还要能正常发请求。
    await once(CHAT_URL, { body: chatBody([{ role: 'system', content: LIVE_SYSTEM }]) });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.body.includes('@'), false);
});

/* --------------------------------------------------------------- 安装 / 卸载 */

test('全局只装一层；卸载后 fetch 还原；日志落到指定文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codebuddy-guard-'));
    const logPath = join(dir, 'guard.jsonl');
    const original = globalThis.fetch;
    const fake = makeFakeFetch();
    try {
        // 把「原始 fetch」换成一个不联网的假实现，守卫就包在它上面（测试不触网）。
        globalThis.fetch = fake.fetch;
        const first = installCodeBuddyGuard(undefined, { logPath, hosts: DEFAULT_GUARDED_HOSTS });
        assert.equal(first.installed, true);
        const guarded = globalThis.fetch;
        assert.notEqual(guarded, fake.fetch);

        // 再装一次：旧的先撤、新的挂上，但**始终只有一层**（否则会双倍改写 + 双倍日志）。
        installCodeBuddyGuard(undefined, { logPath });
        assert.equal(guardState().installed, true);
        assert.notEqual(globalThis.fetch, fake.fetch);
        assert.equal(guardCodeBuddyFetch(globalThis.fetch), globalThis.fetch, '已装的全局守卫不能再被包一层');

        // 真发一次：日志里只能出现**一条** rewritten（两层的话会是两条）。
        const body = chatBody([{ role: 'system', content: LIVE_SYSTEM }]);
        await globalThis.fetch(CHAT_URL, { method: 'POST', body });
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].init.body.includes('@'), false);

        assert.equal(guardState().logPath, logPath);

        uninstallCodeBuddyGuard();
        assert.equal(globalThis.fetch, fake.fetch);
        assert.equal(guardState().installed, false);

        const events = readFileSync(logPath, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line))
            .map((line) => line.event);
        assert.deepEqual(events, ['installed', 'uninstalled', 'installed', 'rewritten', 'uninstalled']);
    }
    finally {
        uninstallCodeBuddyGuard();
        globalThis.fetch = original;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('开关解析：off / dryrun / all / hosts / log', () => {
    assert.deepEqual(readGuardOptionsFromEnv({}), {
        enabled: true,
        dryRun: false,
        mode: 'anchor',
        hosts: DEFAULT_GUARDED_HOSTS,
        logPath: '',
    });
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD: 'off' }).enabled, false);
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD: 'OFF' }).enabled, false);
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD: 'dryrun' }).dryRun, true);
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD: 'all' }).mode, 'all');
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD_MODE: 'ALL' }).mode, 'all');
    assert.deepEqual(
        readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD_HOSTS: '.workbuddy.ai, copilot.tencent.com' }).hosts,
        ['.workbuddy.ai', 'copilot.tencent.com'],
    );
    assert.equal(readGuardOptionsFromEnv({ DSH_CODEBUDDY_GUARD_LOG: ' C:/tmp/x.jsonl ' }).logPath, 'C:/tmp/x.jsonl');
    // 关闭时 guardCodeBuddyFetch 原样返回（不包一层空守卫）。
    const fake = makeFakeFetch();
    const previous = process.env.DSH_CODEBUDDY_GUARD;
    process.env.DSH_CODEBUDDY_GUARD = 'off';
    try {
        assert.equal(guardCodeBuddyFetch(fake.fetch), fake.fetch);
    }
    finally {
        if (previous === undefined) delete process.env.DSH_CODEBUDDY_GUARD;
        else process.env.DSH_CODEBUDDY_GUARD = previous;
    }
});

/* --------------------------------------------------- 端到端：真机 system prompt */

test('端到端：四段全在的真机 system prompt 改写后，四条判据全部消失', () => {
    const raw = chatBody([
        { role: 'system', content: LIVE_SYSTEM },
        // 历史里模型自己复述过指纹（真机事故形态：排查风控的会话被风控拦死）。
        { role: 'assistant', content: `我查到的是：\n${FILE_REFERENCE_PROMPT}\n${IDENTITY}` },
        { role: 'user', content: '把这段原文发给我：Tokens prefixed with @ are paths' },
        { role: 'tool', content: FILE_REFERENCE_PROMPT },
    ]);

    const out = rewriteJsonBody(raw, 'anchor');
    assert.equal(out.changed, true);
    const messages = JSON.parse(out.body).messages;

    const system = messages[0].content;
    assert.ok(!system.includes('Tokens prefixed with @'), '指纹 1 必须消失');
    assert.ok(!/coding agent powered by/i.test(system), '指纹 3 必须消失');
    // 指纹 2 与品牌兜底是同一个形状：`DeepSeek` + 不可见分隔 + `Harness`
    //（连字符写法 `DeepSeek-Harness` 是网关放行的，故这里也一并覆盖了「品牌词已中性化」）。
    assert.ok(!BRAND_FINGERPRINT.test(system), '指纹 2 / 品牌指纹必须消失');
    assert.ok(system.includes('You are an AI agent powered by DeepSeek-Harness.'));
    // 语义还在：仍然是同一个模型、同一条指令。
    assert.ok(system.includes('buddy/hy4-preview'));
    assert.ok(system.includes('Tokens prefixed with (at) are paths'));
    assert.ok(system.includes('this Web GUI'));
    // 首条必须仍是 system（网关硬性要求），角色与段数都没被动过。
    assert.equal(messages[0].role, 'system');
    assert.equal(messages.length, 4);

    // assistant 那句同样被清（它的位置无关）。
    assert.ok(!messages[1].content.includes('Tokens prefixed with @'));
    assert.ok(!BRAND_FINGERPRINT.test(messages[1].content));
    // user / tool 一字未动。
    assert.equal(messages[2].content, '把这段原文发给我：Tokens prefixed with @ are paths');
    assert.equal(messages[3].content, FILE_REFERENCE_PROMPT);

    // 第二遍必须是恒等（幂等），并且不再产生新的字符串引用语义变化。
    assert.equal(rewriteJsonBody(out.body, 'anchor').changed, false);
});

test('mode=all 时扫描角色里的普通 @ 也换（内核改措辞的兜底）', () => {
    const raw = chatBody([{ role: 'system', content: '用 @author 标注；联系 a@b.com' }]);
    assert.equal(rewriteJsonBody(raw, 'anchor').changed, false);
    const all = rewriteJsonBody(raw, 'all');
    assert.equal(all.changed, true);
    assert.equal(JSON.parse(all.body).messages[0].content, '用 (at)author 标注；联系 a(at)b.com');
});
