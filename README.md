# pi-multiple-account-package

Several logins per provider for [Pi](https://pi.dev/), and **`/switch-account`** to move the current session to another account whenever you want.

```text
/login → "Anthropic (account 2)"        log in a second Claude account
/switch-account                         pick the account (menu)
/switch-account anthropic-account-2     …or name it
```

Nothing switches by itself: there is no automatic failover or rotation. You decide when to change account.

Account naming and the "each account is its own provider" approach follow [pi-multi-account](https://github.com/Sarrius/pi-multi-account) (MIT); this package keeps only the manual switch.

## Install

```bash
pi install /path/to/pi-multiple-account-package     # permanent, loaded from that folder
pi -e /path/to/pi-multiple-account-package          # one run only
```

Requires Pi 1.6 (Node ≥ 22.19). Do not install it together with `pi-multi-account`: both register the same `anthropic-account-N` providers (a warning is shown at startup if both are loaded).

## Usage

### Add accounts

Account 1 is Pi's own login (`anthropic`, `openai-codex`). Extra accounts appear in `/login`:

```text
/login → Anthropic (account 2)          → provider anthropic-account-2
/login → OpenAI Codex (account 2)       → provider openai-codex-account-2
```

There is always one free entry; after you log in, the next one (account 3) appears. Open the login link in a private browser window so the browser does not reuse the account you are already signed in with.

### Switch

| Command | Effect |
|---|---|
| `/switch-account` | Menu of the logged-in accounts of the current provider (● marks the one in use) |
| `/switch-account anthropic-account-2` | Switch to that account |
| `/switch-account 2` (or `account-2`) | Same, by account number |
| `/switch-account work` | Same, by label |
| `/switch-account next` / `prev` | Next / previous logged-in account, wrapping around |
| `/switch-account list` | Every account, the one in use, and the next free `/login` entry |
| `/switch-account label anthropic-account-2 work` | Name an account (`label <account>` alone clears it) |

From a shell: `pi -p "/switch-account list"`.

The switch keeps the **same model** and the session's **thinking level**; only the account changes. It is refused while Pi is working on a turn (wait, or press Esc first). To change provider (e.g. Anthropic → Codex), use `/model`.

When a provider has two or more accounts logged in, the footer shows which one the session uses, e.g. `account: anthropic-account-2 (work) (2/3)`.

## How it works

- Each extra account is its own Pi provider, cloned from the built-in one: own `/login` entry, own token in `auth.json`, own token refresh (all handled by Pi), and the same models under its own id (`anthropic-account-2/claude-opus-…`).
- `/switch-account` selects the same model on the other account (`pi.setModel`). Pi records the change in the session, so a resumed session continues on that account.
- Because the provider changes, Pi does not resend the previous account's thinking blocks, and the prompt cache starts again on the new account.
- An API-key account uses only its own stored key, never `ANTHROPIC_API_KEY` from the environment.

## Configuration (optional)

`~/.pi/agent/multiple-account.json` (or `$PI_CODING_AGENT_DIR/multiple-account.json`):

```json
{
  "labels": { "anthropic": "personal", "anthropic-account-2": "work" },
  "families": ["anthropic", "openai-codex"]
}
```

- `labels`: names shown in `/login`, `/switch-account` and the footer. Easiest to set with `/switch-account label`.
- `families`: built-in providers that get extra accounts (default: `anthropic`, `openai-codex`).

## Limits

- `/model` lists the models once per logged-in account.
- Settings in `models.json` for the base provider (e.g. a custom `baseUrl`) do not apply to `anthropic-account-N`; add them for each account id.
- Extensions that call the provider themselves use whichever account they were written for, not the session's.
- The interactive menu and the footer have not been tested in an automated way (they need the TUI); the command paths with arguments are covered by `npm run e2e`.
- Rotating several subscription accounts may break a provider's terms of service; check them yourself.

## Development

```bash
npm install
npm run check      # tsc --noEmit
npm test           # unit tests
npm run e2e        # real pi + fake accounts + fake Anthropic upstream (no real account needed)
```

```
extensions/index.ts   Pi glue: account providers, login polling, footer, /switch-account
src/slots.ts          account ids (anthropic, anthropic-account-2, …)        (pure)
src/accounts.ts       account provider cloned from the built-in provider
src/switch.ts         which account an argument means, next/prev, labels  (pure)
src/config.ts         multiple-account.json (labels, families)
src/format.ts         /switch-account list output                         (pure)
scripts/e2e.mjs       end-to-end check
```

## License

MIT
