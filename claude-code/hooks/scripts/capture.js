#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { readTurn, toEverosMessages } from "./lib/transcript.js";
import { readState, isStored, markStored } from "./lib/state.js";
import { ADD_MAX_MESSAGES, CAPTURE_DEADLINE_MS } from "./lib/constants.js";

runHook("Stop", async (input, ctx) => {
  const { config, debug } = ctx;
  const sessionId = input.session_id;
  const promptId = input.prompt_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !promptId || !transcriptPath) {
    debug(`missing stdin fields: session_id=${sessionId} prompt_id=${promptId} transcript_path=${transcriptPath}`);
    return undefined;
  }

  // Stop can fire twice for one prompt (interrupt, then resume). EverOS does not dedupe.
  if (isStored(readState(config.dataDir, sessionId), promptId)) {
    debug(`already stored: ${promptId}`);
    return undefined;
  }

  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  if (!identity.userId) {
    debug("no user id; skipping capture");
    return undefined;
  }

  const turn = await readTurn(transcriptPath, promptId);
  const messages = toEverosMessages(turn, identity);
  if (messages.length === 0) {
    debug(`nothing to capture for ${promptId}`);
    return undefined;
  }

  const client = createClient({ baseUrl: config.baseUrl });
  const signal = deadline(CAPTURE_DEADLINE_MS);
  for (let start = 0; start < messages.length; start += ADD_MAX_MESSAGES) {
    const batch = messages.slice(start, start + ADD_MAX_MESSAGES);
    try {
      await client.add(
        { session_id: sessionId, app_id: identity.appId, project_id: identity.projectId, messages: batch },
        signal,
      );
    } catch (error) {
      // Deliberately no retry: a 5xx may already have committed, and re-sending
      // would double-write. Leaving the prompt unmarked lets a re-fired Stop retry.
      debug(`add failed at offset ${start}: ${error.message}`);
      return undefined;
    }
  }

  markStored(config.dataDir, sessionId, promptId);
  debug(`stored ${messages.length} messages for ${promptId}`);
  return config.verbose ? { systemMessage: `💾 EverOS: saved ${messages.length} messages` } : undefined;
});
