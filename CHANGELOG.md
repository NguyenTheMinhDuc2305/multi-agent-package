# Changelog

## [0.1.0]

- Extra login slots per provider, named like pi-multi-account: `/login` offers "Anthropic (account 2)", "OpenAI Codex (account 2)", …; each account is its own provider (`anthropic-account-2`) with its own token and the provider's models. One free entry is always offered; new logins are picked up within a few seconds.
- `/switch-account`: menu of the logged-in accounts of the current provider, or `/switch-account <account | number | label | next | prev>`. Keeps the model and the thinking level; refused while a turn is running. `/switch-account list` and `/switch-account label <account> [text]`.
- Footer shows the account in use when a provider has several logged in.
- Warning at startup when pi-multi-account is also loaded (same provider ids).
- Unit tests and `npm run e2e` (real Pi, fake accounts, fake Anthropic upstream).
