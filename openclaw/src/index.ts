/**
 * @evermind-ai/openclaw-plugin — OpenClaw Memory — EverOS.
 *
 * OpenClaw plugin entry: claims the exclusive `memory` slot and wires the
 * lifecycle hooks to EverOS (recall on `before_prompt_build`, capture on
 * `agent_end`, flush on `session_end`/`before_reset`) plus detect-then-provision
 * via a registered service. Everything is fail-open. The wiring itself lives in
 * `./register.js` (openclaw-runtime-free, so it can be unit-tested directly).
 *
 * Also re-exports the EverOS client + helpers as a library surface (used by the
 * integration tests, and usable standalone).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import type { DefinedPluginEntry } from "./openclaw-types.js";
import { register } from "./register.js";

// Annotated with our LOCAL type so the emitted dist/index.d.ts references only
// types shipped in this package (never the openclaw peer's internal names).
const entry: DefinedPluginEntry = definePluginEntry({
  id: "evermind-ai-everos",
  name: "OpenClaw Memory — EverOS",
  description: "EverOS-backed cross-session memory for OpenClaw (memory slot).",
  register,
});
export default entry;

export type { EverosOcConfig } from "./config.js";
export { DEFAULTS, loadConfig } from "./config.js";
export type { CallOptions, EverosClient, EverosClientOptions } from "./everos.js";
// ── library surface ──────────────────────────────────────────────────────────
export { assertScopeId, createEverosClient, EverosError } from "./everos.js";
export type { HandlerDeps, Handlers } from "./handlers.js";
export { createHandlers, projectIdFrom, recentUserText, render } from "./handlers.js";
export type * from "./openclaw-types.js";
export type { ProvisionOptions, ProvisionResult, ProvisionStatus } from "./provision.js";
export { portFromUrl, provision, waitForHealthy } from "./provision.js";
export type * from "./types.js";
