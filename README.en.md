# 🐻 dsh-providers-hub-enhance

A **re-appliable patcher** that enhances
[dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub). It ships patch
descriptions, not patched files: after every plugin upgrade, run it again.

It only patches what upstream **still lacks**:

| Capability | Summary |
|---|---|
| **Raccoon daily check-in** | Upstream says "no check-in endpoint" — that is a mis-probe. Also claims the **mobile login reward (+3000 credits)** upstream never implemented |
| **Resume after rate limiting** | When a turn dies on 429 / exhausted quota, a toggleable icon button appears on the error row and resumes the turn once the limit lifts; a switch in the Jet Hub settings dialog decides the default |

```bash
node patch.mjs          # apply
node patch.mjs --check  # dry run
node patch.mjs --revert # undo
```

> [!NOTE]
> Restart DeepSeek Harness after patching (host modules load at process start),
> then refresh the page.

## ⚠️ Two capabilities were removed in 2.0.0 (upstream now implements them)

| Formerly patched | Why it is gone |
|---|---|
| **CodeBuddy fetch guard** (rewrote four fingerprints to fix `400 / 11128`) | Upstream `lib/openai-gateway/tencent-fingerprint.js` now covers the **same four** fingerprints (it even documents the 2026-10-28 incident), and `buddy-growth` / `buddy-compensation` make **no raw HTTP calls** (no bypass path). Wrapping `globalThis.fetch` again would only add risk |
| **Account "expiring first" switch** (auto-reorder accounts by credit-package expiry) | Upstream now sorts by **credit expiry tier** (on by default) and ships a "strict manual order" switch to opt out. Mine duplicated it, and two orderings fighting each other is worse than one |

> Both retired because **upstream got better**, not because they stopped working. Still want them? Use 1.x.

## 1. Raccoon daily check-in

Upstream states Raccoon has no check-in endpoint. That conclusion comes from only probing
`/api/web/points/v1|v2` (where `sign_in` / `check_in` / `daily` / `claim` are indeed 404).
The real trigger lives on the **office** surface:

| Capability | Endpoint | Notes |
|---|---|---|
| Daily check-in | `GET /api/web/office/v3/setting_info` | Idempotent per day; also backfills missed days |
| Mobile login reward | `POST /api/web/mobile/v1/login/points/grant` | One-off **+3000**, independent of the desktop reward |

Observed on real accounts (2026-11-03): one trigger backfilled two missed days **plus**
today's 300 credits; accounts that had already claimed the desktop reward still got
`granted: true` on the mobile one.

It also fixes a silent credit-loss bug: upstream decides "login reward already claimed" from
the first 50 records of `/points/v1/bills`, which interleaves spending records — the more you
use it, the further the grant records get pushed out of the window, so the UI claims
"unclaimed" forever. This patch reads `/points/v2/bills?type=income` (grants only).

See [docs/how-it-works.md](docs/how-it-works.md) for the protocol details.

## 2. Resume after rate limiting

A turn interrupted by 429 / exhausted quota heals by itself — but nobody presses
"continue" for you, so the task simply stops. This patch adds:

1. **A toggleable icon button at the end of the error row**, only on rate-limit
   failures:
   - yellow clock icon + "解禁后自动继续" (armed): resume the turn at the reset time;
   - red cross icon + "不自动继续" (disarmed): do nothing, you resend manually.
   - one click flips between the two states.
2. **A switch in the Jet Hub settings dialog** ("中断后自动继续" section) for the
   **default** of new interruptions, on by default. Records that already exist keep their
   own state (no retroactive changes).
3. **Survives restarts**: pending records live in
   `$DSH_HOME/jet-hub/rate-limit-resume.json`, because a rate limit often lasts an
   hour and that necessarily spans processes.

Judgement and trade-offs:

- **What counts as rate limiting**: `RATE_LIMIT` code / HTTP 429 (including an
  **empty-body 429**) / `QUOTA` `ACCOUNT_QUOTA` / Chinese and English rate-limit and quota
  wording. ⚠️ providers-hub reports "every account for this model is rate-limited" as
  `QUOTA_EXCEEDED`, but that code is also shared by "insufficient credits" and
  "quota or auth failure" — so it is only a hint, and the message text decides.
