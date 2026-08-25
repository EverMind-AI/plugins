# EverOS Cloud for Dify

Connect Dify workflows and agents to persistent memory hosted by EverOS Cloud.
This is the cloud-service edition: users do not run an EverOS server alongside
Dify.

## What you need

- The EverOS Cloud API URL (the default is `https://api.evermind.ai`).
- An EverOS Cloud API Key for that service.
- A Dify LLM provider configured separately if the app itself calls an LLM.

The EverOS Cloud service manages its own LLM, embedding, rerank, and
multimodal configuration. Those provider keys are never entered into this
plugin. The plugin sends the EverOS Cloud API Key only to the configured HTTPS
service URL as an `Authorization: Bearer` header.

## Configure the credential

Open **Plugins -> EverOS Cloud -> Authorize** in Dify and enter:

| Field | Required | Value |
|---|---:|---|
| Credential name | Yes | Any label meaningful to your workspace. |
| EverOS Cloud API URL | Yes | Keep `https://api.evermind.ai` unless your account uses another approved HTTPS service root; do not include `/api/v2`. |
| EverOS Cloud API Key | Yes | The API key issued for that service. |

Saving the credential validates the URL, API Key format, and EverOS health
response. The first tool call confirms that the API Key is authorized. The URL
must use HTTPS and resolve only to public IP addresses. Redirects are not
followed.

## Tools

### Search EverOS Cloud memory

Searches persistent memory for the current Dify runtime user before the LLM
generates its answer. Inputs are the search query and an optional result limit.

### Add EverOS Cloud memory

Stores one completed user/assistant turn and asks EverOS Cloud to finalize
memory extraction. Add this after the LLM response in a workflow.

## Typical workflow

1. Start with the user's current message.
2. Call **Search EverOS Cloud memory** using that message as the query.
3. Pass the returned memory to the LLM as untrusted context.
4. Generate the final answer.
5. Call **Add EverOS Cloud memory** with the original user message and final
   assistant answer.

Tool placement is explicit; installing the plugin does not automatically add
memory to every Dify app.

## Isolation and data flow

The plugin derives stable, domain-separated hashes from Dify's platform-owned
runtime user, app, and conversation identifiers. The LLM cannot choose those
scope identifiers. A fixed internal project scope is used, so users do not need
to configure project, user, app, or session IDs.

Search queries, completed conversation turns, and derived scope identifiers are
sent to the configured EverOS Cloud API URL. Do not store secrets or regulated
data unless your organization has approved that service and use case. See
[PRIVACY.md](./PRIVACY.md) for details.

## Security behavior

- HTTPS is mandatory.
- Localhost, private, link-local, reserved, and non-public DNS destinations are
  rejected.
- Credentials in URLs, query strings, fragments, and redirects are rejected.
- Redirects are disabled so the authorization header is not forwarded.
- Response bodies are bounded to 2 MiB and upstream error bodies are not shown
  in Dify errors.
- Memory content is untrusted input and must not be treated as instructions.

Because the destination URL is workspace-configurable, administrators should
allow only an approved EverOS Cloud endpoint and restrict who can edit plugin
credentials.

## Support

- Source: <https://github.com/EverMind-AI/plugins/tree/main/dify_cloud>
- Issues: <https://github.com/EverMind-AI/plugins/issues>
- Email: <contact@evermind.ai>
- EverOS: <https://github.com/EverMind-AI/EverOS>

Licensed under [Apache-2.0](https://github.com/EverMind-AI/plugins/blob/main/LICENSE).
