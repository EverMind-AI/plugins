# Privacy Notice for EverOS Cloud for Dify

Last updated: 2026-08-25

## Data processed

When a Dify application invokes this plugin, it may send the following data to
the workspace-configured EverOS Cloud API URL:

- search queries;
- completed user and assistant messages selected by the workflow builder;
- domain-separated hashes derived from Dify runtime user, app, and conversation
  identifiers;
- an internal project scope; and
- normal request metadata required for an HTTPS connection.

The EverOS Cloud API Key is sent only in the `Authorization: Bearer` request
header to the configured URL. The plugin does not ask for or receive the user's
LLM, embedding, rerank, or multimodal provider keys.

## Purpose and storage

The data is transmitted to search, store, and extract persistent memory. This
plugin itself does not create an independent telemetry or analytics store.
However, the operator of the configured EverOS Cloud service may process,
store, retain, or log the submitted data according to that operator's terms,
privacy notice, account configuration, and applicable law.

Before using the plugin, workspace administrators must verify that the
configured service is approved for the intended data and users. Do not send
secrets, credentials, regulated data, or personal data unless the organization
has authorized that use and appropriate notices and agreements are in place.

## Security controls

The plugin requires HTTPS, rejects local and non-public destinations, validates
DNS answers before a request, disables redirects, bounds response bodies, and
does not include upstream response bodies in Dify errors. These controls reduce
risk but do not replace service-operator security, workspace access controls,
data-loss prevention, or review of workflow inputs.

Credentials are stored by Dify using Dify's credential storage mechanism.
Access to plugin configuration should be restricted to authorized workspace
members. Removing the plugin does not by itself delete data previously stored
by the configured cloud service; use that service's deletion process.

## Support

Questions and privacy requests can be sent to <contact@evermind.ai>. Source and
issue tracking are available at
<https://github.com/EverMind-AI/plugins/tree/main/dify_cloud> and
<https://github.com/EverMind-AI/plugins/issues>.
