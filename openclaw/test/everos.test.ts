import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, loadConfig, mergeConfigSources } from "../src/config.js";
import { assertScopeId, createEverosClient, EverosError } from "../src/everos.js";
import type { SearchResponse } from "../src/types.js";

// ── helpers ──────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

/** A fake `fetch` that records the last request and returns a canned reply. */
function fakeFetch(reply: { status?: number; body: unknown }, sink?: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    sink?.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { status = 200, body } = reply;
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const EMPTY_SEARCH: SearchResponse = {
  episodes: [],
  profiles: [],
  agent_cases: [],
  agent_skills: [],
  unprocessed_messages: [],
};

// ── config ─────────────────────────────────────────────────────────────────

test("loadConfig: defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.baseUrl, DEFAULTS.baseUrl);
  assert.equal(cfg.agentId, "openclaw");
  assert.equal(cfg.userId, undefined);
  assert.equal(cfg.queryN, 1);
  assert.equal(cfg.queryMaxChars, 500);
});

test("loadConfig: overrides + trailing-slash strip + bad ints fall back", () => {
  const cfg = loadConfig({
    EVEROS_OC_BASE_URL: "http://host:9000/",
    EVEROS_OC_USER_ID: "kevin",
    EVEROS_OC_AGENT_ID: "openclaw",
    EVEROS_OC_QUERY_N: "3",
    EVEROS_OC_QUERY_MAX_CHARS: "nope",
  });
  assert.equal(cfg.baseUrl, "http://host:9000");
  assert.equal(cfg.userId, "kevin");
  assert.equal(cfg.queryN, 3);
  assert.equal(cfg.queryMaxChars, 500); // bad int → default
});

test("loadConfig: start command — whitespace-split; empty/blank falls back to unset (provision default)", () => {
  assert.deepEqual(loadConfig({ EVEROS_OC_START_CMD: "uv run everos server start" }).startCmd, [
    "uv",
    "run",
    "everos",
    "server",
    "start",
  ]);
  assert.equal(loadConfig({ EVEROS_OC_START_CMD: "" }).startCmd, undefined);
  assert.equal(loadConfig({ EVEROS_OC_START_CMD: "   " }).startCmd, undefined);
  assert.equal(loadConfig({}).startCmd, undefined);
  assert.equal(loadConfig({ EVEROS_OC_EVEROS_DIR: " /opt/everos " }).everosDir, "/opt/everos");
});

test("mergeConfigSources: env wins over host pluginConfig; non-string config values are stringified", () => {
  const merged = mergeConfigSources(
    { EVEROS_OC_BASE_URL: "http://from-env:8000" },
    { EVEROS_OC_BASE_URL: "http://from-config:9000", EVEROS_OC_QUERY_N: 3 },
  );
  assert.equal(merged.EVEROS_OC_BASE_URL, "http://from-env:8000"); // env precedence
  assert.equal(merged.EVEROS_OC_QUERY_N, "3"); // number → string for the env-shaped reader
  const cfg = loadConfig(merged);
  assert.equal(cfg.baseUrl, "http://from-env:8000");
  assert.equal(cfg.queryN, 3);
});

test("mergeConfigSources: a BLANK env var does not shadow a real host-config value (empty = unset)", () => {
  // "export EVEROS_OC_BASE_URL=" in a .env template must not mask host config.
  const merged = mergeConfigSources(
    { EVEROS_OC_BASE_URL: "", EVEROS_OC_USER_ID: "   " },
    { EVEROS_OC_BASE_URL: "http://from-config:9000", EVEROS_OC_USER_ID: "kevin" },
  );
  assert.equal(merged.EVEROS_OC_BASE_URL, "http://from-config:9000");
  assert.equal(merged.EVEROS_OC_USER_ID, "kevin");
  assert.equal(loadConfig(merged).baseUrl, "http://from-config:9000");
});

test("loadConfig: scheme-less base URL is normalized to http:// (fetch + port derivation both work)", () => {
  // 'localhost:' would otherwise parse as a URL SCHEME (port 80, dead fetches)…
  assert.equal(loadConfig({ EVEROS_OC_BASE_URL: "localhost:8000" }).baseUrl, "http://localhost:8000");
  // …and '127.0.0.1:8000' makes `new URL` throw outright.
  assert.equal(loadConfig({ EVEROS_OC_BASE_URL: "127.0.0.1:8000" }).baseUrl, "http://127.0.0.1:8000");
  // scheme-less + trailing slash: both fixed
  assert.equal(loadConfig({ EVEROS_OC_BASE_URL: "host:9000/" }).baseUrl, "http://host:9000");
  // already-schemed values pass through untouched (https preserved)
  assert.equal(loadConfig({ EVEROS_OC_BASE_URL: "https://remote:8443" }).baseUrl, "https://remote:8443");
});

