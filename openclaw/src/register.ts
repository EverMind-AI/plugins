/**
 * Plugin wiring, split out from `index.ts` so it can be unit-tested.
 *
 * `index.ts` imports `definePluginEntry` — a runtime *value* from the `openclaw`
 * peer — which isn't resolvable outside the host, so importing `index.ts` in a
 * test crashes at module load. This module imports only *types* from openclaw
 * (erased at runtime, like `handlers.ts`), so a test can import `register`
 * directly and drive it with a fake `api`.
 */
import { userInfo } from "node:os";

import { loadConfig, mergeConfigSources } from "./config.js";
import { createEverosClient } from "./everos.js";
import { createHandlers } from "./handlers.js";
import type { OpenClawPluginApi } from "./openclaw-types.js";
import { type ProvisionResult, provision } from "./provision.js";

/** Constant `app_id` for the OpenClaw memory partition (§3.6). */
const APP_ID = "openclaw";

/** OS-level username (from the account behind the process), or undefined. Never throws. */
function osUsername(): string | undefined {
  try {
    const name = userInfo().username;
    return name?.trim() ? name : undefined;
  } catch {
    return undefined; // e.g. uid not in the passwd db (some containers)
  }
}

/**
 * Resolve the developer user id from config → `USER` → `USERNAME` → OS account.
 * Uses `||` (not `??`) so an empty string falls through instead of being taken as
 * a real id. The OS fallback matters under a daemon (launchd/systemd), where the
 * `USER`/`USERNAME` env vars are typically absent — without it, `userId` would be
 * undefined and the ENTIRE user-memory track would silently no-op.
 */
export function resolveUserId(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  osUser: () => string | undefined = osUsername,
): string | undefined {
  return configured || env.USER || env.USERNAME || osUser() || undefined;
}

/**
 * Wire the plugin into the host: claim the memory slot (empty capability),
 * register the four lifecycle hooks, and register the detect-then-provision
 * service. Nothing runs on its own — provisioning fires only when the host calls
 * the registered service's `start()`.
 *
 * @internal Consumed by `index.ts` and `test/register.test.ts`. Not a supported
 * public API — do not import it from downstream code.
 */
export function register(api: OpenClawPluginApi, deps: { provisionFn?: typeof provision } = {}): void {
  // Host-managed plugin config (plugins.entries.<id>.config, the surface our
  // manifest configSchema describes) is honored, with env vars taking precedence.
  const cfg = loadConfig(mergeConfigSources(process.env, api.pluginConfig));
  const userId = resolveUserId(cfg.userId, process.env);
  if (!userId) {
    api.logger?.warn?.(
      "[everos] user-track memory is DISABLED — could not resolve a user id. " +
        "Set EVEROS_OC_USER_ID to enable it. (Agent-track memory still works.)",
    );
  }
  const client = createEverosClient({ baseUrl: cfg.baseUrl });
  const handlers = createHandlers({
    client,
    userId,
    agentId: cfg.agentId,
    appId: APP_ID,
    pluginId: api.id,
    queryN: cfg.queryN,
    queryMaxChars: cfg.queryMaxChars,
    logger: api.logger,
  });

  // Claim the exclusive memory slot (displacing stock memory-core). We pass an
  // EMPTY capability ON PURPOSE — EverOS is the single source of truth for memory,
  // so the host must do none of the memory work itself. Do NOT populate these
  // fields later; each would hand a piece of memory back to the host and create a
  // second, competing store that drifts out of sync with EverOS:
  //   - promptBuilder:     host would inject memory into the prompt — we do this
  //                        ourselves in the before_prompt_build hook (prependContext).
  //   - flushPlanResolver: host would write its OWN memory files — EverOS owns
  //                        storage (markdown + sqlite + lancedb); we flush via the API.
  //   - runtime:           host would expose agent-callable memory tools — not our
  //                        model; EverOS runs as an external service, not host tools.
  //   - publicArtifacts:   host would surface memory files in its UI — EverOS's
  //                        files are not host-managed artifacts.
  // Everything is routed through our hooks + the EverOS HTTP API instead.
  api.registerMemoryCapability({});

  // Recall → inject (per-turn, ~5s host budget; our cap is the real bound).
  api.on("before_prompt_build", handlers.recall, { timeoutMs: 5000 });
  // Capture → /add (fire-and-forget). Needs hooks.allowConversationAccess=true.
  api.on("agent_end", handlers.capture);
  // Seal the session's tail on deliberate endings. session_end covers /new,
  // /reset, delete, compaction, and graceful shutdown; before_reset also catches
  // turn-less /new//reset (where session_end no-ops). Deduped so /new — which
  // fires both — flushes once. (EverOS still auto-extracts mid-conversation on
  // topic boundaries via /add; this only seals a tail that never crossed one.)
  api.on("session_end", handlers.flush);
  api.on("before_reset", handlers.reset);

  // detect-then-provision EverOS. Fire-and-forget so we never block boot.
  const provisionFn = deps.provisionFn ?? provision;
  const startCommand = cfg.startCmd;
  const cwd = cfg.everosDir;
  let provisioned: ProvisionResult | undefined;
  let stopInFlight: (() => void) | undefined; // kill handle for a start still in progress
  let stopped = false;
  api.registerService({
    id: "everos-server",
    start(svc) {
      void provisionFn({
        baseUrl: cfg.baseUrl,
        startCommand,
        cwd,
        logger: svc.logger ?? api.logger,
        // Capture the kill handle the moment the child spawns so stop() can cancel an
        // in-flight start; if stop() already fired, kill it immediately.
        onStop: (stop) => {
          stopInFlight = stop;
          if (stopped) stop();
        },
      })
        .then((r) => {
          provisioned = r;
          if (stopped) r.stop?.(); // stop() fired mid-provision → ensure it's down
        })
        .catch(() => {
          /* provision never rejects, but stay safe */
        });
    },
    stop() {
      stopped = true;
      // Prefer the resolved handle; fall back to the in-flight one so a shutdown during
      // startup doesn't orphan the spawned EverOS (an orphan would hold the OME lock).
      (provisioned?.stop ?? stopInFlight)?.();
    },
  });
}
