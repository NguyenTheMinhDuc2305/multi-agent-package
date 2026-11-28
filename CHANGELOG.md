# Changelog

## [0.3.1]

- Removed agent load balancing: keep the previous usable account even when shared; new agents select by pool priority. Agent failover now follows the same sequential pool order as the main session, not free/least-used accounts. Recovery of an earlier account does not move a session back.
- README marks load balancing as unresolved design (logic not yet settled); occupancy remains visible in `/pool` but no longer affects routing.
- Regression tests cover shared-account affinity, priority, cooldowns, pool changes and recovery without returning to the earlier account.
- Known issue unchanged: the Pi 1.6 Anthropic E2E reports a fallback ~5-minute cooldown instead of the simulated `Retry-After: 120`; that check still fails.

- Package renamed from `pi-multiple-account-package` to `custom-multi-account-package` (GitHub repository: `multi-account-package`). Commands, `multiple-account.json` and the `pi.events` channels used by custom-pi-subagent-package are unchanged.

## [0.3.0]

- Account pools. Every model belongs to one pool of accounts; by default one pool per provider with every login (subscriptions first, then API keys), following the logins until you edit it. `/pool` shows the pools, cooldowns and who uses which account; `/pool add|remove|priority|new|models|default|delete|tool|clear` edit them (validated, saved in `multiple-account.json`).
- Automatic `switch-account next`: when a request is refused for a limit, billing, an expired or revoked login, or model access (429/402/401/403/404), it is sent again on the next account of the model's pool (cooling accounts skipped) without showing the error, and the session stays on that account. Provider-side errors (5xx, 529) are not switched. When every account is refused, one error lists each account and when it is usable again.
- Cooldowns and account use are shared by every Pi window and agent on the machine (`multiple-account-cooldowns.json`, `multiple-account-leases.json`).
- `/switch-account next|prev` follow the model's pool and skip accounts cooling down.
- Agents (pi-subagent-package): accounts per run from the model's pool through `pi.events` (`multiple-account:acquire|release|pool-of|switched`): the agent's previous account when free, else a free one, else the least used; agents switch accounts the same way.
- `anthropic_web_search` tool (moved from pi-account-pools): Anthropic web search on the API keys of pool `anthropic-search` only; offered to the model only while that pool has a logged-in account.
- Warning when pi-account-pools is loaded too.

## [0.2.1]

- Fixed: a name or email set with `/label-account` in one session did not show up in other open sessions until they restarted. Every session now re-reads `multiple-account.json` when it changes (checked every few seconds, on each prompt and at the start of each command), including the `/login` entry names.
- e2e: an already-open session (RPC mode) sees a name set by another session.

## [0.2.0]

- `/usage`: 5-hour and weekly plan usage of every logged-in account (Claude subscription and Codex logins), with reset times, the account in use, "limit reached", API keys marked as per-token, and expired/revoked logins shown with the /login entry that renews them.
- `/label-account`: note each account's name and email (menu, or `/label-account <account> <name> [email]`, `name …`, `email …`, `clear`). Shown in /login, /switch-account and /usage; `/switch-account` also accepts a name or email.
- Removed the footer line (`account: … (2/3)`).
- Settings: `"accounts": { "<id>": { "name", "email" } }`; the 0.1 `"labels"` are still read as names. `/switch-account label` still works.

## [0.1.0]

- Extra login slots per provider, named like pi-multi-account: `/login` offers "Anthropic (account 2)", "OpenAI Codex (account 2)", …; each account is its own provider (`anthropic-account-2`) with its own token and the provider's models. One free entry is always offered; new logins are picked up within a few seconds.
- `/switch-account`: menu of the logged-in accounts of the current provider, or `/switch-account <account | number | label | next | prev>`. Keeps the model and the thinking level; refused while a turn is running. `/switch-account list` and `/switch-account label <account> [text]`.
- Footer shows the account in use when a provider has several logged in.
- Warning at startup when pi-multi-account is also loaded (same provider ids).
- Unit tests and `npm run e2e` (real Pi, fake accounts, fake Anthropic upstream).
