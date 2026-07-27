/**
 * `everos-setup` — one-command setup for the OpenClaw memory plugin.
 *
 * Runs the OFFICIAL host installer and the handful of config steps the README
 * otherwise walks through by hand:
 *
 *   1. `openclaw plugins install <spec>` (host-native; handles the memory-slot swap)
 *   2. the conversation-access grant — ALWAYS consent-gated: prompted when
 *      interactive, defaults to NO otherwise (OpenClaw made this opt-in on
 *      purpose; a silent flip would abuse the consent gate)
 *   3. EverOS wiring when it isn't already running and `everos` isn't on the
 *      gateway's PATH (venv checkouts): EVEROS_OC_START_CMD + EVEROS_OC_EVEROS_DIR
 *   4. gateway restart + an EverOS health poll so success/failure is visible
 *
 * Pure logic lives here with injectable IO (`SetupIo`) so tests can drive every
 * branch; the executable wrapper is `setup-cli.ts`. This script only shells out
 * to `openclaw` — it never edits openclaw.json by hand, so it cannot drift from
 * the host's config layout (the 2.x installer's fatal flaw).
 */

export interface SetupIo {
  /** Run a command without a shell; returns exit status and combined output. */
  exec(cmd: string, args: string[]): { status: number; output: string };
  /** Prompt the user (interactive sessions only). */
  ask(question: string): Promise<string>;
  log(msg: string): void;
  /** GET <baseUrl>/health → ok? */
  health(baseUrl: string, timeoutMs: number): Promise<boolean>;
  fileExists(path: string): boolean;
  isInteractive: boolean;
  sleep(ms: number): Promise<void>;
}

export interface SetupArgs {
  /** npm spec, tarball, or directory passed to `openclaw plugins install`. */
  spec: string;
  /** Grant decision from flags; undefined → prompt (or safe default). */
  grant: boolean | undefined;
  everosDir: string | undefined;
  startCmd: string | undefined;
  baseUrl: string;
  restart: boolean;
  help: boolean;
}

export const PLUGIN_ID = "evermind-ai-everos";
const DEFAULT_SPEC = "@evermind-ai/openclaw-plugin";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
/**
 * Tested floor (the declared peer range). Below it we WARN and continue rather
 * than block: registry archaeology shows the whole memory-slot API surface
 * exists back to at least 2026.5.7, but we have only VALIDATED ≥ 2026.6.10 —
 * so "may work, not promised" is the honest message, and blocking would
 * contradict the plugin's fail-open philosophy.
 */
const MIN_OPENCLAW: readonly [number, number, number] = [2026, 6, 10];

/** Pull a `YYYY.M.P` version out of `openclaw --version` output, if present. */
export function parseOpenclawVersion(output: string): [number, number, number] | undefined {
  const m = /(\d{4})\.(\d+)\.(\d+)/.exec(output);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function belowFloor(v: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== MIN_OPENCLAW[i]!) return v[i]! < MIN_OPENCLAW[i]!;
  }
  return false; // equal to the floor
}
/** Health-poll budget after restart — matches provision's 60s readiness window. */
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

export const HELP = `everos-setup — one-command setup for the OpenClaw memory plugin

Usage: everos-setup [spec] [options]

  spec                 What to install: npm spec, .tgz, or directory
                       (default: ${DEFAULT_SPEC})

Options:
  --grant              Grant conversation access without prompting
  --no-grant           Skip the grant (plugin recalls but never saves)
  --everos-dir <dir>   EverOS checkout — sets EVEROS_OC_EVEROS_DIR and, when
                       <dir>/.venv/bin/everos exists, a quoted EVEROS_OC_START_CMD
  --start-cmd <cmd>    Explicit EVEROS_OC_START_CMD (overrides the venv guess)
  --base-url <url>     EverOS base URL (default: ${DEFAULT_BASE_URL})
  --no-restart         Skip the gateway restart (apply config only)
  -h, --help           Show this help`;

