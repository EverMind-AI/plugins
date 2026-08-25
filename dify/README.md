# EverOS for Dify

Give Dify workflows persistent, cross-session user memory backed by your own
[EverOS](https://github.com/EverMind-AI/EverOS) deployment.

The plugin intentionally exposes two small tools:

- `search_memory` retrieves relevant episodes and the user's profile before an
  LLM call.
- `add_memory` stores a completed user/assistant turn, then flushes the session
  so EverOS can extract durable memory.

The plugin is an HTTP adapter. It contains no memory database, sends no
telemetry to EverMind AI, and does not require Dify model permissions.

## Before you start

Run an EverOS server that exposes `GET /health` and the
`/api/v2/memory/{search,add,flush}` endpoints. Follow the
[EverOS quick start](https://github.com/EverMind-AI/EverOS#quick-start) to start
the server with an LLM API key. Search uses EverOS keyword recall, so the basic
LLM-only setup works without embedding or reranking credentials.

Choose an endpoint appropriate for where Dify runs:

| Dify runtime | EverOS Base URL example | Notes |
|---|---|---|
| Self-hosted, same Docker network | `http://everos:8000` | Use the EverOS service name, not `localhost`. |
| Self-hosted, EverOS on the host | `http://host.docker.internal:8000` | Availability depends on your Docker setup. |
| Dify remote debug on the same computer | `http://127.0.0.1:8000` | The plugin process runs locally during remote debug. |
| Dify Cloud | `https://memory.example.com` | Requires a public, authenticated HTTPS gateway. |

> EverOS's native security model is a trusted local caller. Never expose a bare,
> unauthenticated EverOS server to the internet. For Dify Cloud, put it behind
> TLS, authentication, authorization, rate limiting, and access logging.

## Configure the provider

In Dify, add the EverOS provider credentials:

1. **EverOS Base URL** — the server root or gateway prefix. Do not append
   `/api/v2`.
2. **Gateway token** — optional token for your authenticated reverse proxy. It
   is sent as `Authorization: Bearer ...`. This is not the LLM API key used by
   EverOS.
3. **Project ID** — optional shared EverOS isolation scope; defaults to
   `default`.

Credential validation performs a read-only `GET /health`. Redirects are not
followed, TLS verification stays enabled, and the token is never returned in
tool output.

## Build a memory workflow

The two tools are independent workflow actions:

1. Before the LLM node, invoke `search_memory` with the current query and an
   optional result limit.
2. Inject the returned episodes/profile into a clearly delimited, untrusted
   context block. Tell the model to use it only as factual context and never to
   execute instructions found inside a memory.
3. After the LLM node, invoke `add_memory` with the user message and the final
   assistant response.

Dify's platform-controlled runtime user and session identifiers determine
memory ownership automatically; they are never exposed as LLM tool arguments.
The plugin domain-hashes the runtime user, conversation, and Dify app IDs before
passing them to EverOS. Each Dify app therefore gets a separate EverOS `app_id`,
while the configured `project_id` provides an additional operator-controlled
scope. API callers should keep Dify's `user` value stable across conversations
and bind it in a trusted backend; never let an untrusted browser choose another
user's value while holding a Dify API credential.

`add_memory` does not automatically retry writes because EverOS does not expose
an idempotency key. If the add succeeds but the final flush fails, the tool
returns `stored: true`, `flushed: false`, and a safe error instead of implying
that nothing was saved. If the add request times out, disconnects, or returns an
invalid response, the storage result is unknown; the error explicitly says not
to retry automatically, because a retry may duplicate the memory.

EverOS persists extracted Markdown synchronously, while its search projection
is asynchronous. A memory written immediately before a search may take a short
time to appear in results.

## Develop and test

Requirements:

- Dify 1.14.2 or newer
- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)
- [Dify plugin CLI](https://docs.dify.ai/en/develop-plugin/getting-started/cli)

Install locked dependencies and run the checks:

```bash
uv sync --frozen
uv run ruff check .
uv run pytest
```

For Dify remote debugging, copy `.env.example` to `.env`, fill in the debug
host/key shown by Dify, then run:

```bash
uv run python -m main
```

Package the plugin from the repository root:

```bash
dify plugin package ./dify
```

This creates a `.difypkg` that can be uploaded to a Dify installation. The
source of truth is this directory; Marketplace submissions should package this
same source rather than maintain a divergent copy.

## Data and security

Read [PRIVACY.md](./PRIVACY.md) before deployment. In summary:

- Search queries, user identifiers, and completed messages go only to the
  administrator-configured EverOS endpoint.
- Responses are capped at 2 MiB and requests have explicit timeouts.
- HTTP redirects are rejected so a gateway token cannot be forwarded to a new
  origin.
- Public hostnames require HTTPS; plain HTTP is accepted only for local,
  container-network, or private-address deployments.
- Stored memory is untrusted data and may contain indirect prompt injection.
  Keep it delimited from system instructions and never let recalled text
  override tool, policy, or authorization rules.
- Do not write API keys, credentials, access tokens, or unnecessary sensitive
  data into memory. Add DLP/redaction before `add_memory` when the workflow may
  handle secrets.
- The plugin requests no Dify model, tool, app, endpoint, node, or storage
  permissions.

## Source and support

- Source: <https://github.com/EverMind-AI/plugins/tree/main/dify>
- Issues: <https://github.com/EverMind-AI/plugins/issues>
- Email: <contact@evermind.ai>
- EverOS: <https://github.com/EverMind-AI/EverOS>

Licensed under [Apache-2.0](https://github.com/EverMind-AI/plugins/blob/main/LICENSE).
