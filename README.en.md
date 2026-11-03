# 🐻 dsh-raccoon-checkin

Adds a working **daily check-in** for the **Raccoon (SenseTime 小浣熊)** channel of
[dsh-providers-hub](https://www.npmjs.com/package/dsh-providers-hub) — and claims the
**mobile login reward (+3000 credits)** that upstream never implemented.

The patch touches built artifacts inside `node_modules`, so this project ships a
**re-appliable patcher** instead of patched files: after every plugin upgrade, run it again.

```bash
node patch.mjs          # apply
node patch.mjs --check  # dry run
node patch.mjs --revert # undo
```

> [!NOTE]
> Restart DeepSeek Harness after patching (host modules are loaded at process start).
> Refresh the page afterwards — the Raccoon card then shows the claim button.

## Why

Upstream states Raccoon has no check-in endpoint. That conclusion comes from only
probing `/api/web/points/v1|v2` (where `sign_in` / `check_in` / `daily` / `claim` are indeed 404).
The real trigger lives on the **office** surface:

| Capability | Endpoint | Notes |
|---|---|---|
| Daily check-in | `GET /api/web/office/v3/setting_info` | Idempotent per day; also backfills missed days |
| Mobile login reward | `POST /api/web/mobile/v1/login/points/grant` | One-off **+3000**, independent of the desktop reward |

Observed on real accounts (2026-11-03): one trigger backfilled two missed days **plus** today's
300 credits; accounts that had already claimed the desktop reward still got `granted: true`
on the mobile one.

See [docs/how-it-works.md](docs/how-it-works.md) for the protocol details.

## Install

Requires Node.js ≥ 18 and an installed `dsh-providers-hub`.

```bash
git clone https://github.com/Ckarefulon/dsh-raccoon-checkin.git
cd dsh-raccoon-checkin
node patch.mjs
```

The patcher auto-detects `~/.dsh/profiles/{desktop,web}`; otherwise pass
`--profile <name>` or `--dir <path>`.

## After a plugin upgrade

`node_modules` is replaced wholesale, so the patch disappears — run `node patch.mjs` again.
The patcher is idempotent and reports “already applied” for untouched files.

Verified against `dsh-providers-hub@1.6.261016` and `2.13.261102`.

## Safety

- Whole-file replacements are guarded by SHA256: unknown content is never overwritten.
- Anchor edits must match **exactly once**; otherwise nothing is written.
- Originals are kept as `<file>.rcc-orig` (`--revert` restores them).
- A `node --check` syntax pass runs after writing; on failure the patcher rolls back.

## Disclaimer

Unofficial local patch. Not affiliated with SenseTime, DeepSeek Harness, or the
`dsh-providers-hub` author. No credentials are shipped. Use at your own risk.

## License

[MIT](LICENSE) — see [NOTICE.md](NOTICE.md) for third-party attribution.
