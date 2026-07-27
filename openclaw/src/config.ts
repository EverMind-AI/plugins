/**
 * Plugin-side configuration, read from `EVEROS_OC_*` keys.
 *
 * These are CLIENT-side knobs (where EverOS is, who the developer/agent is,
 * how the recall query is built, how to auto-start EverOS). They are NOT
 * EverOS settings — extraction, storage and model choice all stay in EverOS's
 * own config (mirror principle).
 *
 * Sources, in precedence order: process env vars override host-managed plugin
 * config (`plugins.entries.<id>.config`, delivered via `api.pluginConfig`),
 * which overrides the defaults. Empty/whitespace values are treated as unset.
 */

export interface EverosOcConfig {
  /** EverOS HTTP base URL. */
  baseUrl: string;
  /**
   * Developer identity for the user track (`sender_id` of user messages).
   * When unset, resolved from `$USER` / `$USERNAME` / the OS account
   * (see `resolveUserId` in register.ts).
   */
  userId: string | undefined;
  /** Constant pooled agent identity for the agent track. */
  agentId: string;
  /** How many recent user messages form the recall query (N). */
  queryN: number;
  /** Head-clip budget for the recall query (chars). */
  queryMaxChars: number;
  /** argv to auto-start EverOS (split on whitespace; quotes group a spaced path).
   *  Unset → provision's default. */
  startCmd: string[] | undefined;
  /** Working directory for the auto-started EverOS process. */
  everosDir: string | undefined;
}

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8000",
  agentId: "openclaw",
  queryN: 1,
  queryMaxChars: 500,
} as const;

function intFrom(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalize the EverOS base URL. Scheme-less values (`localhost:8000`,
 * `127.0.0.1:8000`) are how people naturally write it, but `new URL` either reads
 * `localhost:` as a SCHEME (every fetch then fails and provisioning derives port
 * 80) or throws outright (`127.0.0.1:8000`) — so prepend `http://` when no
 * http(s) scheme is present. A value that STILL doesn't parse falls back to the
 * default: a broken URL would otherwise silently disable recall, capture AND
 * provisioning at once, which is strictly worse than talking to the default.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  let v = raw?.trim() || DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    new URL(v);
  } catch {
    v = DEFAULTS.baseUrl;
  }
  return v.replace(/\/+$/, "");
}

/**
 * Split a start command into argv, honoring single/double quotes so a path with
 * spaces is expressible: `"/Users/My Name/.venv/bin/everos" server start`.
 * Adjacent quoted/unquoted pieces join into one token (`ab"c d"` → `abc d`).
 * This is argv splitting only — no escapes, no expansion, not a shell.
 */
export function splitCommand(raw: string): string[] {
  const out: string[] = [];
  let prevEnd = -1;
  for (const m of raw.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)) {
    const piece = m[1] ?? m[2] ?? m[3] ?? "";
    const idx = m.index ?? -1;
    if (idx === prevEnd && out.length > 0) out[out.length - 1] += piece;
    else out.push(piece);
    prevEnd = idx + m[0].length;
  }
  return out.filter(Boolean); // a token can only be empty from a bare ""/'' — meaningless for spawn
}

/**
 * Merge host-managed plugin config (lower precedence) under env vars (higher).
 * `pluginConfig` values may be non-strings (the manifest schema types some keys
 * as numbers) — stringify them so the env-shaped reader handles both sources.
 */
export function mergeConfigSources(
  env: Record<string, string | undefined>,
  pluginConfig: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(pluginConfig ?? {})) {
    if (v != null) merged[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) {
    // Blank env ("export EVEROS_OC_X=", common in .env templates) must NOT shadow
    // a real host-configured value — the header promises "empty = unset".
    if (v != null && v.trim() !== "") merged[k] = v;
  }
  return merged;
}

/** Build the typed config from an env-shaped map (defaults to `process.env`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): EverosOcConfig {
  const baseUrl = normalizeBaseUrl(env.EVEROS_OC_BASE_URL);
  const userId = env.EVEROS_OC_USER_ID?.trim() || undefined;
  const agentId = env.EVEROS_OC_AGENT_ID?.trim() || DEFAULTS.agentId;
  // Empty/whitespace → unset (falls back to provision's default command), so a
  // blank EVEROS_OC_START_CMD can't silently disable provisioning.
  const startRaw = env.EVEROS_OC_START_CMD?.trim();
  const startTokens = startRaw ? splitCommand(startRaw) : [];
  const startCmd = startTokens.length > 0 ? startTokens : undefined;
  const everosDir = env.EVEROS_OC_EVEROS_DIR?.trim() || undefined;
  return {
    baseUrl,
    userId,
    agentId,
    queryN: intFrom(env.EVEROS_OC_QUERY_N, DEFAULTS.queryN),
    queryMaxChars: intFrom(env.EVEROS_OC_QUERY_MAX_CHARS, DEFAULTS.queryMaxChars),
    startCmd,
    everosDir,
  };
}