- **How long to wait**: the most conservative of ① `providerRetryAfterMs` from the server,
  ② the **latest future** rate-limit mark for that provider+model in the account pool,
  ③ a 1-hour fallback. Only counts when **all enabled accounts** are limited (same rule as
  upstream `allAccountsRateLimitedForModel`).
- **Re-checked before firing**: the host re-reads the pool and defers if still limited;
  deferrals are capped so a "reset time keeps moving" situation cannot loop forever.
- **When it gives up**: the session is no longer live (`no-live-agent`), the user sent
  a message, the host started a new turn, or delivery keeps failing.
- **The continuation never impersonates the user**: it carries its own source kind
  `rate-limit-resume` and is **never** written as `source.kind === 'user'`.

## Install

Requires Node.js ≥ 18 and an installed `dsh-providers-hub`.

```bash
git clone https://github.com/Ckarefulon/dsh-providers-hub-enhance.git
cd dsh-providers-hub-enhance
node patch.mjs
```

The script finds the plugin under `~/.dsh/profiles/{desktop,web}`; otherwise:

```bash
node patch.mjs --profile desktop                          # profile name
node patch.mjs --dir "C:/Users/me/.dsh/profiles/desktop"  # profile or package dir
```

Tested against:

| Plugin version | Result |
|---|---|
| `2.22.261111` | ✅ all 12 patch entries apply in one run, `--check` reports "everything in place", `--revert` restores cleanly |
| Earlier `1.x` releases | ❌ Not supported — the client anchor (the settings dialog) only exists in 2.22. For the two features removed here, use this project's **1.x** tags |

## How it stays safe

See [patch-data.json](patch-data.json). Four modes:

| mode | Purpose | Guard |
|---|---|---|
| `file` | Whole-file replacement | Only for files byte-identical across versions; refuses when the target is neither a known original nor the patched version |
| `anchor` | Anchor replacement | Every anchor must match **exactly once**; 0 (version changed) or >1 hits aborts the whole run without writing |
| `anchor-asset` | Insert an asset block at an anchor | Same, plus a `marker` idempotency check |
| `create` | Create a module file the patch owns | Refuses when the target exists with unknown content; `--revert` only deletes records it created |

Plus: `.phc-orig` backups, a `.phc-created.json` manifest, and **two in-process checks**
after writing (either failing rolls everything back):

- **syntax** (`scripts/syntax-check.mjs`);
- **wiring** (`scripts/wiring-check.mjs`) — see below.

> ⚠️ One file can be touched by **several** patch entries (the client bundle is).
> The patcher groups by **path** and applies them to one in-memory text.
> This also applies to **anchors**: two entries in the same file must not anchor on lines
> that fall inside each other's `replace` range, or the second run can never reach
> "already applied".

## Why there is a wiring check

An earlier version inserted `installExpiryFirst(ctx, pool);` into `lib/index.js` but the
matching `import` got lost during a scripted rewrite of `patch-data.json`. The result was
not "the feature does nothing" but:

```
apply() throws ReferenceError: installExpiryFirst is not defined
  ⇒ the later registerJetHubRpc(...) in the same function never ran
  ⇒ the whole /api/jet-hub channel 404s (every panel reports "transport failure")
```

None of the three existing defences could catch it: the **syntax check only compiles** (it
does not resolve identifiers — `f()` with `f` undefined is a *runtime* error), every anchor
matched, and the unit tests cover the asset module, not "the asset after being imported
into the host".

`scripts/wiring-check.mjs` fills that gap: every call to a function this patch owns must be
imported or defined in the same final file, otherwise the write is rolled back. The rule is
deliberately narrow (only our own names, never guessing at upstream code).

## FAQ

**Why are two features missing in 2.0.0?**
Upstream 2.22 implements them (see the table at the top). A patch should only supply what
upstream lacks; two implementations fighting each other is worse than one.

**Check-in says "每日积分触发失败"?**
Usually an expired credential. The plugin refreshes it; if it keeps failing, log that
account in again from the panel.

**Check-in says "今日已到账" but the balance looks unchanged?**
Daily credits are a *daily* allowance and get consumed first. Billing also lags: pulling
the bills immediately after triggering will not show today's entry — this patch compares
balance before/after precisely to dodge that lag.

**Can it double-claim?**
No. The trigger endpoint is idempotent per day, and each login reward is claimable once per
account per platform (`granted:false` afterwards).

**Can I uninstall it?**
```bash
node patch.mjs --revert
```
Then restart DSH.

## License

[MIT](LICENSE)
