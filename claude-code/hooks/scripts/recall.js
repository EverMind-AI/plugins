#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { shouldRecall, buildQuery } from "./lib/query.js";
import { render, summaryLine } from "./lib/render.js";
import { claimWarning } from "./lib/state.js";
import { RECALL_DEADLINE_MS } from "./lib/constants.js";

runHook("UserPromptSubmit", async (input, ctx) => {
  const { config, debug } = ctx;
  const prompt = input.prompt ?? "";
  if (!shouldRecall(prompt)) {
    debug("skipped: slash command or below the token floor");
    return undefined;
  }

  const sessionId = input.session_id ?? "unknown";
  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  const client = createClient({ baseUrl: config.baseUrl });
  const query = buildQuery(prompt);
  // One signal for both tracks: the user pays this latency on every prompt.
  const signal = deadline(RECALL_DEADLINE_MS);
  const common = { app_id: identity.appId, project_id: identity.projectId, query };

  const userTrack = identity.userId
    ? client
        .search({ ...common, user_id: identity.userId, include_profile: true }, signal)
        .catch((error) => { debug(`user track failed: ${error.message}`); return null; })
    : Promise.resolve(null);
  const agentTrack = client
    .search({ ...common, agent_id: identity.agentId }, signal)
    .catch((error) => { debug(`agent track failed: ${error.message}`); return null; });

  const [userData, agentData] = await Promise.all([userTrack, agentTrack]);

  if (!identity.userId && claimWarning(config.dataDir, sessionId)) {
    return { systemMessage: "⚠️ EverOS: no user id could be derived — set EVEROS_CC_USER_ID. Personal memory is off for this session." };
  }
  if (userData === null && agentData === null) {
    return claimWarning(config.dataDir, sessionId)
      ? { systemMessage: `⚠️ EverOS unreachable at ${config.baseUrl} — memory is off for this session. Run /everos:status.` }
      : undefined;
  }

  const rendered = render(userData, agentData);
  if (!rendered) {
    debug("no hits");
    return config.verbose ? { systemMessage: "🧠 EverOS: no relevant memory" } : undefined;
  }
  return { additionalContext: rendered.block, systemMessage: summaryLine(rendered.counts) ?? undefined };
});
