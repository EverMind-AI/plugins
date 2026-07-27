import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP, PLUGIN_ID, parseArgs, parseOpenclawVersion, runSetup, type SetupIo } from "../src/setup.js";

interface FakeIoOptions {
  /** Per-command exit status overrides, keyed by "cmd arg0" prefix match. */
  fail?: string[];
  /** Sequence of answers for ask() prompts. */
  answers?: string[];
  interactive?: boolean;
  /** health() results in call order (last value repeats). */
  health?: boolean[];
  files?: string[];
  /** What `openclaw --version` prints (default: unparseable "ok"). */
  versionOutput?: string;
}

interface FakeIo {
  io: SetupIo;
  calls: string[]; // every exec as "cmd arg0 arg1 …"
  logs: string[];
  asked: string[];
}

function fakeIo(opts: FakeIoOptions = {}): FakeIo {
  const calls: string[] = [];
  const logs: string[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const health = [...(opts.health ?? [false])];
  const io: SetupIo = {
    exec(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const failed = (opts.fail ?? []).some((f) => line.startsWith(f));
      if (!failed && line === "openclaw --version") {
        return { status: 0, output: opts.versionOutput ?? "ok" };
      }
      return { status: failed ? 1 : 0, output: failed ? "boom" : "ok" };
    },
    async ask(q) {
      asked.push(q);
      return answers.shift() ?? "";
    },
    log(m) {
      logs.push(m);
    },
    async health() {
      return health.length > 1 ? (health.shift() as boolean) : (health[0] as boolean);
    },
    fileExists: (p) => (opts.files ?? []).includes(p),
    isInteractive: opts.interactive ?? false,
    sleep: async () => {},
  };
  return { io, calls, logs, asked };
}

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs: defaults", () => {
  const a = parseArgs([]);
  assert.ok(!("error" in a));
  assert.equal(a.spec, "@evermind-ai/openclaw-plugin");
  assert.equal(a.grant, undefined);
  assert.equal(a.restart, true);
  assert.equal(a.baseUrl, "http://127.0.0.1:8000");
});

test("parseArgs: positional spec + flags", () => {
  const a = parseArgs([
    "./plugin.tgz",
    "--grant",
    "--no-restart",
    "--everos-dir",
    "/opt/EverOS",
    "--base-url",
    "http://host:9000/",
  ]);
  assert.ok(!("error" in a));
  assert.equal(a.spec, "./plugin.tgz");
  assert.equal(a.grant, true);
  assert.equal(a.restart, false);
  assert.equal(a.everosDir, "/opt/EverOS");
  assert.equal(a.baseUrl, "http://host:9000"); // trailing slash stripped
});

test("parseArgs: unknown flag, extra positional, missing value → errors", () => {
  assert.ok("error" in parseArgs(["--bogus"]));
  assert.ok("error" in parseArgs(["a.tgz", "b.tgz"]));
  assert.ok("error" in parseArgs(["--everos-dir"]));
});

// ── version floor ────────────────────────────────────────────────────────────

test("parseOpenclawVersion: real output shapes, and garbage", () => {
  assert.deepEqual(parseOpenclawVersion("OpenClaw 2026.7.1-2 (0790d9f)"), [2026, 7, 1]);
  assert.deepEqual(parseOpenclawVersion("2026.6.9"), [2026, 6, 9]);
  assert.equal(parseOpenclawVersion("no version here"), undefined);
});

test("version floor: an older OpenClaw gets a WARNING but setup continues", async () => {
  const f = fakeIo({ health: [true], versionOutput: "OpenClaw 2026.5.7 (abc1234)" });
  const code = await runSetup(["--grant"], f.io);
  assert.equal(code, 0); // warn, never block (fail-open philosophy)
  assert.ok(f.logs.some((l) => l.includes("2026.5.7") && l.includes("tested on >= 2026.6.10")));
  assert.ok(f.calls.some((c) => c.startsWith("openclaw plugins install"))); // still proceeded
});

test("version floor: at/above the floor (or unparseable) → no warning", async () => {
  for (const out of ["OpenClaw 2026.6.10 (x)", "OpenClaw 2026.7.1-2 (y)", "ok"]) {
    const f = fakeIo({ health: [true], versionOutput: out });
    await runSetup(["--grant"], f.io);
    assert.ok(!f.logs.some((l) => l.includes("tested on >=")), `unexpected warn for ${out}`);
  }
});

// ── runSetup flows ───────────────────────────────────────────────────────────

test("setup: happy path — install, granted via flag, EverOS already healthy, restart", async () => {
  const f = fakeIo({ health: [true] });
  const code = await runSetup(["--grant"], f.io);
  assert.equal(code, 0);
  assert.ok(f.calls.some((c) => c.startsWith("openclaw plugins install @evermind-ai/openclaw-plugin --force")));
  assert.ok(
    f.calls.some((c) => c === `openclaw config set plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess true`),
  );
  assert.ok(f.calls.some((c) => c === "openclaw gateway restart"));
  // already healthy → no EverOS start config was written
  assert.ok(!f.calls.some((c) => c.includes("EVEROS_OC_START_CMD")));
  assert.ok(f.logs.some((l) => l.includes("healthy")));
});

