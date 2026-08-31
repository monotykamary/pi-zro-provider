<div align="center">

# ✨ pi-zro-provider

**3+ models through [Zro](https://zro.moonmath.ai)**

_GLM-5.2, Kimi K3, and DeepSeek V4 Flash — run through the Zro inference endpoint with [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **5+ AI Models** — GLM-5.2 (default), Kimi K3, and DeepSeek V4 Flash, straight from Zro's production catalog
- **Native reasoning effort** — every model ships an endpoint-verified `piLevel` → level-id map (`glm-5.2`, `glm-5.3-flash`, `deepseek-v4-flash-0731`: full `off`–`max` ladder; `kimi-k3`: `low`/`high`/`max` — the proxy rejects `medium` there), so `/thinking low` etc. maps exactly to what the Zro proxy accepts. Quirks: `glm-5.3-flash` silently disables thinking at `low`, so `minimal`/`low` map to `minimal`; `glm-5.3` mirrors flash's full ladder — Z.ai officially removed `none` for the 5.3 family, but the proxy accepts it and streams cleanly (occasionally a short chain-of-thought preamble surfaces in `content` before the answer), and `xhigh`/`max` both send `max`
- **OpenAI-compatible API** at `https://zro.moonmath.ai/v1`
- **Official catalog sync** from Zro's `/api/cli/models` endpoint — same one `zro models` uses
- **Zro login reuse** — if you've run `zro login`, the extension picks up `~/.config/zro/credentials.json` automatically (no duplicated keys)
- **Footer status widget** — session spend/requests and account plan / available spend / usage packs / 30-day activity at a glance

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V4 Flash | Text | 1.0M | 384K | $0.14 | $0.28 |
| GLM-5.2 | Text | 524K | 64K | $1.10 | $4.00 |
| GLM-5.3 | Text | 1.0M | 131K | $1.40 | $4.40 |
| GLM-5.3 Flash | Text + Image | 1.0M | 64K | $0.15 | $0.50 |
| Kimi K3 | Text + Image | 1.0M | 131K | $2.50 | $12.00 |
*Costs are per million tokens. Billing is metered by your Zro plan and usage packs — see [zro.moonmath.ai](https://zro.moonmath.ai) for pricing.*

## Installation

### Option 1: Using `pi install` (Recommended)

Install from npm:

```bash
pi install npm:pi-zro-provider
```

Or directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-zro-provider
```

Then make sure you're logged in (or set a key) and run pi:
```bash
# Recommended: reuse your zro CLI login
zro login

# Or set as environment variable
export ZRO_API_KEY=your-api-key-here

pi
```

Get your API key from [zro.moonmath.ai](https://zro.moonmath.ai).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-zro-provider.git
   cd pi-zro-provider
   ```

2. Make sure you have a Zro credential (any of the [Authentication](#authentication) options).

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-zro-provider
   ```

## Usage

After loading the extension, select a model with:

```
/model zro glm-5.2
```

Or start pi directly with a Zro model:

```bash
pi --provider zro --model glm-5.2
```

### Reasoning Effort

All Zro models are reasoning models. Control thinking depth with `/thinking` or the CLI:

```bash
pi --provider zro --model glm-5.2 --thinking xhigh
```

The available levels are model-specific and come straight from Zro's catalog:

| Model | pi levels | Sent as `reasoning_effort` |
|-------|-----------|----------------------------|
| `glm-5.2` | `off`, `high`, `max` | `none`, `high`, `max` |
| `glm-5.3` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `none`, `minimal`, `minimal`, `medium`, `high`, `max`, `max` |
| `kimi-k3` | `low`, `high`, `max` | `low`, `high`, `max` |
| `deepseek-v4-flash-0731` | `off`, `low`, `high`, `max` | `none`, `low`, `high`, `max` |

Levels map one-to-one through `thinkingLevelMap`, so `off` sends Zro's `none` token instead of silently dropping the field.

### Footer Status

A Neuralwatt-style status line sits below the editor. It appears after the
session's first Zro turn completes (never before — no half-empty line on
fresh sessions or other providers), refreshes its balance when the agent run
fully settles, and makes no status-related API calls in sessions that never
use Zro:

```
⚡ $0.42 · 7 req                   Pro ◆ $12.34 avail · $2.50 pack · 1.2k req/30d
└─ session spend+requests ─┘     └─ plan · available spend · packs · activity ──┘
```

The left side tracks what this session has done — request count, the spend
Zro attaches to a response when it reports one, and elapsed time (raw token
totals stay in pi's own footer, which can't show
Zro cost since its catalog carries no pricing). The right
side shows your plan name, total available spend, usage-pack balance, and
30-day request/token activity from Zro's `/api/cli/status` endpoint — the
same account view `zro status` prints — plus a request-rate atom from
response headers when present. The right side compresses progressively as
the terminal narrows, and turns to a warning color at/below the
`lowBalanceUsd` threshold.

### Configuration

Edit `~/.pi/agent/extensions/zro.json` or run `/zro-status`:

| Setting | Values | Default |
|---------|--------|---------|
| `session` | `widget` \| `statusbar` \| `off` | `widget` |
| `account` | `widget` \| `statusbar` \| `off` | `widget` |
| `hideOnOtherProvider` | `true` \| `false` | `true` |
| `lowBalanceUsd` | number \| `null` | `10` |

Non-interactive toggles:

```
/zro-status session widget|statusbar|off
/zro-status account widget|statusbar|off
/zro-status hide true|false
/zro-status lowBalance 25|off
/zro-status refresh
/zro-status reset
```


## Authentication

The Zro API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "zro": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Environment variable** — Set `ZRO_API_KEY`
3. **`zro login` reuse** — If you've already run `zro login`, the extension reads `~/.config/zro/credentials.json` (`XDG_CONFIG_HOME` aware) automatically. No extra configuration needed.
4. **Runtime override** — Use the `--api-key` CLI flag

Get your API key from [zro.moonmath.ai](https://zro.moonmath.ai).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZRO_API_KEY` | No | Your Zro API key (env var fallback) |
| `ZRO_ENDPOINT_ROOT` | No | Override the endpoint root (default `https://zro.moonmath.ai`) |
| `ZRO_AUTH_URL` | No | Override the authentication/API host (used by `zro login`; the extension resolves catalog/status from it too) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-zro-provider"
  ]
}
```

### Catalog and Compat Settings

Model metadata matches the transform Zro's own pi adapter applies to its
`/api/cli/models` catalog:

- canonical ids, display names, context windows, and output caps
- `thinkingLevelMap` built from each model's published reasoning levels
  (`piLevel` → provider level id)
- `compat.supportsReasoningEffort: true` and `maxTokensField: "max_tokens"`
  (plain `openai-completions`, no custom `thinkingFormat`)
- `supportsDeveloperRole: false`
- all text-only inputs

`patch.json` is reserved only for a verified provider regression and is
currently empty.

### Patch Overrides

`patch.json` is applied on top of `models.json` only for verified endpoint
corrections. It is currently empty because every live field comes from Zro's
canonical model catalog.

## Updating Models

Run the update script to fetch the latest models from the Zro catalog:

```bash
node scripts/update-models.js        # uses zro login credentials
# or
ZRO_API_KEY=your-api-key node scripts/update-models.js
```

This will:
1. Fetch models from `https://zro.moonmath.ai/api/cli/models`
2. Regenerate `models.json` as pure metadata from the live catalog
3. Apply overrides from `patch.json` only when building the README
4. Remove custom models now available upstream from `custom-models.json`
5. Reconcile delisted models through the 14-day `deprecated-models.json` grace layer
6. Update `models.json` and the README model table

## License

MIT
