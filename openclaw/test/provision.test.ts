import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import type { EverosClient } from "../src/everos.js";
import { portFromUrl, provision, waitForHealthy } from "../src/provision.js";

const HEALTH_OK = { status: "ok" as const };

/** Minimal EverosClient whose `health` is driven by a supplied function. */
function clientWithHealth(health: () => Promise<unknown>): EverosClient {
  return {
    health: health as EverosClient["health"],
    add: async () => ({ message_count: 0, status: "accumulated" }),
    search: async () => ({ episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] }),
    flush: async () => ({ status: "no_extraction" }),
  };
}

const fakeChild = {
  on() {
    return fakeChild;
  },
  kill() {},
} as unknown as ChildProcess;

test("portFromUrl", () => {
  assert.equal(portFromUrl("http://127.0.0.1:8000"), "8000");
  assert.equal(portFromUrl("http://localhost:1995/"), "1995");
  assert.equal(portFromUrl("https://example.com"), "443");
  assert.equal(portFromUrl("http://example.com"), "80");
});

test("portFromUrl: never throws — garbage falls back to EverOS's default port", () => {
  // A throw here would reject provision() into register's silent catch — the
  // "attempting to start… then nothing, no log" failure an audit flagged.
  assert.equal(portFromUrl("127.0.0.1:8000"), "8000"); // scheme-less → Invalid URL pre-fix
  assert.equal(portFromUrl("not a url at all"), "8000");
  assert.equal(portFromUrl(""), "8000");
});

test("waitForHealthy: resolves true once health succeeds", async () => {
  let n = 0;
  const client = clientWithHealth(async () => {
    if (++n < 3) throw new Error("not yet");
    return HEALTH_OK;
  });
  assert.equal(await waitForHealthy(client, 2000, 5), true);
  assert.ok(n >= 3);
});

test("waitForHealthy: resolves false on timeout", async () => {
  const client = clientWithHealth(async () => {
    throw new Error("down");
  });
  assert.equal(await waitForHealthy(client, 60, 10), false);
});

test("provision: already-running → no spawn", async () => {
  let spawned = 0;
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => HEALTH_OK),
    spawnFn: (() => {
      spawned++;
      return fakeChild;
    }) as never,
  });
  assert.equal(res.status, "already-running");
  assert.equal(spawned, 0);
});

test("provision: starts EverOS, forces mode=agent + port, becomes healthy", async () => {
  let n = 0;
  const client = clientWithHealth(async () => {
    // first call = the initial detect (fail); then heal on the 2nd poll
    if (++n < 2) throw new Error("starting");
    return HEALTH_OK;
  });
  let captured: { cmd: string; args: string[]; env: Record<string, string | undefined> } | undefined;
  const spawnFn = ((cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    captured = { cmd, args, env: opts.env ?? {} };
    return fakeChild;
  }) as never;

  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client,
    spawnFn,
    startCommand: ["everos", "server", "start"],
    readinessTimeoutMs: 2000,
    readinessIntervalMs: 5,
  });

  assert.equal(res.status, "started");
  assert.equal(captured?.cmd, "everos");
  assert.deepEqual(captured?.args, ["server", "start"]);
  assert.equal(captured?.env.EVEROS_MEMORIZE__MODE, "agent");
  assert.equal(captured?.env.EVEROS_API__PORT, "8000");
  assert.equal(typeof res.stop, "function");
});

test("provision: spawn failure → fail-open (status failed)", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => {
      throw new Error("ENOENT: everos not found");
    }) as never,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /ENOENT/);
});

test("provision: readiness timeout leaves a still-alive child running (no kill, hands back stop)", async () => {
  let killed = false;
  const aliveChild = {
    on() {
      return aliveChild;
    },
    kill() {
      killed = true;
    },
  } as unknown as ChildProcess;
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("never healthy");
    }),
    spawnFn: (() => aliveChild) as never,
    readinessTimeoutMs: 50,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /readiness/);
  assert.equal(killed, false); // must NOT SIGTERM a slow-but-alive server
  assert.equal(typeof res.stop, "function"); // host can still stop it on shutdown
});

test("provision: child that exits early short-circuits the wait (no zombie stop handle)", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => spawnedChild({ exitCode: 1 })) as never,
    readinessTimeoutMs: 10_000, // long: if we waited this out the test would hang
    readinessIntervalMs: 20,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /exited/);
  assert.equal(res.stop, undefined); // process is already dead — no handle to hand back
});

/**
 * Fake ChildProcess. Captures the listeners `provision` attaches, then drives them in a
 * chosen order. `order: "exit-first"` reproduces the real Node hazard where `exit` fires
 * BEFORE stdio is flushed and `close` arrives — the ordering the self-heal must survive.
 * `errorMsg` fires an async `error` (e.g. ENOENT) instead of a clean exit/close.
 */