export function parseArgs(argv: string[]): SetupArgs | { error: string } {
  const out: SetupArgs = {
    spec: DEFAULT_SPEC,
    grant: undefined,
    everosDir: undefined,
    startCmd: undefined,
    baseUrl: DEFAULT_BASE_URL,
    restart: true,
    help: false,
  };
  let sawSpec = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | { error: string } => {
      const v = argv[++i];
      return v === undefined ? { error: `error: ${a} requires a value` } : v;
    };
    if (a === "--grant") out.grant = true;
    else if (a === "--no-grant") out.grant = false;
    else if (a === "--no-restart") out.restart = false;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--everos-dir") {
      const v = next();
      if (typeof v !== "string") return v;
      out.everosDir = v;
    } else if (a === "--start-cmd") {
      const v = next();
      if (typeof v !== "string") return v;
      out.startCmd = v;
    } else if (a === "--base-url") {
      const v = next();
      if (typeof v !== "string") return v;
      out.baseUrl = v.replace(/\/+$/, "");
    } else if (a.startsWith("-")) {
      return { error: `error: unknown option ${a}` };
    } else if (sawSpec) {
      return { error: `error: unexpected extra argument ${a}` };
    } else {
      out.spec = a;
      sawSpec = true;
    }
  }
  return out;
}

/** Join a .venv everos path safely for EVEROS_OC_START_CMD (quotes ride spaces). */
function venvStartCmd(dir: string): string {
  const bin = `${dir.replace(/\/+$/, "")}/.venv/bin/everos`;
  return `"${bin}" server start`;
}

function venvBinPath(dir: string): string {
  return `${dir.replace(/\/+$/, "")}/.venv/bin/everos`;
}

