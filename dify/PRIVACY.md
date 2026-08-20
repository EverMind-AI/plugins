# Privacy Policy

Last updated: August 20, 2026

The EverOS Dify plugin is a client-side integration. It does not send telemetry
to EverMind AI and does not use an EverMind-operated intermediary service.

## Data processed

When a Dify workflow invokes a tool, the plugin sends the following data to the
EverOS endpoint configured by the Dify administrator:

- `search_memory`: a domain-separated hash of Dify's runtime user identifier,
  the search query, result limit, a hash of the Dify app identifier, and the
  configured project scope.
- `add_memory`: hashes of the runtime user, conversation, and app identifiers;
  the user message; the assistant message; and the configured project scope.

The endpoint may return extracted memories, profiles, request identifiers, and
operation status. Dify processes the returned data as tool output.

## Credentials

The optional gateway API key is read from Dify's provider credential store and
sent only to the configured endpoint in the `Authorization: Bearer` header. The
plugin never includes the key in tool output or error messages. This credential
is for an operator-provided HTTPS gateway; EverOS itself does not require it in
its trusted local deployment model.

## Storage and retention

This plugin does not maintain its own database. Memory storage, retention, and
deletion are controlled by the configured EverOS deployment. Dify may retain
workflow inputs and tool outputs according to the Dify administrator's own
configuration and policies.

Workflow operators should remove credentials, tokens, and unnecessary personal
data before invoking `add_memory`. Recalled memory is untrusted content and may
contain indirect prompt injection; applications must not treat it as executable
instructions or allow it to override authorization and system policies.

## Network boundaries

Self-hosted Dify can connect to an EverOS endpoint reachable from its plugin
runtime. Dify Cloud cannot reach a user's localhost or private network; it
requires a public HTTPS gateway. Operators are responsible for TLS,
authentication, authorization, rate limiting, and access logging at that
gateway. Do not expose a bare, unauthenticated EverOS service to the internet.

## Contact

For questions or deletion requests, contact the operator of the configured
EverOS deployment or open an issue at
<https://github.com/EverMind-AI/plugins/issues>.