test("loadConfig: an unparseable base URL falls back to the default (never a broken client)", () => {
  assert.equal(loadConfig({ EVEROS_OC_BASE_URL: "not a url at all" }).baseUrl, DEFAULTS.baseUrl);
});

test("loadConfig: quoted start command groups a path with spaces into one argv entry", () => {
  assert.deepEqual(loadConfig({ EVEROS_OC_START_CMD: '"/Users/My Name/.venv/bin/everos" server start' }).startCmd, [
    "/Users/My Name/.venv/bin/everos",
    "server",
    "start",
  ]);
  // single quotes too
  assert.deepEqual(loadConfig({ EVEROS_OC_START_CMD: "'/opt/ever os/bin/everos' server start" }).startCmd, [
    "/opt/ever os/bin/everos",
    "server",
    "start",
  ]);
  // adjacent quoted/unquoted pieces join into one token
  assert.deepEqual(loadConfig({ EVEROS_OC_START_CMD: '/opt/"ever os"/everos start' }).startCmd, [
    "/opt/ever os/everos",
    "start",
  ]);
  // a command of only bare quotes is meaningless → unset
  assert.equal(loadConfig({ EVEROS_OC_START_CMD: '""' }).startCmd, undefined);
});

// ── scope-id validation ─────────────────────────────────────────────────────

test("assertScopeId: accepts safe ids", () => {
  for (const ok of ["openclaw", "my-repo", "a_b.c-1", "default"]) {
    assert.doesNotThrow(() => assertScopeId(ok, "project_id"));
  }
});

test("assertScopeId: rejects path-unsafe ids", () => {
  for (const bad of [".", "..", "a/b", "a b", "", "../x", "a\\b"]) {
    assert.throws(
      () => assertScopeId(bad, "project_id"),
      (e: unknown) => e instanceof EverosError && e.code === "INVALID_SCOPE_ID",
    );
  }
});

// ── client request shaping + envelope handling ──────────────────────────────

test("search: requires exactly one of user_id / agent_id", async () => {
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ body: { request_id: "r", data: EMPTY_SEARCH } }),
  });
  // both
  await assert.rejects(
    () => c.search({ user_id: "u", agent_id: "a", query: "q" } as never),
    (e: unknown) => e instanceof EverosError && e.code === "INVALID_OWNER",
  );
  // neither
  await assert.rejects(
    () => c.search({ query: "q" } as never),
    (e: unknown) => e instanceof EverosError && e.code === "INVALID_OWNER",
  );
});

test("search: unwraps the success envelope's data + posts the right path/body", async () => {
  const calls: Captured[] = [];
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ body: { request_id: "abc", data: EMPTY_SEARCH } }, calls),
  });
  const out = await c.search({
    user_id: "kevin",
    app_id: "openclaw",
    project_id: "everos",
    query: "hi",
    include_profile: true,
  });
  assert.deepEqual(out, EMPTY_SEARCH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://x/api/v1/memory/search");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, {
    user_id: "kevin",
    app_id: "openclaw",
    project_id: "everos",
    query: "hi",
    include_profile: true,
  });
});

test("error envelope (non-2xx) throws EverosError with code/message/requestId", async () => {
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({
      status: 422,
      body: {
        request_id: "req-9",
        error: { code: "HTTP_ERROR", message: "query too short", path: "/api/v1/memory/search" },
      },
    }),
  });
  await assert.rejects(
    () => c.search({ user_id: "u", query: "" }),
    (e: unknown) =>
      e instanceof EverosError &&
      e.status === 422 &&
      e.code === "HTTP_ERROR" &&
      e.message === "query too short" &&
      e.requestId === "req-9",
  );
});

test("add: rejects path-unsafe app_id before any request", async () => {
  const calls: Captured[] = [];
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ body: { request_id: "r", data: { message_count: 1, status: "accumulated" } } }, calls),
  });
  await assert.rejects(
    () => c.add({ session_id: "s", app_id: "..", messages: [] }),
    (e: unknown) => e instanceof EverosError && e.code === "INVALID_SCOPE_ID",
  );
  assert.equal(calls.length, 0); // never hit the network
});

test("health: returns bare {status:'ok'} (no envelope)", async () => {
  const c = createEverosClient({ baseUrl: "http://x", fetch: fakeFetch({ body: { status: "ok" } }) });
  assert.deepEqual(await c.health(), { status: "ok" });
});

test("network failure surfaces as EverosError(NETWORK_ERROR)", async () => {
  const boom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const c = createEverosClient({ baseUrl: "http://x", fetch: boom });
  await assert.rejects(
    () => c.health(),
    (e: unknown) => e instanceof EverosError && e.code === "NETWORK_ERROR",
  );
});

test("health: non-ok status → throws EverosError", async () => {
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ status: 503, body: { status: "starting" } }),
  });
  await assert.rejects(
    () => c.health(),
    (e: unknown) => e instanceof EverosError && e.status === 503,
  );
});