export async function runSetup(argv: string[], io: SetupIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.log(args.error);
    io.log(HELP);
    return 2;
  }
  if (args.help) {
    io.log(HELP);
    return 0;
  }

  // 1. Host CLI present? (And on a tested version — warn, don't block, below it.)
  const ver = io.exec("openclaw", ["--version"]);
  if (ver.status !== 0) {
    io.log("error: the `openclaw` CLI was not found — install OpenClaw first (https://docs.openclaw.ai).");
    return 1;
  }
  const detected = parseOpenclawVersion(ver.output);
  if (detected && belowFloor(detected)) {
    io.log(
      `warning: your OpenClaw is ${detected.join(".")}; this plugin is tested on >= ${MIN_OPENCLAW.join(".")}. ` +
        "It may still work — consider `npm install -g openclaw@latest`.",
    );
  }

  // 2. Official install (idempotent via --force so re-running upgrades in place).
  io.log(`Installing plugin from ${args.spec} …`);
  const inst = io.exec("openclaw", ["plugins", "install", args.spec, "--force"]);
  if (inst.status !== 0) {
    io.log(inst.output.trim());
    io.log("error: plugin install failed.");
    return 1;
  }
  io.log("Plugin installed (memory slot claimed).");

  // 3. Consent-gated capture grant. Never silently granted: OpenClaw blocks
  //    conversation access for non-bundled plugins BY DESIGN.
  let grant = args.grant;
  if (grant === undefined) {
    if (io.isInteractive) {
      const a = (await io.ask("Allow the plugin to read conversation content so it can SAVE memory? [y/N] "))
        .trim()
        .toLowerCase();
      grant = a === "y" || a === "yes";
    } else {
      grant = false;
      io.log("Non-interactive session: NOT granting conversation access (pass --grant to allow).");
    }
  }
  if (grant) {
    const g = io.exec("openclaw", [
      "config",
      "set",
      `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`,
      "true",
    ]);
    if (g.status !== 0) {
      io.log(g.output.trim());
      io.log("error: failed to set the conversation-access grant.");
      return 1;
    }
    io.log("Conversation access granted — the plugin can save memory.");
  } else {
    io.log("Capture stays OFF: the plugin will recall but never save. Grant later with:");
    io.log(`  openclaw config set 'plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess' true`);
  }

  // 4. EverOS wiring. A non-default base URL must ALSO reach the plugin's own
  //    config — polling a custom URL while the plugin still talks to the default
  //    port would "succeed" against a server the plugin never uses.
  if (args.baseUrl !== DEFAULT_BASE_URL) {
    const r = io.exec("openclaw", [
      "config",
      "set",
      `plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_BASE_URL`,
      args.baseUrl,
    ]);
    if (r.status !== 0) {
      io.log(r.output.trim());
      io.log("error: failed to set EVEROS_OC_BASE_URL.");
      return 1;
    }
    io.log(`EVEROS_OC_BASE_URL = ${args.baseUrl}`);
  }
  // Start wiring — only needed when nothing is running and the default start
  // command wouldn't work from the gateway process.
  let canAutoStart = false;
  const alreadyHealthy = await io.health(args.baseUrl, 2_000);
  if (alreadyHealthy) {
    io.log(`EverOS already running at ${args.baseUrl} — no start configuration needed.`);
  } else {
    let dir = args.everosDir;
    let startCmd = args.startCmd;
    if (!dir && !startCmd) {
      if (io.exec("everos", ["--help"]).status === 0) {
        io.log("`everos` found on PATH — the plugin's default start command will work.");
        canAutoStart = true;
      } else if (io.isInteractive) {
        const answer = (
          await io.ask(
            "EverOS isn't running and `everos` isn't on PATH.\nPath to your EverOS checkout (blank to skip): ",
          )
        ).trim();
        if (answer) dir = answer;
      } else {
        io.log(
          "EverOS is not reachable and `everos` is not on PATH — set EVEROS_OC_START_CMD / EVEROS_OC_EVEROS_DIR later (see README).",
        );
      }
    }
    if (dir && !startCmd) {
      if (io.fileExists(venvBinPath(dir))) {
        startCmd = venvStartCmd(dir);
      } else {
        io.log(`note: ${venvBinPath(dir)} not found — leaving the default start command.`);
      }
    }
    if (dir) {
      const r = io.exec("openclaw", ["config", "set", `plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_EVEROS_DIR`, dir]);
      if (r.status !== 0) {
        io.log(r.output.trim());
        io.log("error: failed to set EVEROS_OC_EVEROS_DIR.");
        return 1;
      }
      io.log(`EVEROS_OC_EVEROS_DIR = ${dir}`);
      canAutoStart = true;
    }
    if (startCmd) {
      const r = io.exec("openclaw", [
        "config",
        "set",
        `plugins.entries.${PLUGIN_ID}.config.EVEROS_OC_START_CMD`,
        startCmd,
      ]);
      if (r.status !== 0) {
        io.log(r.output.trim());
        io.log("error: failed to set EVEROS_OC_START_CMD.");
        return 1;
      }
      io.log(`EVEROS_OC_START_CMD = ${startCmd}`);
      canAutoStart = true;
    }
  }

  // 5. Restart so the gateway loads the plugin (and provisions EverOS).
  if (args.restart) {
    io.log("Restarting the OpenClaw gateway …");
    const r = io.exec("openclaw", ["gateway", "restart"]);
    if (r.status !== 0) {
      io.log(r.output.trim());
      io.log("error: gateway restart failed — restart it manually (`openclaw gateway restart`).");
      return 1;
    }
  } else {
    io.log("Skipping gateway restart (--no-restart) — restart manually to apply.");
  }

  // 6. Make the outcome visible: poll EverOS health when a start is expected.
  if (args.restart && (alreadyHealthy || canAutoStart)) {
    if (!alreadyHealthy) io.log("Waiting for the plugin to start EverOS …");
    let healthy = alreadyHealthy;
    for (let i = 0; !healthy && i < POLL_ATTEMPTS; i++) {
      await io.sleep(POLL_INTERVAL_MS);
      healthy = await io.health(args.baseUrl, 2_000);
    }
    if (healthy) {
      io.log(`EverOS healthy at ${args.baseUrl} ✓`);
    } else {
      io.log(
        `warning: EverOS did not become healthy at ${args.baseUrl} — check \`openclaw logs | grep everos\` (see the README's troubleshooting table).`,
      );
    }
  } else if (args.restart) {
    io.log("EverOS start was skipped — the plugin will fail-open (recall/capture pause) until EverOS is reachable.");
  }

  io.log("");
  io.log("Done. Try it: mention something about yourself, `/new`, send any message, then ask it back.");
  return 0;
}
