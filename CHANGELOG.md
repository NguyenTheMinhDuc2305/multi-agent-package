# Changelog

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
