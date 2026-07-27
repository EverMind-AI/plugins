# EverOS OpenClaw Plugin

Persistent, cross-session memory for **OpenClaw**, backed by a self-hosted
[EverOS](https://github.com/EverMind-AI/EverOS) — through natural conversation.

This plugin claims OpenClaw's exclusive **memory slot** and wires the OpenClaw
lifecycle to a local EverOS server (`/api/v1/memory/*` on `127.0.0.1:8000`).

> **v3.0.0 is a major-version replacement.** Versions ≤ 2.x were *context-engine*
> plugins targeting the old EverMemOS API (`/api/v1/memories/*` at `:1995`). This
> version is the *memory-slot* plugin for the current EverOS (`/api/v1/memory/*`
> at `:8000`). Requires **EverOS ≥ 1.0.0** and **OpenClaw ≥ 2026.6.10**.

## What it does

- Recalls relevant memories **before every reply** and injects them as context
- Saves every finished turn **after it ends** — text, images, and full tool-call trajectories
- Seals the conversation tail when a session ends (`/new`, `/reset`, shutdown —
  including clients whose `/new` never notifies the gateway)
- **Auto-starts a local EverOS** if one isn't already running (detect-then-provision)
- You just chat — no `memory_store` / `memory_search` tool calls, ever

Good to know:

- This **is** a `memory`-slot plugin — installing it displaces the stock
  `memory-core` (the installer switches the slot for you)
- **Fail-open by design**: if EverOS is down or unreachable, OpenClaw keeps
  working normally — memory just pauses
- Zero runtime dependencies (native `fetch`)

## Quick start

Recommended install:

```bash
npx --yes --package @evermind-ai/openclaw-plugin everos-setup
```

The installer will:

- run the official `openclaw plugins install` (claims the memory slot)
- **ask** before granting conversation access — required for saving memory,
  never granted silently
- help point the plugin at your EverOS checkout when `everos` isn't on the
  gateway's PATH
- restart the gateway and health-check the result

Non-interactive / scripted installs: `everos-setup --grant --everos-dir
/path/to/EverOS` (all flags via `everos-setup --help`). Prefer doing it by
hand? See [Manual install](#manual-install).

Then verify with natural language — just mention something about yourself:

```text
My favorite coffee is espresso.
```

then start a new session (`/new`), send any message, and ask:

```text
What coffee do I like?
```

(Give it a few seconds between turns — extraction runs asynchronously in EverOS.)

Do **not** set `hooks.allowPromptInjection` to `false` — it defaults to on, and
recall needs it to inject memory into the prompt.

## Backend

Default backend address:

```text
http://127.0.0.1:8000
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

If EverOS is already running, the plugin detects and uses it. If it isn't, the
plugin starts one itself (`everos server start`, forced into agent mode on the
configured port). When EverOS lives in a project virtualenv, `everos-setup`
wires the start command for you (it prompts for your checkout and sets
`EVEROS_OC_START_CMD` / `EVEROS_OC_EVEROS_DIR` — see [Config
reference](#config-reference) and [Troubleshooting](#troubleshooting) if you
ever need to adjust them by hand).

Setting up EverOS from scratch:

```bash
git clone https://github.com/EverMind-AI/EverOS.git
cd EverOS
uv sync
uv run everos init      # creates ~/.everos/everos.toml (+ ome.toml) — REQUIRED before first start
# edit ~/.everos/everos.toml — fill in the api_key fields (LLM / embedding / rerank)
uv run everos server start
```

## How natural-language memory works

1. You send a normal message.
2. `before_prompt_build` — the plugin searches EverOS (developer track + agent
   track) with a query built from your prompt.
3. Hits are injected as a clearly-fenced block of **untrusted historical
   context** — recalled memory informs the model, it can't issue instructions.
4. OpenClaw replies normally.
5. `agent_end` — the whole turn (user text, assistant text, tool calls, tool
   results, images) is forwarded to EverOS `/add`.
6. EverOS extracts memory on topic boundaries as you chat; when a session ends —
   `/new`, `/reset`, gateway shutdown, or a client-side session switch — the
   plugin flushes the buffered tail so the last topic is never lost.

So the day-to-day experience is just conversation:

> **Today:** "I prefer dark mode, by the way."
> **Days later, brand-new session:** "What UI style do I prefer?" → *"Dark mode."*

You never run a save command and never search anything — mentioning something is
enough for it to be remembered, and asking is enough to recall it. No "remember
this" prefix required.

## OpenClaw config example

The installed shape in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "evermind-ai-everos"
    },
    "entries": {
      "evermind-ai-everos": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "EVEROS_OC_BASE_URL": "http://127.0.0.1:8000",
          "EVEROS_OC_USER_ID": "your-name",
          "EVEROS_OC_AGENT_ID": "openclaw",
          "EVEROS_OC_QUERY_N": 1,
          "EVEROS_OC_QUERY_MAX_CHARS": 500
        }
      }
    }
  }
}
```

## Config reference

Every key can be set two equivalent ways: **env vars on the gateway process**
(take precedence) or **host-managed plugin config**
(`openclaw config set plugins.entries.evermind-ai-everos.config.<VAR> <value>`).
Empty/blank values are treated as unset.

| Var | Default | Purpose |
|---|---|---|
| `EVEROS_OC_BASE_URL` | `http://127.0.0.1:8000` | Where EverOS is. Scheme-less values (`localhost:8000`) are normalized to `http://` |
| `EVEROS_OC_USER_ID` | `$USER` / `$USERNAME` / OS account | Developer identity for the user memory track |
| `EVEROS_OC_AGENT_ID` | `openclaw` | Constant pooled agent identity for the agent track |
| `EVEROS_OC_QUERY_N` | `1` | Recent user messages blended into the recall query |
| `EVEROS_OC_QUERY_MAX_CHARS` | `500` | Recall query head-clip budget (chars) |
| `EVEROS_OC_START_CMD` | `everos server start` | Command to auto-start EverOS. Quotes group a path with spaces |
| `EVEROS_OC_EVEROS_DIR` | (gateway cwd) | Working directory for the auto-started EverOS |

## What gets recalled and captured

### Recalled

Recall injects up to four sections, all served by EverOS:

- **Developer profile** — durable facts and preferences about you
- **Relevant past episodes** — summarized prior conversations
- **Relevant cases** — concrete past agent trajectories (what worked)
- **Relevant skills** — reusable patterns distilled from multiple cases

### Captured

- User and assistant text (the plugin strips its own injected recall block first,
  so memory never re-ingests itself)
- Assistant **tool calls** and tool results, chained by `tool_call_id`
- **Images** (inline base64 or URI). If the server rejects media (no multimodal
  support), that turn retries text-only so nothing is lost
- Oversized turns are chunked to EverOS's 500-message limit, in order

## Manual install

```bash
openclaw plugins install @evermind-ai/openclaw-plugin
```

Then grant memory capture — **required, one time** (OpenClaw blocks non-bundled
plugins from reading conversation content by default, so without this the plugin
recalls but never saves anything):

```bash
openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true
openclaw gateway restart
```

If `everos` lives in a project virtualenv, also set `EVEROS_OC_START_CMD` /
`EVEROS_OC_EVEROS_DIR` (see [Config reference](#config-reference)) — or just run
`everos-setup`, which wires them for you.

## Troubleshooting

| Problem | Fix |
|---|---|
| Recall works but **nothing is ever saved** | Grant capture: `openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true`, then restart the gateway. (The plugin logs a warning when it detects this state.) |
| Backend connection failed | Check `EVEROS_OC_BASE_URL`, then `curl <baseUrl>/health` |
| Auto-start never brings EverOS up | The gateway can't find `everos` — set `EVEROS_OC_START_CMD` to the absolute binary path and `EVEROS_OC_EVEROS_DIR` to the EverOS repo. Also check nothing else holds the single-instance lock (`~/.everos/.index/sqlite/ome.db.lock`) |
| Asked right after telling — no memory yet | Extraction is asynchronous; wait a few seconds. Mid-conversation extraction triggers on topic changes; session end seals the rest |
| "user-track memory is DISABLED" warning | No user id could be resolved — set `EVEROS_OC_USER_ID` |
| Conflicts with another memory plugin | This plugin owns the exclusive `memory` slot; check `plugins.slots.memory` is `evermind-ai-everos` |

## Files

- `dist/index.js` — plugin entry (`openclaw.extensions`)
- `src/setup.ts` / `src/setup-cli.ts` — the `everos-setup` one-command installer
- `src/register.ts` — slot claim, hook wiring, provisioning service
- `src/handlers.ts` — recall / capture / flush (+ session-switch safety net)
- `src/everos.ts` — typed EverOS REST client (`/add`, `/search`, `/flush`, `/health`)
- `src/provision.ts` — detect-then-provision of the EverOS server
- `src/config.ts` — `EVEROS_OC_*` configuration
- `openclaw.plugin.json` — plugin manifest + config schema

## Develop

```bash
npm install
npm run build        # tsc → dist/
npm test             # unit tests; live smoke runs only if EverOS is up
npm run ci           # lint + typecheck + build + test
```

## License

Apache-2.0
