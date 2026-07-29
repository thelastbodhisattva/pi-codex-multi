# pi-codex-multi

Pi extension exclusively for ChatGPT Plus/Pro subscriptions through OpenAI Codex OAuth. Add multiple Codex accounts and rotate them through failover pools.

## Install

```bash
pi install npm:pi-codex-multi
```

Or from git:

```bash
pi install git:github.com/thelastbodhisattva/pi-codex-multi
```

## Features

- Multiple `openai-codex` OAuth subscriptions (`openai-codex-2`, `openai-codex-3`, ...)
- `/subs` account management and Codex quota snapshots
- Rotation pools with `round-robin`, `quota-first`, `scheduled`, and `custom` strategies
- Fallback chains and Codex-only model presets
- Project-level allow-lists and pool/chain overrides
- Retry progress preserved across failover attempts

This fork does not register Anthropic, GitHub Copilot, Gemini CLI, Antigravity, or arbitrary providers. Legacy non-Codex config entries are ignored rather than causing startup failures.

## Quick start

```
/subs add
/login
/subs limits
/pool create
```

Add another ChatGPT account with `/subs add`, then authenticate `openai-codex-2`. When an account hits a rate limit, the extension retries with the next eligible Codex account in its pool or chain.

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
  ]
}
```

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

## Codex quota support

`/subs limits` reads ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` (or `CHATGPT_BASE_URL`) and reports the five-hour and seven-day subscription windows for each logged-in Codex account.

## License

MIT
