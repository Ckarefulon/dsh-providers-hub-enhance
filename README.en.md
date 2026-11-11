# 🐻 dsh-providers-hub-enhance

A **re-appliable patcher** that enhances
[dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub). It ships patch
descriptions, not patched files: after every plugin upgrade, run it again.

| Capability | Summary |
|---|---|
| **CodeBuddy fetch guard** | DeepSeek Harness' own prompt text trips Tencent's domestic gateway (`400 / 11128`); the guard rewrites four fingerprints at the fetch layer — for `copilot.tencent.com` only |
| **Raccoon daily check-in** | Also claims the **mobile login reward (+3000 credits)** upstream never implemented |
| **Resume after rate limiting** | When a turn dies on 429 / exhausted quota, a toggleable icon button appears on the error row and resumes the turn once the limit lifts; a switch in Jet Hub settings decides the default |
| **"Expiring first" switch** | A switch next to the account-panel title: when on, accounts whose **credits expire soonest** are moved to the top automatically — that is the quota you actually lose, unlike credential expiry, which mostly refreshes itself |

```bash
node patch.mjs          # apply
node patch.mjs --check  # dry run
node patch.mjs --revert # undo
```

> [!NOTE]
> Restart DeepSeek Harness after patching (host modules load at process start),
> then refresh the page.

## 1. CodeBuddy fetch guard (400 / 11128)

Talking to buddy (CodeBuddy, China) fails on the very first step with

```
400 ... code 11128 / "Illegal API invocation from an unapproved channel"
```

The gateway validates system / assistant content server-side. **DSH ships four of the
matching fingerprints by default**, and they are independent — fixing one does not help:

