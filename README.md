# pi-codex-multi

Pi extension exclusively for ChatGPT Plus/Pro subscriptions through OpenAI Codex OAuth. Add multiple Codex accounts and rotate them through failover pools.

## Install

Install from npm:

```bash
pi install npm:pi-codex-multi
```

For development, install directly from the fork:

```bash
pi install git:github.com/thelastbodhisattva/pi-codex-multi
```

## Features

- Multiple `openai-codex` OAuth subscriptions (`openai-codex-2`, `openai-codex-3`, ...)
- `/subs` account management and Codex quota snapshots
- Rotation pools with `round-robin`, `quota-first`, `scheduled`, and `custom` strategies
- `round-robin` switches to the next eligible account before each external user turn; extension-injected failover retries do not consume another slot.
- Fallback chains and Codex-only model presets
- Project-level allow-lists and pool/chain overrides
- Retry progress preserved across failover attempts
- Failover cascade tries every eligible candidate before giving up (bounded
  by the optional `maxRetries` setting, default 3; previously the bound was
  the implicit pool size)
- Transient provider overload ("overloaded"/"capacity"/5xx) rotates once
  without marking the account exhausted; only genuine per-account limits
  (429/quota/usage-limit wording) trigger cooldowns
- Exhaustion cooldowns honor `Retry-After` or the account's known quota reset
  when available (clamped to 60s–30min, otherwise a 5-minute fallback), and
  survive restarts via `~/.pi/agent/multi-pass.state.json`

This fork does not register Anthropic, GitHub Copilot, Gemini CLI, Antigravity, or arbitrary providers. Legacy non-Codex config entries are ignored rather than causing startup failures.

## Security notes

- Custom pool selector scripts (`selectorScript`) are honored **only** from
  the global config (`~/.pi/agent/multi-pass.json`). Project-level
  `.pi/multi-pass.json` files have `selectorScript` stripped during load, so a
  checked-in project file cannot execute arbitrary code. **Breaking change:**
  pools that previously defined `selectorScript` in project config must move
  that setting to the global config.

## Quick start

```
/subs add          # choose OpenAI Codex and label the account
/subs login        # runs OAuth for the selected subscription
/subs limits
/pool create
```

`/subs login` now runs the OAuth flow and stores credentials for the selected provider (for example `openai-codex-2`). `/login openai-codex-2` remains available as Pi's native equivalent. When an account hits a rate limit, the extension retries with the next eligible Codex account in its pool or chain.

## Configuration

Global: `~/.pi/agent/multi-pass.json`

Project overrides: `.pi/multi-pass.json`

```json
{
  "subscriptions": [
    { "provider": "openai-codex", "index": 2, "label": "work" }
  ],
  "pools": [
    {
      "name": "codex-pool",
      "baseProvider": "openai-codex",
      "members": ["openai-codex", "openai-codex-2"],
      "enabled": true,
      "strategy": "round-robin"
    }
  ],
  "presets": [
    {
      "name": "coding",
      "enabled": true,
      "entries": [
        { "provider": "openai-codex", "model": "gpt-5.4", "enabled": true }
      ]
    }
  ],
  "maxRetries": 3
}
```

`maxRetries` bounds how many failover switch attempts one cascade may make
across pool members and chain entries (default 3).

Restrict a project to exact Codex accounts:

```json
{ "allowedSubs": ["openai-codex-2"] }
```

Optional environment configuration:

```bash
export MULTI_SUB="openai-codex:2"
```

## Commands

- `/subs` — add, remove, login, logout, switch, list, status, and limits
- `/pool` — create, list, inspect, toggle, remove, and configure project pools/chains
- `/mp-preset` — create, activate, list, toggle, and remove Codex model presets

### Pool strategies

`/pool create` asks for a strategy; existing pools expose it through their action menu. The default is **`round-robin`**. Other choices are `quota-first`, `scheduled`, and `custom`.

## Codex quota support

`/subs limits` reads ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` (or `CHATGPT_BASE_URL`) and reports the five-hour and seven-day subscription windows for each logged-in Codex account.

## License

MIT
