import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeId, resolveProjectId, resolveIdentity } from "../hooks/scripts/lib/identity.js";

const cfg = { projectIdOverride: null, userId: "tester" };

function runnerFor(map) {
  return (args) => map[args.join(" ")] ?? null;
}

test("sanitizeId keeps the path-safe charset and replaces the rest", () => {
  assert.equal(sanitizeId("EverOS", "default"), "EverOS");
  assert.equal(sanitizeId("my repo/name", "default"), "my_repo_name");
  assert.equal(sanitizeId("项目", "default"), "__");
  assert.equal(sanitizeId("a.b@c+d-e_f", "default"), "a.b@c+d-e_f");
});

test("sanitizeId rejects the directory-traversal names EverOS forbids", () => {
  assert.equal(sanitizeId(".", "default"), "default");
  assert.equal(sanitizeId("..", "default"), "default");
  assert.equal(sanitizeId("", "default"), "default");
  assert.equal(sanitizeId(null, "default"), "default");
});

test("sanitizeId clips to 128 characters", () => {
  assert.equal(sanitizeId("x".repeat(200), "default").length, 128);
});

test("the origin remote name wins, so every worktree shares one project", () => {
  const runner = runnerFor({ "config --get remote.origin.url": "git@github.com:EverMind-AI/Plugins.git" });
  assert.equal(resolveProjectId("/Users/me/Plugins-a", cfg, runner), "Plugins");
  assert.equal(resolveProjectId("/Users/me/Plugins", cfg, runner), "Plugins");
});

test("an https remote and a remote without .git both resolve", () => {
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "https://github.com/EverMind-AI/EverOS.git" })),
    "EverOS",
  );
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "https://gitlab.com/team/thing" })),
    "thing",
  );
});

test("no remote falls back to the toplevel basename", () => {
  const runner = runnerFor({ "rev-parse --show-toplevel": "/Users/me/code/local-only" });
  assert.equal(resolveProjectId("/Users/me/code/local-only/src", cfg, runner), "local-only");
});

test("no git at all falls back to the cwd basename", () => {
  assert.equal(resolveProjectId("/Users/me/scratch", cfg, runnerFor({})), "scratch");
});

test("the override beats every derivation", () => {
  const runner = runnerFor({ "config --get remote.origin.url": "git@github.com:x/y.git" });
  assert.equal(resolveProjectId("/w", { ...cfg, projectIdOverride: "forced" }, runner), "forced");
});

test("resolveIdentity returns the four ids the wire needs", () => {
  const id = resolveIdentity("/Users/me/scratch", cfg, runnerFor({}));
  assert.deepEqual(id, { appId: "claude-code", projectId: "scratch", userId: "tester", agentId: "claude-code" });
});

test("a missing userId is reported as null so the caller can disable the user track", () => {
  const id = resolveIdentity("/Users/me/scratch", { ...cfg, userId: null }, runnerFor({}));
  assert.equal(id.userId, null);
});
