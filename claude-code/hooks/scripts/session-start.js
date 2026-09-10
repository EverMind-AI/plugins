#!/usr/bin/env node
import path from "node:path";
import { runHook } from "./lib/hook-io.js";
import { ensureEveros } from "./lib/provision.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { markFlushed, pendingFlushes } from "./lib/state.js";
import { isLoopback } from "./lib/config.js";

/**
 * How long a session must sit untouched before another session may seal it.
 * Recall touches the session on every prompt, so this is thirty minutes of no
 * prompts, not thirty minutes of no captures. Long enough that a live session
 * is never sealed underneath it, short enough that the tail is not stranded.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;
const SWEEP_MAX_SESSIONS = 5;
/**
 * One budget for the whole sweep, not one per session. `/flush` runs real
 * boundary detection, so a few seconds each is normal, and five sequential
 * flushes at the 10s per-call deadline would be 50s against a 15s hook timeout.
 */
const SWEEP_BUDGET_MS = 6000;

// Budget arithmetic against the 15s SessionStart timeout in hooks.json:
// health probe 2s + start wait 5s + this 5s still leaves 3s of margin.
const WARMUP_DEADLINE_MS = 5000;

/**
 * Pay the cold-search cost here instead of on the user's first prompt.
 *
 * The first search of a session was the one that timed out in two of the first
 * three live runs - exactly the prompt where memory matters most. This hook has
 * a 15s budget and nobody waiting on its answer, so it absorbs that cost. One
 * track is enough to warm the shared path; failure is not worth reporting,
 * because whether memory works is what the recall hook will say.
 */
async function warmUp(config, cwd, debug) {
  const identity = resolveIdentity(cwd, config);
  if (!identity.userId) return;
  try {
    await createClient({ baseUrl: config.baseUrl }).search(
      {
        app_id: identity.appId,
        project_id: identity.projectId,
        user_id: identity.userId,
        query: "warm up",
      },
      deadline(WARMUP_DEADLINE_MS),
    );
    debug("search path warmed");
  } catch (error) {
    debug(`warm-up skipped: ${error.message}`);
  }
}

/**
 * Seal the tail of sessions whose own SessionEnd never ran.
 *
 * Claude Code cancels SessionEnd when the host exits in a hurry, which is
 * routine under `claude -p`: the turns after EverOS's last topic boundary then
 * sit in the buffer and are never extracted. Nobody is waiting on this hook, so
 * it is the right place to clean up after the previous session.
 */
async function sweepAbandoned(config, cwd, debug) {
  const abandoned = pendingFlushes(config.dataDir, ABANDONED_AFTER_MS).slice(0, SWEEP_MAX_SESSIONS);
  if (abandoned.length === 0) return;
  const identity = resolveIdentity(cwd, config);
  const client = createClient({ baseUrl: config.baseUrl });
  const signal = deadline(SWEEP_BUDGET_MS);
  for (const { sessionId, projectId } of abandoned) {
    if (signal.aborted) {
      debug("sweep budget spent; the rest wait for the next session");
      return;
    }
    try {
      await client.flush(
        // The recorded project, not this session's: the abandoned session may
        // have belonged to a different repository.
        { session_id: sessionId, app_id: identity.appId, project_id: projectId ?? identity.projectId },
        signal,
      );
      markFlushed(config.dataDir, sessionId);
      debug(`sealed abandoned session ${sessionId}`);
    } catch (error) {
      debug(`could not seal ${sessionId}: ${error.message}`);
      return; // out of budget, or the server is unwell; either way, stop
    }
  }
}

runHook("SessionStart", async (input, ctx) => {
  const { config, debug } = ctx;
  const outcome = await ensureEveros(config);
  const logFile = path.join(config.dataDir, "everos-server.log");
  debug(`session start (${input.source ?? "unknown"}): ${outcome.status}`);

  if (outcome.status === "healthy" || outcome.status === "started") {
    const cwd = input.cwd ?? process.cwd();
    await warmUp(config, cwd, debug);
    await sweepAbandoned(config, cwd, debug);
  }

  switch (outcome.status) {
    case "healthy":
      // Everything typed and every tool result goes to base_url, and EverOS has
      // no authentication of its own. If that address is not this machine, the
      // user should be told which machine it is - once, at the top of the session.
      if (!isLoopback(config.baseUrl)) {
        return { systemMessage: `⚠️ EverOS is remote: this session's transcript is being sent to ${config.baseUrl}, unauthenticated.` };
      }
      return config.verbose ? { systemMessage: `🧠 EverOS ready (${outcome.health?.version ?? "unknown version"})` } : undefined;
    case "started":
      return { systemMessage: "⚡ EverOS started — memory is on." };
    case "starting":
      return { systemMessage: `⏳ EverOS is starting in the background; memory resumes once it is up. Log: ${logFile}` };
    case "no-start-cmd":
      return { systemMessage: `⚠️ EverOS unreachable at ${config.baseUrl} and no start command is set — memory is off. Run /everos:status.` };
    case "spawn-failed":
      return { systemMessage: `⚠️ EverOS could not be started (${outcome.detail}) — memory is off. Run /everos:status.` };
    default:
      return { systemMessage: `⚠️ EverOS unreachable at ${config.baseUrl} — memory is off. Run /everos:status.` };
  }
});
