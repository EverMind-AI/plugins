import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeEveros } from "./helpers/fake-everos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-scripts-")); }

function run(relative, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, relative), ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("status reports health, ids and config sources", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.match(stdout, /reachable/i);
    assert.match(stdout, /app_id\s+claude-code/);
    assert.match(stdout, /project_id\s+proj/);
    assert.match(stdout, /user_id\s+tester/);
    assert.match(stdout, /agent_id\s+claude-code/);
    assert.match(stdout, /base_url.*\(env\)/);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("status explains what to do when EverOS is down and exits 0", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.equal(code, 0);
    assert.match(stdout, /NOT reachable/);
    assert.match(stdout, /everos init|everos server start/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("status surfaces the last debug lines when a debug log exists", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "debug.log"), "2026-09-10T00:00:00.000Z [Stop] add failed: boom\n");
  try {
    const { stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.match(stdout, /add failed: boom/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search renders exactly what the model would be given", async () => {
  const hit = {
    episodes: [{ id: "e1", subject: "Lint choice", summary: "Agreed on ruff", atomic_facts: [{ id: "f", content: "uses ruff, not black" }] }],
    profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [],
  };
  const empty = { episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] };
  const server = await startFakeEveros({ searchFn: (body) => (body.user_id ? hit : empty) });
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/search.js", ["how do we lint"], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.match(stdout, /uses ruff, not black/);
    assert.match(stdout, /<everos_memory>/);
    const searches = server.only("/api/v2/memory/search");
    assert.equal(searches.length, 2, "search must use both tracks, like recall does");
    assert.equal(searches.find((r) => r.body.user_id).body.project_id, "proj");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search with no query explains itself and exits 0", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/search.js", [], { EVEROS_CC_DATA_DIR: dir });
    assert.equal(code, 0);
    assert.match(stdout, /usage/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search reports an empty result instead of printing nothing", async () => {
  const empty = { episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] };
  const server = await startFakeEveros({ searchFn: () => empty });
  const dir = tmp();
  try {
    const { stdout } = await run("scripts/search.js", ["anything at all"], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.match(stdout, /no matching memory/i);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
