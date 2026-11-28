# custom-multi-account-package

Several logins per provider for [Pi](https://pi.dev/), with **account pools**: you choose the account, and when it runs out (limit, billing, expired login) the request goes to the next account of the pool by itself and the session stays there. Also **`/switch-account`** to change account yourself, **`/usage`** for the plan usage of every account, **`/label-account`** to note who each account is, and the **`anthropic_web_search`** tool on your Anthropic API keys.

```text
/login → "Anthropic (account 2)"        log in a second Claude account (it joins the pool)
/label-account 2 Work me@company.com    note its name and email
/pool                                   pools, cooldowns, who uses which account
/usage                                  5-hour and weekly usage of every account
/switch-account work                    use that account (by name, number, id…)
/switch-account next                    the next account of the pool
```

Account naming and the "each account is its own provider" approach follow [pi-multi-account](https://github.com/Sarrius/pi-multi-account) (MIT).

## Install

```bash
pi -e /path/to/custom-multi-account-package                           # current local checkout, one run only
pi install /path/to/custom-multi-account-package                      # current local checkout
pi install git:github.com/NguyenTheMinhDuc2305/multi-account-package     # remote main, after changes are pushed
```

The no-load-balancing policy below is new in **0.3.1**. Older tags (including v0.3.0) still spread agents across accounts. Local changes must be pushed before GitHub installs receive them. Do not load a local and GitHub copy together.

Requires Pi 1.6 (Node ≥ 22.19). Do not install it together with `pi-multi-account` or `pi-account-pools`: they register their own account providers (a warning is shown at startup if one of them is loaded too).

Works with [custom-pi-subagent-package](https://github.com/NguyenTheMinhDuc2305/pi-subagent-package): its agents take accounts from the pools (see [Agents](#agents)).

## Usage

### Add accounts

Account 1 is Pi's own login (`anthropic`, `openai-codex`). Extra accounts appear in `/login`:

```text
/login → Anthropic (account 2)          → provider anthropic-account-2
/login → OpenAI Codex (account 2)       → provider openai-codex-account-2
```

There is always one free entry; after you log in, the next one (account 3) appears. Open the login link in a private browser window so the browser does not reuse the account you are already signed in with. A slot can hold a subscription login or an API key.

### Pools

Every model belongs to one pool of accounts. Without any setup:

| Pool | Accounts | Serves |
|---|---|---|
| `anthropic` | every Anthropic login: subscriptions first (by account number), then API keys | every Anthropic model |
| `openai-codex` | every Codex login | every Codex model |
| `anthropic-search` | the Anthropic **API keys** only | the `anthropic_web_search` tool |

These pools are **automatic**: a new login joins them. Once you edit a pool it is written to `multiple-account.json` and keeps exactly the accounts you give it.

Chat with an API key is billed per token; that is why API keys come last in the chat pool. Messages say `(API key, billed per token)` when a session moves to one. Take them out of the chat pool with `/pool remove anthropic <account>` if you never want that.

| Command | Effect |
|---|---|
| `/pool` | Every pool: accounts by priority, subscription/API key, cooldowns, who uses each account (this session, an agent, another Pi window) |
| `/pool add <pool> <account> [priority]` | Add an account (last, or at that priority) |
| `/pool remove <pool> <account>` | Take an account out |
| `/pool priority <pool> <account> <n>` | Lower = used first |
| `/pool new <pool> <account> [account …] --models m1,m2` | A pool for some models only; they leave the default pool |
| `/pool models <pool> m1,m2` / `+m3,-m1` / `none` | Change the models of such a pool |
| `/pool default <pool> on\|off` | Make a pool the default of its provider (takes every model no other pool claims) |
| `/pool delete <pool>` | Delete a pool; a provider's own pool goes back to following the logins |
| `/pool tool anthropic_web_search off\|on` | Turn the search tool off / back on |
| `/pool clear [account]` | Forget cooldowns |
| `/pool help` | All of the above |

Rules: a model belongs to one pool; an account can be in several pools (with a priority in each); a pool holds the accounts of one provider. Every edit is checked before it is saved. Tab completes pools, accounts and model ids. From a shell (PowerShell): `pi -p "/pool add anthropic anthropic-account-3 1"`.

### When an account runs out

You pick the account (`/switch-account`, or `/model` → `anthropic-account-2/…`). When a request on it is refused because of the account:

| Refusal | Switch? |
|---|---|
| 429 / usage or rate limit | yes |
| 402 billing | yes |
| 401 expired or revoked login | yes |
| 403 / 404 for that model | yes |
| 5xx, 529 overloaded (the provider's side) | no: the error is shown as usual |

then:

1. The account gets a **cooldown** (the time the provider gives, else 5 minutes doubling up to 60; 10 minutes for a login problem, 60 for billing).
2. The **same request** is sent again on the next account of the model's pool (by priority, wrapping around, accounts cooling down skipped). You see no error, only a message:
   `anthropic-account-2 (Work) → anthropic-account-3 (rate_limit (429)). This session now uses anthropic-account-3.`
3. The session **stays** on the new account, as if you had typed `/switch-account next`: it does not go back when the old account recovers. `/switch-account list` shows ● on the new account, and a resumed session continues there.

If every account of the pool is refused, one error lists each account and when it can be used again. Cooldowns are shared by every Pi window and agent on the machine, so an account that ran out in one place is skipped everywhere.

A failure after the answer has started streaming cannot be hidden; it is shown, and the account still gets its cooldown so the next request avoids it.

### Switch

| Command | Effect |
|---|---|
| `/switch-account` | Menu of the logged-in accounts of the current provider (● marks the one in use) |
| `/switch-account anthropic-account-2` | Switch to that account |
| `/switch-account 2` (or `account-2`) | Same, by account number |
| `/switch-account work` | Same, by name or email (see `/label-account`) |
| `/switch-account next` / `prev` | Next / previous account of the model's pool (accounts cooling down are skipped while others are ready) |
| `/switch-account list` | Every account, the one in use, and the next free `/login` entry |

The switch keeps the **same model** and the session's **thinking level**; only the account changes. It is refused while Pi is working on a turn (wait, or press Esc first). To change provider (e.g. Anthropic → Codex), use `/model`.

### Agents

With [custom-pi-subagent-package](https://github.com/NguyenTheMinhDuc2305/pi-subagent-package), each agent has its own Pi SDK session (not a new terminal window). Its model selects a pool; account routing behaves like the main session, **without load balancing**:

1. A new agent takes the first ready, logged-in account by pool priority.
2. Later runs keep its last account while it belongs to the pool, is logged in and is not cooling down — **even if the main session, another agent or another Pi window also uses it**.
3. On an account-specific failure, try the next account in pool order, wrapping around and placing cooling accounts last, just like the main session. If the previous account was removed or logged out, choose by pool priority again. When all accounts are cooling, try the soonest-recovering one as a last resort.
4. After A → B, subsequent requests and later agent calls stay on B. A recovering is NOT a reason to switch back. The last account is remembered across normal Pi restarts via the shared state file (not a hard pin that prevents failover).

Several agents may therefore share one account. This avoids account changes just to redistribute work and improves the opportunity for prompt-cache reuse; cache hits are not guaranteed. The row reports automatic changes, e.g. `⇄ anthropic-account-2 → anthropic-account-3 (rate_limit (429))`. `/pool` still shows occupancy, but occupancy does not decide routing.

**Unresolved design — load balancing (logic not yet settled / chưa rõ logic):** how to balance account utilization against per-session cache reuse is not decided. Automatic spreading/free-account/least-used selection has been removed. Do not assume parallel agents get different accounts. Reintroducing balancing requires an explicit policy and tests; it is not part of the current behavior.

Other extensions can do the same through `pi.events` (`multiple-account:acquire`, `…:release`, `…:pool-of`, `…:switched`; see `extensions/index.ts`).

### anthropic_web_search

Anthropic's web search (server tool of the Messages API), for the model to call: it returns an answer with cited sources. It runs on the accounts of `anthropic-search`, which takes **Anthropic API keys only** (log one in: `/login` → a free "Anthropic (account N)" → API key). Subscription logins are never used for it. The tool is offered to the model only while that pool has a logged-in account; turn it off with `/pool tool anthropic_web_search off`. Each call costs the API key's search and token prices (model `claude-haiku-5-5`, at most 5 searches per call by default).

### Name and email

| Command | Effect |
|---|---|
| `/label-account` | Menu: pick an account, type its name and email (empty = keep, `-` = clear) |
| `/label-account anthropic-account-2 Work me@company.com` | Name and email in one go (the word with `@` is the email) |
| `/label-account 2 Work` | By account number of the session's provider |
| `/label-account anthropic name Duc Nguyen` | Only the name |
| `/label-account anthropic email me@example.com` | Only the email |
| `/label-account anthropic-account-2 clear` | Forget both |

The name and email appear in `/login` (`Anthropic (account 2 · Work · me@company.com)`), `/switch-account`, `/usage`, `/pool` and the switch messages. You type them yourself: the package does not read them from the provider, so check the email on the sign-in page when you log in. Logging the **same** Claude account into two slots can make the provider revoke the older slot's token (`401 … has been revoked`).

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
- The request step of every account (account 1 included) goes through the model's pool. Events are held back until the first content arrives, so a refused attempt is replaced by the next account without the session seeing it. Only the request step is replaced; models, logins and everything else stay Pi's.
- The session follows: once the run is over, the package selects the same model on the new account (`pi.setModel`), which Pi records in the session.
- Shared state, next to the settings: `multiple-account-cooldowns.json` (cooldowns) and `multiple-account-leases.json` (which session or agent uses which account; entries of closed or crashed Pi processes are ignored).
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
  "families": ["anthropic", "openai-codex"],
  "pools": {
    "anthropic": { "default": true, "members": [{ "account": "anthropic-account-2", "priority": 1 }, { "account": "anthropic", "priority": 2 }] },
    "fable":     { "models": ["claude-fable-5-2"], "members": [{ "account": "anthropic-account-3", "priority": 1 }] }
  },
  "tools": { "anthropic_web_search": { "pool": "anthropic-search", "model": "claude-haiku-5-5", "maxSearches": 5 } },
  "fallbackCooldownMinutes": 5,
  "maxCooldownMinutes": 60
}
```

Every key is optional; the `/pool` and `/label-account` commands write this file for you.

- `accounts`: name and email of each account. (The 0.1 `"labels"` entries are still read, as names.)
- `families`: built-in providers that get extra accounts (default: `anthropic`, `openai-codex`).
- `pools`: pools you have edited. A pool not listed follows the logins. `default: true` takes every model of its provider that no other pool lists in `models`.
- `tools`: `anthropic_web_search` → its pool, model and searches per call, or `false` (off).
- `fallbackCooldownMinutes` / `maxCooldownMinutes`: cooldown after a limit without a time from the provider, doubling up to the maximum.

## Limits

- `/model` lists the models once per logged-in account.
- Settings in `models.json` for the base provider (e.g. a custom `baseUrl`) do not apply to `anthropic-account-N`; add them for each account id.
- Extensions that call the provider themselves use whichever account they were written for, not the session's (and not the pool).
- The interactive menus (`/switch-account`, `/label-account` without arguments) have not been tested in an automated way (they need the TUI); the command paths with arguments are covered by `npm run e2e`.
- `/usage` relies on the providers' own usage endpoints; if a provider changes them, the affected account shows an error instead of numbers.
- Two Pi windows recording a cooldown at the same instant can lose one of the two writes; the next refused request records it again.
- Rotating several subscription accounts may break a provider's terms of service; check them yourself.

## Manual testing

See the shared [testing guide](https://github.com/NguyenTheMinhDuc2305/pi-subagent-package/blob/main/TESTING.md) for isolated configuration, manual switching, persistent agent sessions, parallel runs, fake-upstream failover checks, and the separate live BrowserMCP compatibility diagnostic. The multi-account E2E currently has one known cooldown-duration failure (`Retry-After`); other checks pass.

## Development

```bash
npm install
npm run check      # tsc --noEmit
npm test           # unit tests
npm run e2e        # real pi + fake accounts + fake upstream (no real account needed)
```

```
extensions/index.ts   Pi glue: account providers, routing through pools, commands, agents (pi.events)
src/slots.ts          account ids (anthropic, anthropic-account-2, …)                   (pure)
src/accounts.ts       account provider cloned from the built-in provider
src/pools.ts          pools: automatic ones, validation, which pool serves a model      (pure)
src/pool-edit.ts      /pool add|remove|priority|new|models|default|delete|tool           (pure)
src/pool-status.ts    /pool output                                                     (pure)
src/pick.ts           which account: failover order, agents' choice, next/prev          (pure)
src/router.ts         one request through a pool: hidden retries, cooldowns            (pure; upstream injected)
src/classify.ts       which errors move to the next account                             (pure)
src/cooldown.ts       cooldowns                                                         (pure; store injected)
src/leases.ts         who uses which account                                            (pure; store injected)
src/state-file.ts     shared JSON state files
src/search/           anthropic_web_search
src/switch.ts         which account an argument means, names/emails                    (pure)
src/label.ts          /label-account arguments                                          (pure)
src/usage.ts          usage endpoints, parsing, /usage output                           (pure; fetch injected)
src/config.ts         multiple-account.json
src/format.ts         /switch-account list output                                      (pure)
scripts/e2e.mjs       end-to-end check
```

## License

MIT
