# pi-multiple-account-package

Several logins per provider for [Pi](https://pi.dev/), **`/switch-account`** to move the current session to another account whenever you want, **`/usage`** to see the plan usage of every account, and **`/label-account`** to note who each account is.

```text
/login → "Anthropic (account 2)"        log in a second Claude account
/label-account 2 Work me@company.com    note its name and email
/usage                                  5-hour and weekly usage of every account
/switch-account                         pick the account (menu)
/switch-account work                    …or name it
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
| `/switch-account work` | Same, by name or email (see `/label-account`) |
| `/switch-account next` / `prev` | Next / previous logged-in account, wrapping around |
| `/switch-account list` | Every account, the one in use, and the next free `/login` entry |

From a shell: `pi -p "/switch-account list"`.

The switch keeps the **same model** and the session's **thinking level**; only the account changes. It is refused while Pi is working on a turn (wait, or press Esc first). To change provider (e.g. Anthropic → Codex), use `/model`.

### Name and email

| Command | Effect |
|---|---|
| `/label-account` | Menu: pick an account, type its name and email (empty = keep, `-` = clear) |
| `/label-account anthropic-account-2 Work me@company.com` | Name and email in one go (the word with `@` is the email) |
| `/label-account 2 Work` | By account number of the session's provider |
| `/label-account anthropic name Duc Nguyen` | Only the name |
| `/label-account anthropic email me@example.com` | Only the email |
| `/label-account anthropic-account-2 clear` | Forget both |

The name and email appear in `/login` (`Anthropic (account 2 · Work · me@company.com)`), `/switch-account`, `/usage` and the login messages. You type them yourself: the package does not read them from the provider, so check the email on the sign-in page when you log in. Logging the **same** Claude account into two slots can make the provider revoke the older slot's token (`401 … has been revoked`).

### Usage

`/usage` checks every logged-in account at once:

```text
Usage (● = this session)

Anthropic
  anthropic · Personal
    5h session ██████████ 100% used · resets in 3h 14m  ← limit reached
    7d weekly  ██████░░░░  59% used · resets in 5d 21h
● anthropic-account-2 · Work · me@company.com
    5h session ████░░░░░░  44% used · resets in 4h 24m
    7d weekly  ██░░░░░░░░  17% used · resets in 2d 20h
  anthropic-account-3
    login expired or revoked (HTTP 401: …) → /login → "Anthropic (account 3)"

OpenAI Codex
  openai-codex · Plus · me@gmail.com
    5h session ░░░░░░░░░░   4% used · resets in 4h 11m
    7d weekly  ██░░░░░░░░  16% used · resets in 6d 4h
```

- Claude subscription logins: the 5-hour session and weekly windows, from the same endpoint Claude Code's `/usage` reads (`/api/oauth/usage`).
- Codex (ChatGPT) logins: the same windows plus the plan, from the endpoint Codex CLI reads (`/backend-api/wham/usage`).
- API keys are billed per token and have no plan windows; they are listed as such and never sent to a usage endpoint.
- A dead login (expired or revoked) is shown with the `/login` entry that renews it. Read-only requests, one per account; each token goes only to the provider that issued it.

From a shell: `pi -p "/usage"`.

## How it works

- Each extra account is its own Pi provider, cloned from the built-in one: own `/login` entry, own token in `auth.json`, own token refresh (all handled by Pi), and the same models under its own id (`anthropic-account-2/claude-opus-…`).
- `/switch-account` selects the same model on the other account (`pi.setModel`). Pi records the change in the session, so a resumed session continues on that account.
- Because the provider changes, Pi does not resend the previous account's thinking blocks, and the prompt cache starts again on the new account.
- An API-key account uses only its own stored key, never `ANTHROPIC_API_KEY` from the environment.

## Configuration (optional)

`~/.pi/agent/multiple-account.json` (or `$PI_CODING_AGENT_DIR/multiple-account.json`):

```json
{
  "accounts": {
    "anthropic":           { "name": "Personal", "email": "me@example.com" },
    "anthropic-account-2": { "name": "Work",     "email": "me@company.com" }
  },
  "families": ["anthropic", "openai-codex"]
}
```

- `accounts`: name and email of each account, shown in `/login`, `/switch-account` and `/usage`. Easiest to set with `/label-account`. (The 0.1 `"labels"` entries are still read, as names.)
- `families`: built-in providers that get extra accounts (default: `anthropic`, `openai-codex`).

## Limits

- `/model` lists the models once per logged-in account.
- Settings in `models.json` for the base provider (e.g. a custom `baseUrl`) do not apply to `anthropic-account-N`; add them for each account id.
- Extensions that call the provider themselves use whichever account they were written for, not the session's.
- The interactive menus (`/switch-account`, `/label-account` without arguments) have not been tested in an automated way (they need the TUI); the command paths with arguments are covered by `npm run e2e`.
- `/usage` relies on the providers' own usage endpoints; if a provider changes them, the affected account shows an error instead of numbers.
- Rotating several subscription accounts may break a provider's terms of service; check them yourself.

## Development

```bash
npm install
npm run check      # tsc --noEmit
npm test           # unit tests
npm run e2e        # real pi + fake accounts + fake upstream (no real account needed)
```

```
extensions/index.ts   Pi glue: account providers, login polling, /switch-account, /label-account, /usage
src/slots.ts          account ids (anthropic, anthropic-account-2, …)                 (pure)
src/accounts.ts       account provider cloned from the built-in provider
src/switch.ts         which account an argument means, next/prev, names/emails       (pure)
src/label.ts          /label-account arguments                                      (pure)
src/usage.ts          usage endpoints, parsing, /usage output                       (pure; fetch injected)
src/config.ts         multiple-account.json (accounts, families)
src/format.ts         /switch-account list output                                  (pure)
scripts/e2e.mjs       end-to-end check
```

## License

MIT
