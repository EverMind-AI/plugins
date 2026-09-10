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
      // Two of these run before the recall deadline even starts, so they are
      // part of the UserPromptSubmit hook's 10s budget, not extra to it.
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Turn a git remote URL into host + owner + repo.
 *
 * The bare repository name is not a namespace. Two `api` repositories from
 * different owners are ordinary, and under a bare name they would share one
 * memory partition - each reading the other's decisions back into its prompts.
 * Every remote form collapses to the same id so a worktree cloned over ssh and
 * one cloned over https still share memory:
 *
 *   git@github.com:acme/api.git      ┐
 *   https://github.com/acme/api.git  ├─▶ github.com_acme_api
 *   ssh://git@github.com/acme/api    ┘
 */
function repoNameFromRemote(url) {
  const withoutSuffix = url.trim().replace(/\.git\/?$/, "");
  const withoutScheme = withoutSuffix.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutUser = withoutScheme.replace(/^[^/@]+@/, "");
  const segments = withoutUser.split(/[/:]/).filter(Boolean);
  if (segments.length === 0) return null;
  // Host plus the last two path segments: enough to be unique, short enough to read.
  return segments.slice(-3).join("_");
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
