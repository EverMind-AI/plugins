import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { statePath, markStored } from "../hooks/scripts/lib/state.js";

const SCRIPT = "hooks/scripts/flush.js";
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-flush-")); }
function envFor(server, dir) {
  return { EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj" };
}

test("SessionEnd seals the session buffer and writes nothing", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd", reason: "clear" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    const flushes = server.only("/api/v2/memory/flush");
    assert.equal(flushes.length, 1);
    assert.deepEqual(flushes[0].body, { session_id: "s1", app_id: "claude-code", project_id: "proj" });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("PreCompact seals the same way", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "PreCompact", trigger: "auto" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/flush").length, 1);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SessionEnd prunes stale state files; PreCompact does not", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    markStored(dir, "ancient", "p");
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(statePath(dir, "ancient"), stale, stale);

    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "PreCompact" }, envFor(server, dir));
    assert.equal(fs.existsSync(statePath(dir, "ancient")), true);

    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    assert.equal(fs.existsSync(statePath(dir, "ancient")), false);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unreachable EverOS exits 0 silently", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a missing session id posts nothing", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/flush").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