type FakeOpts = {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number | null;
  order?: "normal" | "exit-first";
  errorMsg?: string;
  onClosed?: () => void;
};
function spawnedChild(opts: FakeOpts = {}): ChildProcess {
  const { stdout = [], stderr = [], exitCode = 0, order = "normal", errorMsg, onClosed } = opts;
  const dl: { stdout?: (b: Buffer) => void; stderr?: (b: Buffer) => void } = {};
  const cl: Record<string, ((...a: unknown[]) => void) | undefined> = {};
  const stream = (which: "stdout" | "stderr") => {
    const s = {
      on(ev: string, cb: (b: Buffer) => void) {
        if (ev === "data") dl[which] = cb;
        return s;
      },
    };
    return s;
  };
  const child: Record<string, unknown> = {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    kill() {},
    on(ev: string, cb: (...a: unknown[]) => void) {
      cl[ev] = cb;
      return child;
    },
  };
  const emitData = (): void => {
    for (const c of stdout) dl.stdout?.(Buffer.from(c));
    for (const c of stderr) dl.stderr?.(Buffer.from(c));
  };
  const emitClose = (): void => {
    cl.close?.(exitCode, null);
    onClosed?.();
  };
  // Drive emissions a microtask later, once provision has attached its listeners.
  queueMicrotask(() => {
    if (errorMsg) {
      cl.error?.(new Error(errorMsg));
      return;
    }
    if (order === "exit-first") {
      cl.exit?.(exitCode, null); // exit BEFORE stdio drains…
      queueMicrotask(() => {
        emitData(); // …late data (the lock traceback)…
        queueMicrotask(emitClose); // …then close (stdio finally drained).
      });
    } else {
      emitData();
      cl.exit?.(exitCode, null);
      emitClose();
    }
  });
  return child as unknown as ChildProcess;
}

const LOCK_ERR =
  "everos.infra.ome.exceptions.EngineLockHeldError: another OfflineEngine instance already holds " +
  "/Users/x/.everos/.index/sqlite/ome.db.lock";

test("provision: OME lock conflict self-heals when another instance becomes healthy", async () => {
  let n = 0;
  // detect (1) fails; our spawned child dies on the lock; a few polls later the instance
  // that actually holds the lock answers /health.
  const client = clientWithHealth(async () => {
    if (++n < 4) throw new Error("not yet");
    return HEALTH_OK;
  });
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client,
    spawnFn: (() => spawnedChild({ stderr: [LOCK_ERR], exitCode: 3 })) as never,
    readinessTimeoutMs: 2000,
    readinessIntervalMs: 5,
  });
  assert.equal(res.status, "already-running"); // recovered onto the lock holder
  assert.equal(res.stop, undefined); // we don't own that instance → no stop handle
});

test("provision: self-heals even when 'exit' fires BEFORE the lock text is flushed (exit/close race)", async () => {
  // health only passes AFTER the child has fully closed — so if provision had aborted on
  // the early 'exit' (the bug the review caught), it would return failed before health
  // could ever pass. Passing here proves the abort is gated on 'close', not 'exit'.
  let closed = false;
  const client = clientWithHealth(async () => (closed ? HEALTH_OK : Promise.reject(new Error("not yet"))));
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client,
    spawnFn: (() =>
      spawnedChild({ order: "exit-first", stderr: [LOCK_ERR], exitCode: 3, onClosed: () => (closed = true) })) as never,
    readinessTimeoutMs: 2000,
    readinessIntervalMs: 5,
  });
  assert.equal(res.status, "already-running"); // the race did NOT defeat self-heal
  assert.equal(res.stop, undefined);
});

test("provision: OME lock conflict that never heals → failed with a clear lock message", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => spawnedChild({ stderr: [LOCK_ERR], exitCode: 3 })) as never,
    readinessTimeoutMs: 60,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /OME lock/i); // actionable, not just "code=3"
  assert.equal(res.stop, undefined);
});

test("provision: a genuine crash surfaces the child's stderr (no longer hidden by stdio:ignore)", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() =>
      spawnedChild({ stderr: ["ModuleNotFoundError: No module named 'everalgo'"], exitCode: 1 })) as never,
    readinessTimeoutMs: 5000,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /ModuleNotFoundError/); // the real reason, previously invisible
});

test("provision: async spawn error (ENOENT) fails fast, surfaces the reason, no stop handle", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => spawnedChild({ errorMsg: "spawn everos ENOENT" })) as never,
    readinessTimeoutMs: 10_000, // would hang if we didn't bail on the error
    readinessIntervalMs: 20,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /ENOENT|failed to start/i);
  assert.equal(res.stop, undefined);
});

test("provision: a lock conflict reported on STDOUT (not stderr) is still detected", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => spawnedChild({ stdout: [LOCK_ERR], exitCode: 3 })) as never,
    readinessTimeoutMs: 60,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /OME lock/i); // captured via stdout, not just stderr
});

test("provision: lock signal survives later output evicting it from the ring buffer", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() => spawnedChild({ stderr: [LOCK_ERR, "x".repeat(5000)], exitCode: 3 })) as never,
    readinessTimeoutMs: 60,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /OME lock/i); // latched at capture time, not re-scanned from the tail
});

test("provision: incidental 'lock' wording in a crash is NOT treated as an OME conflict", async () => {
  const res = await provision({
    baseUrl: "http://127.0.0.1:8000",
    client: clientWithHealth(async () => {
      throw new Error("down");
    }),
    spawnFn: (() =>
      spawnedChild({
        stderr: ["WARNING: could not acquire advisory lock on cache; giving up\nRuntimeError: boom"],
        exitCode: 1,
      })) as never,
    readinessTimeoutMs: 5000,
    readinessIntervalMs: 10,
  });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /RuntimeError|boom/); // surfaced as a real crash…
  assert.doesNotMatch(res.detail, /OME lock/i); // …not misclassified as the lock conflict
});
