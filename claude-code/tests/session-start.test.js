import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";

const SCRIPT = "hooks/scripts/session-start.js";
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-start-")); }

test("a healthy EverOS produces no output", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a start command that cannot run is reported as a failure, not as starting", async () => {
  // A blank EVEROS_CC_START_CMD falls back to the default by design, so the
  // reachable "cannot start" case is a command that does not exist.
  const dir = tmp();
  try {
    const { code, json } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_START_CMD: "definitely-not-a-real-binary-xyz",
    });
    assert.equal(code, 0);
    assert.ok(json.systemMessage.includes("could not be started"), json.systemMessage);
    assert.ok(json.systemMessage.includes("/everos:status"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a non-loopback address is reported unreachable, never started", async () => {
  const dir = tmp();
  try {
    const { json } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w" }, {
      EVEROS_CC_BASE_URL: "http://10.255.255.1:8000", EVEROS_CC_DATA_DIR: dir,
    });
    assert.ok(json.systemMessage.includes("unreachable"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the hook never runs past its host timeout even when nothing starts", async () => {
  const dir = tmp();
  try {
    const started = Date.now();
    const { code } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_START_CMD: "definitely-not-a-real-binary-xyz",
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 14000, "must stay inside the 15s hook timeout");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
