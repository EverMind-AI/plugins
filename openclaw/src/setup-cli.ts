#!/usr/bin/env node
/**
 * Executable entry for `everos-setup` (package.json `bin`). All logic lives in
 * `setup.ts` behind the injectable `SetupIo` so it stays unit-testable; this
 * file only binds real IO (child_process, readline, fetch, fs).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { runSetup, type SetupIo } from "./setup.js";

const io: SetupIo = {
  exec(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    // status is null when the binary is missing (spawn error) — treat as failure.
    return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  },
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  log(msg) {
    console.log(msg);
  },
  async health(baseUrl, timeoutMs) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  fileExists: (p) => existsSync(p),
  isInteractive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

process.exitCode = await runSetup(process.argv.slice(2), io);
