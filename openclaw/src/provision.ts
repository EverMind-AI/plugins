/**
 * Provisioning (Phase 2).
 *
 * detect-then-provision: on startup, health-check EverOS; if it's not up, try
 * to start it (spawn a configured command, forcing `mode=agent` + the right
 * port), then poll until healthy. Everything is **fail-open** — if EverOS
 * can't be reached or started, we log and carry on; recall/capture just no-op.
 *
 * Scope note: auto-INSTALL ("self-install via uv/pip") is only attempted when
 * an explicit `installCommand` is configured — we don't hard-code an install
 * spec we haven't verified. Auto-respawn of a crashed server is intentionally
 * out of scope for now (a dead EverOS simply fail-opens recall/capture).
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createEverosClient, type EverosClient } from "./everos.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export interface ProvisionOptions {
  baseUrl: string;
  /** argv to start EverOS. Default `["everos", "server", "start"]`. */
  startCommand?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra env for the child. `EVEROS_MEMORIZE__MODE=agent` is always forced. */
  env?: Record<string, string>;
  /** Total time to wait for `/health` after a start (ms). */
  readinessTimeoutMs?: number;
  /** Poll interval while waiting for readiness (ms). */
  readinessIntervalMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  client?: EverosClient;
  spawnFn?: typeof spawn;
  /**
   * Called synchronously right after the child is spawned, with a `stop` that kills it.
   * Lets the caller cancel an *in-flight* start (before provision resolves) so a gateway
   * shutdown mid-startup can't orphan the child (which would then hold the OME lock).
   */
  onStop?: (stop: () => void) => void;
}

export type ProvisionStatus = "already-running" | "started" | "failed";

export interface ProvisionResult {
  status: ProvisionStatus;
  detail: string;
  /** Present when we spawned a child. Stops it (used by the host's service.stop). */
  stop?: () => void;
}

/**
 * Derive the port from a base URL (defaults: 443 https, else 80). Never throws:
 * provision() promises fail-open, and a throw here would reject it into
 * register's silent catch — loadConfig normalizes the URL, but a direct caller
 * could still pass garbage, so fall back to EverOS's own default port.
 */
export function portFromUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.port) return u.port;
    return u.protocol === "https:" ? "443" : "80";
  } catch {
    return "8000";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `/health` until healthy or the budget runs out. If `shouldAbort` is
 * supplied and returns true (e.g. the spawned child has exited), give up early
 * instead of polling a dead process for the whole window.
 */
export async function waitForHealthy(
  client: EverosClient,
  timeoutMs: number,
  intervalMs: number,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shouldAbort?.()) return false;
    try {
      await client.health({ timeoutMs: Math.min(2000, Math.max(500, intervalMs * 2)) });
      return true;
    } catch {
      if (shouldAbort?.()) return false;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }
}

/**
 * Detect EverOS and, if absent, attempt to start it. Always resolves — never
 * throws — so a gateway boot is never blocked.
 */
