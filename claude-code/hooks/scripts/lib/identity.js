import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP_ID, AGENT_ID, ID_MAX_LEN } from "./constants.js";

const PATH_SAFE = /[^A-Za-z0-9_.@+-]/g;

/**
 * EverOS turns app_id / project_id / sender_id into directory segments, so it
 * enforces a charset whitelist and rejects "." and "..". Mirror that here - a
 * rejected id would fail the whole /add with a 422.
 */
export function sanitizeId(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.trim().replace(PATH_SAFE, "_").slice(0, ID_MAX_LEN);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/** Run a git subcommand, returning trimmed stdout or null. Never throws. */
function defaultGitRunner(args, cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Last path segment of a git remote URL, with any .git suffix removed. */
function repoNameFromRemote(url) {
  const withoutSuffix = url.replace(/\.git\/?$/, "");
  const segments = withoutSuffix.split(/[/:]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

/**
 * Project partition. The origin remote name comes first on purpose: worktree
 * slots (repo, repo-a, repo-b) must share one memory, and the remote name is
 * more stable than the main worktree's directory name.
 */
export function resolveProjectId(cwd, config, gitRunner = defaultGitRunner) {
  if (config.projectIdOverride) return sanitizeId(config.projectIdOverride, "default");

  const remote = gitRunner(["config", "--get", "remote.origin.url"], cwd);
  if (remote) {
    const name = repoNameFromRemote(remote);
    if (name) return sanitizeId(name, "default");
  }

  const toplevel = gitRunner(["rev-parse", "--show-toplevel"], cwd);
  if (toplevel) return sanitizeId(path.basename(toplevel), "default");

  return sanitizeId(path.basename(cwd || ""), "default");
}

export function resolveIdentity(cwd, config, gitRunner = defaultGitRunner) {
  return {
    appId: APP_ID,
    projectId: resolveProjectId(cwd, config, gitRunner),
    userId: config.userId ? sanitizeId(config.userId, "default") : null,
    agentId: AGENT_ID,
  };
}