test("health: 200 but body isn't {status:'ok'} → throws", async () => {
  const c = createEverosClient({ baseUrl: "http://x", fetch: fakeFetch({ body: { status: "degraded" } }) });
  await assert.rejects(
    () => c.health(),
    (e: unknown) => e instanceof EverosError,
  );
});

test("call: non-JSON body → BAD_RESPONSE", async () => {
  const html = (async () =>
    new Response("<html>nope</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  const c = createEverosClient({ baseUrl: "http://x", fetch: html });
  await assert.rejects(
    () => c.search({ user_id: "u", query: "q" }),
    (e: unknown) => e instanceof EverosError && e.code === "BAD_RESPONSE" && e.status === 200,
  );
});

test("add: unwraps the success envelope (message_count + status)", async () => {
  const calls: Captured[] = [];
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ body: { request_id: "r", data: { message_count: 3, status: "extracted" } } }, calls),
  });
  const out = await c.add({ session_id: "s", app_id: "openclaw", project_id: "everos", messages: [] });
  assert.deepEqual(out, { message_count: 3, status: "extracted" });
  assert.equal(calls[0]!.url, "http://x/api/v1/memory/add");
  assert.equal(calls[0]!.method, "POST");
});

test("flush: posts /api/v1/memory/flush and unwraps data", async () => {
  const calls: Captured[] = [];
  const c = createEverosClient({
    baseUrl: "http://x",
    fetch: fakeFetch({ body: { request_id: "r", data: { status: "extracted" } } }, calls),
  });
  const out = await c.flush({ session_id: "s", app_id: "openclaw", project_id: "everos" });
  assert.deepEqual(out, { status: "extracted" });
  assert.equal(calls[0]!.url, "http://x/api/v1/memory/flush");
  assert.deepEqual(calls[0]!.body, { session_id: "s", app_id: "openclaw", project_id: "everos" });
});

test("enveloped: 2xx with neither data nor error → unexpected-response throw", async () => {
  const c = createEverosClient({ baseUrl: "http://x", fetch: fakeFetch({ body: { request_id: "r", weird: true } }) });
  await assert.rejects(
    () => c.flush({ session_id: "s", app_id: "openclaw" }),
    (e: unknown) => e instanceof EverosError && /unexpected response/.test((e as Error).message),
  );
});

test("signalFor: attaches an AbortSignal when a timeout is set", async () => {
  let sawSignal: unknown;
  const capture = (async (_url: unknown, init?: RequestInit) => {
    sawSignal = init?.signal;
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const c = createEverosClient({ baseUrl: "http://x", fetch: capture, timeoutMs: 1000 });
  await c.health();
  assert.ok(sawSignal instanceof AbortSignal);
});

// ── live smoke (skipped unless a real EverOS is reachable) ───────────────────

const BASE = process.env.EVEROS_OC_BASE_URL ?? DEFAULTS.baseUrl;

async function everosUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const LIVE = await everosUp();
if (!LIVE) {
  // eslint-disable-next-line no-console
  console.log(`[live smoke] skipped — no EverOS at ${BASE} (start it: \`uv run everos server start\`)`);
}

test("LIVE: /health", { skip: !LIVE }, async () => {
  const c = createEverosClient({ baseUrl: BASE, timeoutMs: 5000 });
  assert.deepEqual(await c.health(), { status: "ok" });
});

test("LIVE: /add buffers a turn", { skip: !LIVE }, async () => {
  // Generous: a freshly-booted EverOS lazily initializes on the first call.
  const c = createEverosClient({ baseUrl: BASE, timeoutMs: 60000 });
  const now = Date.now();
  const out = await c.add({
    session_id: `smoke-${now}`,
    app_id: "openclaw",
    project_id: "everos",
    messages: [
      { sender_id: "smoke-user", role: "user", timestamp: now, content: "hello from the phase-1 smoke test" },
      { sender_id: "openclaw", role: "assistant", timestamp: now + 1, content: "ack" },
    ],
  });
  assert.ok(out.status === "accumulated" || out.status === "extracted", `unexpected status ${out.status}`);
  assert.equal(typeof out.message_count, "number");
});

test("LIVE: /search returns the five arrays", { skip: !LIVE }, async () => {
  const c = createEverosClient({ baseUrl: BASE, timeoutMs: 30000 });
  // Omit `method` to exercise the SAME hybrid path production uses (recall passes no method).
  const out = await c.search({
    user_id: "smoke-user",
    app_id: "openclaw",
    project_id: "everos",
    query: "hello",
    include_profile: true,
  });
  for (const k of ["episodes", "profiles", "agent_cases", "agent_skills", "unprocessed_messages"] as const) {
    assert.ok(Array.isArray(out[k]), `${k} should be an array`);
  }
});
