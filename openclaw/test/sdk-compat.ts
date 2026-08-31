/**
 * Compile-only contract check against the exact OpenClaw 2.0 SDK pinned in
 * devDependencies. Unlike the normal build, tsconfig.sdk.json excludes our
 * ambient runtime-value shim, so SDK drift fails CI instead of being hidden.
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { register } from "../src/register.js";

type PluginApiAcceptedByRegister = Parameters<typeof register>[0];
const apiIsCompatible: OpenClawPluginApi extends PluginApiAcceptedByRegister ? true : false = true;
void apiIsCompatible;

definePluginEntry({
  id: "evermind-ai-everos-sdk-check",
  name: "EverOS SDK compatibility check",
  description: "Compile-only OpenClaw 2.0 SDK contract check.",
  register(api) {
    register(api);
  },
});
