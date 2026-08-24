# EverMind AI — Integrations

Official host and workflow integrations for
[EverOS](https://github.com/EverMind-AI/EverOS), the md-first memory framework.
They connect agents and applications to persistent, cross-session memory —
**one EverOS, many agents**: the same store serves every host, partitioned per
app.

## Plugins

| Plugin | Host | Install | Status |
|---|---|---|---|
| [`openclaw/`](./openclaw) | [OpenClaw](https://docs.openclaw.ai) | [`@evermind-ai/openclaw-plugin`](https://www.npmjs.com/package/@evermind-ai/openclaw-plugin) on npm — one-command setup: `npx --yes --package @evermind-ai/openclaw-plugin everos-setup` | ✅ published (3.0.1) |
| [`hermes/`](./hermes) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `hermes plugins install EverMind-AI/plugins/hermes` | 🧪 built — pre-release verification |
| [`dsh/`](./dsh) | [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) | `dsh plugin --profile web add @evermind-ai/dsh-plugin` | 🧪 built — pre-release verification |
| [`dify/`](./dify) | [Dify](https://dify.ai) | Package with the Dify CLI, then upload the `.difypkg` in Dify | 🧪 built — Marketplace submission pending |
| [`langfuse/`](./langfuse) | [Langfuse](https://langfuse.com) | `python replay.py` for the recorded trace, or enable EverOS OpenTelemetry for live traces | ✅ replay and live tracing integration |

## Integration models

- **Agent hosts** such as OpenClaw, Hermes, and DSH automate the recall → capture →
  seal lifecycle and fail open when EverOS is unavailable.
- **Workflow platforms** such as Dify expose explicit search and add tools, so
  builders decide exactly where memory runs in a workflow.
- **Observability backends** such as Langfuse receive EverOS's native
  OpenTelemetry traces and recall-quality scores without wrapping the memory API.

Each integration's own README documents its lifecycle, setup, security model,
and troubleshooting.

## License

[Apache-2.0](./LICENSE)