test("setup: missing openclaw CLI → clear error, nothing else attempted", async () => {
  const f = fakeIo({ fail: ["openclaw --version"] });
  const code = await runSetup([], f.io);
  assert.equal(code, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(f.logs.some((l) => l.includes("install OpenClaw first")));
});

test("setup: consent prompt — 'y' grants, anything else doesn't", async () => {
  const yes = fakeIo({ interactive: true, answers: ["y"], health: [true] });
  await runSetup([], yes.io);
  assert.ok(yes.calls.some((c) => c.includes("allowConversationAccess true")));

  const no = fakeIo({ interactive: true, answers: ["nah"], health: [true] });
  await runSetup([], no.io);
  assert.ok(!no.calls.some((c) => c.includes("allowConversationAccess")));
  assert.ok(no.logs.some((l) => l.includes("Capture stays OFF")));
});

test("setup: non-interactive with no flag → grant SKIPPED (safe default), instructions printed", async () => {
  const f = fakeIo({ interactive: false, health: [true] });
  const code = await runSetup([], f.io);
  assert.equal(code, 0);
  assert.ok(!f.calls.some((c) => c.includes("allowConversationAccess")));
  assert.ok(f.logs.some((l) => l.includes("--grant")));
});

test("setup: EverOS down + --everos-dir with venv binary → quoted START_CMD + EVEROS_DIR, then polls to healthy", async () => {
  const f = fakeIo({
    health: [false, true], // pre-check down; first poll healthy
    files: ["/opt/Ever OS/.venv/bin/everos"],
    fail: ["everos --help"], // not on PATH
  });
  const code = await runSetup(["--grant", "--everos-dir", "/opt/Ever OS"], f.io);
  assert.equal(code, 0);
  assert.ok(
    f.calls.some(
      (c) =>
        c ===
        `openclaw config set plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_START_CMD "/opt/Ever OS/.venv/bin/everos" server start`,
    ),
  );
  assert.ok(
    f.calls.some(
      (c) => c === `openclaw config set plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_EVEROS_DIR /opt/Ever OS`,
    ),
  );
  assert.ok(f.logs.some((l) => l.includes("healthy")));
});

test("setup: EverOS down, dir given but NO venv binary → dir set, default start command kept", async () => {
  const f = fakeIo({ health: [false], fail: ["everos --help"] });
  await runSetup(["--grant", "--everos-dir", "/opt/EverOS"], f.io);
  assert.ok(!f.calls.some((c) => c.includes("EVEROS_OC_START_CMD")));
  assert.ok(f.calls.some((c) => c.includes("EVEROS_OC_EVEROS_DIR /opt/EverOS")));
  assert.ok(f.logs.some((l) => l.includes("leaving the default start command")));
});

test("setup: EverOS down, everos on PATH → no config writes, still polls after restart", async () => {
  const f = fakeIo({ health: [false, false, true] });
  const code = await runSetup(["--grant"], f.io);
  assert.equal(code, 0);
  assert.ok(f.calls.some((c) => c === "everos --help"));
  assert.ok(!f.calls.some((c) => c.includes("EVEROS_OC_")));
  assert.ok(f.logs.some((l) => l.includes("healthy")));
});

test("setup: EverOS down, nothing resolvable, non-interactive → no poll, fail-open note", async () => {
  const f = fakeIo({ health: [false], fail: ["everos --help"], interactive: false });
  const code = await runSetup(["--grant"], f.io);
  assert.equal(code, 0); // not fatal — plugin is fail-open by design
  assert.ok(f.logs.some((l) => l.includes("fail-open")));
});

test("setup: interactive prompt for the EverOS checkout is honored", async () => {
  const f = fakeIo({
    health: [false, true],
    fail: ["everos --help"],
    interactive: true,
    answers: ["y", "/Users/me/EverOS"],
    files: ["/Users/me/EverOS/.venv/bin/everos"],
  });
  const code = await runSetup([], f.io);
  assert.equal(code, 0);
  assert.ok(f.calls.some((c) => c.includes('EVEROS_OC_START_CMD "/Users/me/EverOS/.venv/bin/everos" server start')));
});

test("setup: a non-default --base-url is ALSO written into the plugin config", async () => {
  // Polling a custom URL while the plugin talks to the default port would
  // "succeed" against a server the plugin never uses.
  const f = fakeIo({ health: [true] });
  await runSetup(["--grant", "--base-url", "http://127.0.0.1:9100"], f.io);
  assert.ok(
    f.calls.some(
      (c) => c === `openclaw config set plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_BASE_URL http://127.0.0.1:9100`,
    ),
  );
});

test("setup: the DEFAULT base url is not needlessly written to config", async () => {
  const f = fakeIo({ health: [true] });
  await runSetup(["--grant"], f.io);
  assert.ok(!f.calls.some((c) => c.includes("EVEROS_OC_BASE_URL")));
});

test("setup: --no-restart skips restart and the health poll", async () => {
  const f = fakeIo({ health: [true] });
  await runSetup(["--grant", "--no-restart"], f.io);
  assert.ok(!f.calls.some((c) => c === "openclaw gateway restart"));
  assert.ok(f.logs.some((l) => l.includes("--no-restart")));
});

test("setup: install failure surfaces output and aborts", async () => {
  const f = fakeIo({ fail: ["openclaw plugins install"] });
  const code = await runSetup(["--grant"], f.io);
  assert.equal(code, 1);
  assert.ok(f.logs.some((l) => l.includes("install failed")));
  assert.ok(!f.calls.some((c) => c.includes("allowConversationAccess"))); // stopped before grant
});

test("setup: unhealthy after full poll → warning with troubleshooting pointer, still exit 0", async () => {
  const f = fakeIo({ health: [false] }); // stays down forever
  const code = await runSetup(["--grant", "--everos-dir", "/x", "--start-cmd", "everos server start"], f.io);
  assert.equal(code, 0);
  assert.ok(f.logs.some((l) => l.includes("did not become healthy")));
});

test("setup: --help prints usage and exits 0", async () => {
  const f = fakeIo();
  const code = await runSetup(["--help"], f.io);
  assert.equal(code, 0);
  assert.equal(f.calls.length, 0);
  assert.ok(f.logs.join("\n").includes(HELP.slice(0, 30)));
});
