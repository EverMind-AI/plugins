import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath, readState, isStored, markStored, claimWarning, pruneState } from "../hooks/scripts/lib/state.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-state-"));
}

test("an absent state file reads as an empty state", () => {
  const dir = tmp();
  assert.deepEqual(readState(dir, "s1"), { promptIds: [], warned: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("markStored makes isStored true and survives a reread", () => {
  const dir = tmp();
  assert.equal(isStored(readState(dir, "s1"), "p1"), false);
  markStored(dir, "s1", "p1");
  assert.equal(isStored(readState(dir, "s1"), "p1"), true);
  assert.equal(isStored(readState(dir, "s1"), "p2"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sessions do not see each other's prompt ids", () => {
  const dir = tmp();
  markStored(dir, "s1", "p1");
  assert.equal(isStored(readState(dir, "s2"), "p1"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the prompt id list is bounded and keeps the newest", () => {
  const dir = tmp();
  for (let i = 0; i < 250; i += 1) markStored(dir, "s1", `p${i}`);
  const state = readState(dir, "s1");
  assert.equal(state.promptIds.length, 200);
  assert.equal(isStored(state, "p249"), true);
  assert.equal(isStored(state, "p0"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the state file is created 0600", () => {
  const dir = tmp();
  markStored(dir, "s1", "p1");
  assert.equal(fs.statSync(statePath(dir, "s1")).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a session id with path separators cannot escape the data directory", () => {
  const dir = tmp();
  assert.equal(path.dirname(statePath(dir, "../../etc/passwd")), path.join(dir, "state"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claimWarning fires exactly once per session", () => {
  const dir = tmp();
  assert.equal(claimWarning(dir, "s1"), true);
  assert.equal(claimWarning(dir, "s1"), false);
  assert.equal(claimWarning(dir, "s2"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claimWarning does not lose already-stored prompt ids", () => {
  const dir = tmp();
  markStored(dir, "s1", "p1");
  claimWarning(dir, "s1");
  assert.equal(isStored(readState(dir, "s1"), "p1"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt state file is treated as empty, not fatal", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(statePath(dir, "s1"), "{not json");
  assert.deepEqual(readState(dir, "s1"), { promptIds: [], warned: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruneState deletes files older than the ttl and keeps fresh ones", () => {
  const dir = tmp();
  markStored(dir, "old", "p");
  markStored(dir, "new", "p");
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(statePath(dir, "old"), stale, stale);
  assert.equal(pruneState(dir, 30), 1);
  assert.equal(fs.existsSync(statePath(dir, "old")), false);
  assert.equal(fs.existsSync(statePath(dir, "new")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
