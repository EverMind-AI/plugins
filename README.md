# EverMind AI — Agent Plugins

Official agent-host plugins for [EverOS](https://github.com/EverMind-AI/EverOS),
the md-first memory framework. Each plugin gives an agent host persistent,
cross-session memory backed by a local EverOS server — **one EverOS, many
agents**: the same store serves every host, partitioned per app.

## Plugins

| Plugin | Host | Install | Status |
|---|---|---|---|
| [`openclaw/`](./openclaw) | [OpenClaw](https://docs.openclaw.ai) | [`@evermind-ai/openclaw-plugin`](https://www.npmjs.com/package/@evermind-ai/openclaw-plugin) on npm — one-command setup: `npx --yes --package @evermind-ai/openclaw-plugin everos-setup` | ✅ published (3.0.1) |
| [`hermes/`](./hermes) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | — | 🚧 design complete ([docs](./hermes/docs)) — implementation in progress |

## What every plugin here shares

- **Recall → capture → seal**: relevant memory is recalled before each turn,
  the finished turn is captured after it, and the session tail is sealed on
  close — automatically, with no memory tools for the model to remember to call.
- **Fail-open**: if EverOS is down or unreachable, the host works normally —
  memory just pauses.

Each plugin's own README covers setup, configuration, and troubleshooting.

## License

[Apache-2.0](./LICENSE)