| # | Fingerprint | Where it comes from | Where it trips |
|---|---|---|---|
| 1 | `Tokens prefixed with @ are paths the user explicitly referenced…` | `@deepseek-ai/dsh-file-reference` | **any position** (system and assistant) |
| 2 | `You are an AI agent powered by DeepSeek⁻Harness.` | `@deepseek-ai/dsh-system-prompt` | **message start only** |
| 3 | `You are a coding agent powered by {model} model.` | `@deepseek-ai/dsh-web-app` (`personaPrefix`) | the `coding agent powered by` shape |
| 4 | `You are interacting with the user through the DeepSeek⁻Harness Web GUI…` / `Current DeepSeek⁻Harness Web GUI URL` | `@deepseek-ai/dsh-harness-dev-context` | same (at the system prompt's tail) |

(`⁻` is U+200B as shipped by the kernel.) The mechanism is ported wholesale from
[dsh-wb400-guard](https://github.com/curo22/dsh-wb400-guard), which established every row
by A/B testing the real gateway.

**What it does**: wraps `globalThis.fetch`, and for requests to `copilot.tencent.com` only,
rewrites `system` / `developer` / `assistant` content semantically:

1. the `@` inside the file-reference paragraph → `(at)`;
2. the leading identity sentence → `DeepSeek-Harness`;
3. `You are a coding agent powered by` → `running on` (model name preserved);
4. the two Web GUI sentences → `… through this Web GUI` / `Current Web GUI URL`;

plus a final pass that normalizes any leftover `DeepSeek` + invisible separator + `Harness`.

Guarantees (each one covered by a test): other hosts pass through **the same object
reference** untouched; `user` and `tool` messages are never modified; idempotent; fail-open;
stale `Content-Length` dropped; single install layer (`Symbol.for`); logs keep only
origin + path.

Switches (environment variables, no re-patching needed): `DSH_CODEBUDDY_GUARD=off|dryrun|all`,
`DSH_CODEBUDDY_GUARD_MODE=anchor|all`, `DSH_CODEBUDDY_GUARD_HOSTS=.workbuddy.ai,…`,
`DSH_CODEBUDDY_GUARD_LOG=<path>`. Logs default to
`<DSH_HOME>/jet-hub/codebuddy-guard.jsonl`.

Run `npm run verify` to answer "is the guard working right now" (wiring, real module
round-trip, install/uninstall). It makes no network requests.

It coexists with [dsh-wb400-guard](https://github.com/curo22/dsh-wb400-guard): both rewrite
the same four fingerprints on the same host, both are idempotent, so whichever layer runs
first wins and the other passes the request through unchanged. This patch does not depend
on that plugin being installed.

## 2. Resume after rate limiting

A turn interrupted by 429 / exhausted quota heals by itself — but nobody presses
"continue" for you, so the task simply stops. This patch adds:

1. **A toggleable icon button at the end of the error row**, only on rate-limit
   failures:
   - yellow clock icon + "解禁后自动继续" (armed): resume the turn at the reset time;
   - red cross icon + "不自动继续" (disarmed): do nothing, you resend manually.
   - one click flips between the two states.
2. **A switch at the top of Jet Hub settings** for the **default** of new interruptions,
   on by default. Records that already exist keep their own state (no retroactive
   changes) — you may have just toggled them individually.
3. **Survives restarts**: pending records live in
   `$DSH_HOME/jet-hub/rate-limit-resume.json`, because a rate limit often lasts an
   hour and that necessarily spans processes.

Judgement and trade-offs:

- **What counts as rate limiting**: `RATE_LIMIT` code / HTTP 429 (including an
  **empty-body 429**, common from gateways and CDNs) / `QUOTA` `ACCOUNT_QUOTA` /
  Chinese and English rate-limit and quota wording in the message.
- **How long to wait**: the most conservative of ① `providerRetryAfterMs` from the
  server, ② the **latest future** rate-limit mark for that provider+model in the
  account pool (max, because one model can be limited to different instants across
  accounts — better late than one second early), ③ a 1-hour fallback.
- **Re-checked before firing**: the host re-reads the pool and defers if still limited;
  deferrals are capped so a "reset time keeps moving" situation cannot loop forever.
- **When it gives up**: the session is no longer live (`no-live-agent`), the user sent
  a message, the host started a new turn, or delivery keeps failing.
- **The continuation never impersonates the user**: it carries its own source kind
  `rate-limit-resume` and is **never** written as `source.kind === 'user'` (that is
  the host's proof of direct human input, which `tool-goal` and friends rely on).

## 3. Raccoon daily check-in

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

See [docs/how-it-works.md](docs/how-it-works.md) for the protocol details.

## 4. "Expiring first" switch

A switch at the front of the account panel's action row. Once **on**, every time the panel
reads credit balances it automatically moves accounts whose credits expire soonest to the top.

**Why a switch and not a one-shot button.** A button means "I want this order right now", but
this preference keeps going stale: new packages enter the expiry window daily and others lapse.
You would have to remember to press it again. The switch means "keep it this way" — its state
lives in the host (`$DSH_HOME/jet-hub/expiry-first.json`), so it survives closing the panel and
restarting the host.

**Why credit expiry and not the "expires at" row.** The card shows two very different
deadlines: the credential's `expiresAt` (mostly auto-refreshable, so it usually costs you
nothing) and each credit package's `deductionEndTime` (once that instant passes, whatever is
left in the package is gone). The switch therefore sorts by the earliest *still usable* package
expiry, skipping empty packages, expired packages, and packages with no expiry at all (those are
permanent, not "about to expire").

- The order **is** the automatic account-selection priority, so it really rewrites the pool
  (`account.reorder`, the same record drag-and-drop writes) — not a view-only sort.
- Accounts without expiring credits stay at the bottom, keeping the relative order you dragged
  them into (stable sort).
- **Off by default**: it rewrites an order you created, so it must not do that unasked.
- Three "write nothing" red lines: nothing expiring can be computed (balance not read yet, query
  failed, or the provider has no expiry concept) → no write at all; already optimal → no write;
  the reorder call fails → log only, the balance reading is unaffected.
- It never fires a balance query of its own: the trigger is the balance read the panel already
  does. Press "刷新积分" to refresh immediately.

Only appears for providers whose accounts already have a credit row
(`supportsCreditBalance(provider)`).

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

## How it stays safe

See [patch-data.json](patch-data.json). Four modes:

| mode | Purpose | Guard |
|---|---|---|
| `file` | Whole-file replacement | Only for files byte-identical across versions; refuses when the target is neither a known original nor the patched version |
| `anchor` | Anchor replacement | Every anchor must match **exactly once**; 0 (version changed) or >1 hits aborts the whole run without writing |
| `anchor-asset` | Insert an asset block at an anchor | Same, plus a `marker` idempotency check |
| `create` | Create a module file the patch owns | Refuses when the target exists with unknown content; `--revert` only deletes records it created |

Plus: `.phc-orig` backups, a `.phc-created.json` manifest, and a post-write
`node --check` syntax pass that rolls back on failure (reported honestly, not
treated as a syntax error, when subprocesses are unavailable in restricted
environments).

> ⚠️ One file can be touched by **several** patch entries (the client bundle is).
> The patcher groups by **path** and applies them to one in-memory text — reading
> and writing per entry would make the later entry clobber the earlier one.

## License

[MIT](LICENSE)
