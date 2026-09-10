import fs from "node:fs";
import path from "node:path";
import { STATE_MAX_PROMPT_IDS, STATE_TTL_DAYS } from "./constants.js";
import { sanitizeId } from "./identity.js";

const EMPTY = () => ({ promptIds: [], warned: false });

function stateDir(dataDir) {
  return path.join(dataDir, "state");
}

export function statePath(dataDir, sessionId) {
  return path.join(stateDir(dataDir), `${sanitizeId(sessionId, "unknown")}.json`);
}

export function readState(dataDir, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dataDir, sessionId), "utf8"));
    return {
      promptIds: Array.isArray(parsed?.promptIds) ? parsed.promptIds.filter((v) => typeof v === "string") : [],
      warned: parsed?.warned === true,
    };
  } catch {
    return EMPTY();
  }
}

function writeState(dataDir, sessionId, state) {
  const file = statePath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  // writeFileSync only applies mode when creating; enforce it for pre-existing files.
  fs.chmodSync(file, 0o600);
}

export function isStored(state, promptId) {
  return typeof promptId === "string" && state.promptIds.includes(promptId);
}

export function markStored(dataDir, sessionId, promptId) {
  const state = readState(dataDir, sessionId);
  if (isStored(state, promptId)) return;
  state.promptIds = [...state.promptIds, promptId].slice(-STATE_MAX_PROMPT_IDS);
  writeState(dataDir, sessionId, state);
}

/** True at most once per session: the caller may print an "EverOS is down" line. */
export function claimWarning(dataDir, sessionId) {
  const state = readState(dataDir, sessionId);
  if (state.warned) return false;
  writeState(dataDir, sessionId, { ...state, warned: true });
  return true;
}

/** Sessions end without telling us; sweep the leftovers on SessionEnd. */
export function pruneState(dataDir, ttlDays = STATE_TTL_DAYS) {
  const dir = stateDir(dataDir);
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
    } catch { /* raced with another window; nothing to do */ }
  }
  return removed;
}