export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const log = options.logger ?? noopLogger;
  const client = options.client ?? createEverosClient({ baseUrl: options.baseUrl });
  const doSpawn = options.spawnFn ?? spawn;
  const startCommand = options.startCommand ?? ["everos", "server", "start"];
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const readinessIntervalMs = options.readinessIntervalMs ?? 1_000;

  // 1. Already running?
  try {
    await client.health({ timeoutMs: 2000 });
    log.info(`[everos] already running at ${options.baseUrl}`);
    return { status: "already-running", detail: "health check passed" };
  } catch {
    log.info(`[everos] not reachable at ${options.baseUrl}; attempting to start`);
  }

  // 2. Start it (forcing agent mode + the configured port).
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    EVEROS_MEMORIZE__MODE: "agent",
    EVEROS_API__PORT: portFromUrl(options.baseUrl),
  };
  // Pipe stdout+stderr (was `"ignore"`, which hid every startup failure behind a bare
  // exit code). We ring-buffer the tail so a crash is diagnosable AND so we can detect
  // the OME single-instance lock conflict below. Both streams must be drained to avoid
  // a full pipe blocking the child.
  const spawnOpts: SpawnOptions = {
    cwd: options.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  };

  let child: ChildProcess;
  try {
    const [cmd, ...args] = startCommand;
    if (!cmd) throw new Error("empty startCommand");
    child = doSpawn(cmd, args, spawnOpts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`[everos] failed to spawn (${startCommand.join(" ")}): ${detail} — fail-open`);
    return { status: "failed", detail };
  }

  const stop = (): void => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  // Hand the kill back immediately so an in-flight start is cancellable (before we've
  // even confirmed health), not only via the resolved ProvisionResult.
  options.onStop?.(stop);

  // EverOS's OME engine takes a single-instance exclusive lock (ome.db.lock). On a
  // restart a previous instance can still hold it — still shutting down, cold-starting,
  // or orphaned by an ungraceful gateway kill — so OUR freshly-spawned child dies with
  // EngineLockHeldError. That is NOT a real failure: the *other* instance is (coming) up.
  // On a lock conflict we keep polling /health instead of giving up, self-healing onto
  // whichever instance holds the lock.
  //
  // We LATCH that signal as chunks arrive (not by re-scanning the buffer) so it survives
  // both (a) later output evicting it from the bounded tail and (b) the exit-before-drain
  // ordering below. The tail is kept only to surface the reason on a genuine failure.
  const LOCK_RE = /EngineLockHeldError|OfflineEngine instance already holds|LockException/i;
  const MAX_OUTPUT_TAIL = 4000;
  let outputTail = "";
  let sawLockConflict = false;
  const capture = (buf: Buffer | string): void => {
    const s = buf.toString();
    if (!sawLockConflict && LOCK_RE.test(s)) sawLockConflict = true;
    outputTail = (outputTail + s).slice(-MAX_OUTPUT_TAIL);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const lastOutputLines = (): string =>
    outputTail
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" | ");

  // Treat the child as "done" only on `close` (fires after ALL stdio is drained → capture
  // and sawLockConflict are complete) or `error` (spawn failed, e.g. ENOENT). `exit` alone
  // fires BEFORE stdio is flushed, so it must NOT drive the abort/lock decision — it only
  // records the exit code for the message.
  let childDone = false;
  let exitDetail = "";
  let readinessSettled = false;
  const warnUnlessLock = (): void => {
    if (!readinessSettled && !sawLockConflict) log.warn(`[everos] ${exitDetail} — fail-open`);
  };
  child.on("exit", (code, signal) => {
    exitDetail = `child exited (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}) before healthy`;
  });
  child.on("error", (err) => {
    childDone = true;
    if (!exitDetail) exitDetail = `child failed to start: ${err.message}`;
    warnUnlessLock();
  });
  child.on("close", () => {
    childDone = true;
    if (!exitDetail) exitDetail = "child closed before healthy";
    warnUnlessLock();
  });

  // 3. Wait until it answers /health. Bail early once the child is done — UNLESS it lost the
  // OME lock race, in which case another instance is coming up and health may still pass.
  const healthy = await waitForHealthy(
    client,
    readinessTimeoutMs,
    readinessIntervalMs,
    () => childDone && !sawLockConflict,
  );
  readinessSettled = true;

  if (healthy) {
    if (childDone) {
      // Our start lost the lock race, but EverOS is up via an instance we don't own —
      // so don't hand back a stop handle (killing it would take down someone else's server).
      log.info(`[everos] healthy via another instance (our start hit the OME lock) at ${options.baseUrl}`);
      return { status: "already-running", detail: "another instance holds the OME lock and is healthy" };
    }
    log.info(`[everos] started and healthy at ${options.baseUrl}`);
    return { status: "started", detail: "spawned + healthy", stop };
  }

  // Not healthy within the budget.
  if (childDone) {
    const tail = lastOutputLines();
    if (sawLockConflict) {
      const detail =
        "OME lock held by another EverOS instance that never became healthy — a stray/wedged " +
        "'everos server' process may be holding ~/.everos/.index/sqlite/ome.db.lock";
      log.warn(`[everos] ${detail} — fail-open${tail ? ` :: ${tail}` : ""}`);
      return { status: "failed", detail };
    }
    // A genuine crash — surface the captured output (previously invisible under stdio:"ignore").
    const reason = exitDetail || "child exited before healthy";
    log.warn(`[everos] ${reason} — fail-open${tail ? ` :: ${tail}` : ""}`);
    return { status: "failed", detail: tail ? `${reason}: ${tail}` : reason };
  }

  // Still alive but not healthy yet — likely a slow cold-start (model/index load).
  // Do NOT kill it: it may warm up shortly and recall/capture fail-open until then.
  // Hand back the stop handle so the host can stop it on shutdown.
  log.warn(
    `[everos] not healthy within ${readinessTimeoutMs}ms; leaving it running (may still be starting) — fail-open`,
  );
  return { status: "failed", detail: "readiness timeout (left running)", stop };
}
