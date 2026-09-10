import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath, readState, isStored, markStored, markFlushed, pendingFlushes, claimWarning, pruneState } from "../hooks/scripts/lib/state.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-state-"));
}

test("an absent state file reads as an empty state", () => {
  const dir = tmp();
  assert.deepEqual(readState(dir, "s1"), { sessionId: null, projectId: null, promptIds: [], warned: false, flushed: false });
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
  assert.deepEqual(readState(dir, "s1"), { sessionId: null, projectId: null, promptIds: [], warned: false, flushed: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a session is pending until it is marked flushed", () => {
  const dir = tmp();
  markStored(dir, "s1", "p1");
  assert.deepEqual(pendingFlushes(dir, 0), [{ sessionId: "s1", projectId: null }]);
  markFlushed(dir, "s1");
  assert.deepEqual(pendingFlushes(dir, 0), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pending session carries the project it was captured under", () => {
  // The sweep runs from a later session that may be in a different repository;
  // flushing with the current project id would seal the wrong partition.
  const dir = tmp();
  markStored(dir, "s1", "p1", "repo-a");
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(statePath(dir, "s1"), stale, stale);
  assert.deepEqual(pendingFlushes(dir, 10 * 60 * 1000), [{ sessionId: "s1", projectId: "repo-a" }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a session still being written is not treated as abandoned", () => {
  const dir = tmp();
  markStored(dir, "fresh", "p1");
  assert.deepEqual(pendingFlushes(dir, 10 * 60 * 1000), [], "a session touched seconds ago is still live");
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(statePath(dir, "fresh"), old, old);
  assert.deepEqual(pendingFlushes(dir, 10 * 60 * 1000), [{ sessionId: "fresh", projectId: null }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a session that never stored anything is not worth flushing", () => {
  const dir = tmp();
  claimWarning(dir, "warned-only");
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(statePath(dir, "warned-only"), old, old);
  assert.deepEqual(pendingFlushes(dir, 10 * 60 * 1000), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the real session id survives sanitising into the file name", () => {
  const dir = tmp();
  markStored(dir, "90145615-6b7a-4ea4-ad4c-08416de90ae3", "p1");
  assert.deepEqual(pendingFlushes(dir, 0), [{ sessionId: "90145615-6b7a-4ea4-ad4c-08416de90ae3", projectId: null }]);
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
