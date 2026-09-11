#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity, sanitizeId } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { markFlushed, pruneState } from "./lib/state.js";
import { FLUSH_DEADLINE_MS } from "./lib/constants.js";

// Registered for both SessionEnd and PreCompact. Sealing twice is harmless:
// EverOS answers "no_extraction" on an empty buffer.
runHook("SessionEnd", async (input, ctx) => {
  const { config, debug } = ctx;
  const event = input.hook_event_name ?? "SessionEnd";
  const sessionId = input.session_id;
  if (!sessionId) {
    debug(`${event}: no session_id`);
    return undefined;
  }

  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  try {
    const data = await createClient({ baseUrl: config.baseUrl }).flush(
      { session_id: sanitizeId(sessionId, "unknown"), app_id: identity.appId, project_id: identity.projectId },
      deadline(FLUSH_DEADLINE_MS),
    );
    markFlushed(config.dataDir, sessionId);
    debug(`${event}: flush ${data?.status ?? "ok"}`);
  } catch (error) {
    // Left unflushed on purpose: the next session sweeps it up.
    debug(`${event}: flush failed: ${error.message}`);
  }

  // The session is over, so this is the one moment nobody is waiting on us.
  if (event === "SessionEnd") {
    const removed = pruneState(config.dataDir);
    if (removed) debug(`pruned ${removed} stale state files`);
  }
  return undefined;
});
