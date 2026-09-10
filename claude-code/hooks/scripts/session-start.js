#!/usr/bin/env node
import path from "node:path";
import { runHook } from "./lib/hook-io.js";
import { ensureEveros } from "./lib/provision.js";

runHook("SessionStart", async (input, ctx) => {
  const { config, debug } = ctx;
  const outcome = await ensureEveros(config);
  const logFile = path.join(config.dataDir, "everos-server.log");
  debug(`session start (${input.source ?? "unknown"}): ${outcome.status}`);

  switch (outcome.status) {
    case "healthy":
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
