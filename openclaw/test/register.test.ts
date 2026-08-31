import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenClawPluginApi } from "../src/openclaw-types.js";
import type { ProvisionOptions, ProvisionResult } from "../src/provision.js";
import { register, resolveUserId } from "../src/register.js";

// A fake host `api` that records every wiring call register() makes. register()
// only touches `api` (and reads env/config); it never calls the registered
// service's start(), so no EverOS spawn / network happens here.
interface OnCall {
  event: string;
  handler: unknown;
  opts?: unknown;
}
interface Recorder {
  api: OpenClawPluginApi;
  capabilities: unknown[];
  onCalls: OnCall[];
  services: { id: string; start: unknown; stop: unknown }[];
  warnings: string[];
}

function recorder(conversationAccessGranted = true): Recorder {
  const capabilities: unknown[] = [];
  const onCalls: OnCall[] = [];
  const services: { id: string; start: unknown; stop: unknown }[] = [];
  const warnings: string[] = [];
  const api = {
    id: "evermind-ai-everos",
    name: "OpenClaw Memory — EverOS",
    config: {
      plugins: {
        entries: {
          "evermind-ai-everos": {
            hooks: { allowConversationAccess: conversationAccessGranted, allowPromptInjection: true },
          },
        },
      },
    },
    logger: {
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
      error() {},
    },
    on(event: string, handler: unknown, opts?: unknown) {
      onCalls.push({ event, handler, opts });
    },
    registerMemoryCapability(capability: unknown) {
      capabilities.push(capability);
    },
    registerService(service: { id: string; start: unknown; stop: unknown }) {
      services.push(service);
    },
  } as unknown as OpenClawPluginApi;
  return { api, capabilities, onCalls, services, warnings };
}

test("register: claims the memory slot with an EMPTY capability, exactly once", () => {
  const r = recorder();
  register(r.api);
  assert.equal(r.capabilities.length, 1);
  // Empty on purpose (see register.ts) — populating a field would spawn a competing store.
  assert.equal(Object.keys(r.capabilities[0] as object).length, 0);
});

test("register: wires OpenClaw 2.0 media plus four lifecycle hooks exactly once", () => {
  const r = recorder();
  register(r.api);
  const events = r.onCalls.map((c) => c.event).sort();
  assert.deepEqual(events, ["agent_end", "before_prompt_build", "before_reset", "message_received", "session_end"]);
  assert.equal(new Set(events).size, events.length); // no duplicate registrations
});

test("register: without the explicit grant, media is not registered and the user is warned", () => {
  const r = recorder(false);
  register(r.api);
  assert.ok(!r.onCalls.some((call) => call.event === "message_received"));
  assert.ok(r.warnings.some((message) => message.includes("memory recall and capture are disabled")));
});

test("register: warns when OpenClaw 2.0 prompt injection is explicitly disabled", () => {
  const r = recorder();
  const cfg = r.api.config as {
    plugins: { entries: { "evermind-ai-everos": { hooks: { allowPromptInjection: boolean } } } };
  };
  cfg.plugins.entries["evermind-ai-everos"].hooks.allowPromptInjection = false;
  register(r.api);
  assert.ok(r.warnings.some((message) => message.includes("allowPromptInjection is false")));
});

test("register: before_prompt_build gets the 5s recall budget; the others pass no opts", () => {
  const r = recorder();
  register(r.api);
  const byEvent = new Map(r.onCalls.map((c) => [c.event, c]));
  assert.deepEqual(byEvent.get("before_prompt_build")?.opts, { timeoutMs: 5000 });
  assert.equal(byEvent.get("message_received")?.opts, undefined);
  assert.equal(byEvent.get("agent_end")?.opts, undefined);
  assert.equal(byEvent.get("session_end")?.opts, undefined);
  assert.equal(byEvent.get("before_reset")?.opts, undefined);
});

test("register: every hook handler is a function", () => {
  const r = recorder();
  register(r.api);
  for (const c of r.onCalls) assert.equal(typeof c.handler, "function", `${c.event} handler`);
});

test("register: registers exactly one provisioning service with start + stop", () => {
  const r = recorder();
  register(r.api);
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0]!.id, "everos-server");
  assert.equal(typeof r.services[0]!.start, "function");
  assert.equal(typeof r.services[0]!.stop, "function");
});

test("register: stop() kills an IN-FLIGHT EverOS start (not just a resolved one)", async () => {
  const r = recorder();
  let killed = 0;
  let settle: ((v: ProvisionResult) => void) | undefined;
  // Mirror real provision: it exposes its kill handle via onStop after it spawns the
  // child (post health-check), and stays pending until healthy — here it never resolves.
  const provisionFn = ((opts: ProvisionOptions) => {
    queueMicrotask(() => opts.onStop?.(() => killed++));
    return new Promise<ProvisionResult>((res) => {
      settle = res;
    });
  }) as never;
  register(r.api, { provisionFn });
  const svc = r.services[0]!;
  (svc.start as (s: unknown) => void)({ logger: r.api.logger });
  await new Promise((res) => setTimeout(res, 0)); // let onStop fire (child "spawned")
  (svc.stop as () => void)(); // gateway shuts down mid-startup
  assert.equal(killed, 1); // the in-flight child was killed, not orphaned
  settle?.({ status: "failed", detail: "cancelled" });
});

test("register: stop() BEFORE the child spawns still cancels it once it does", () => {
  const r = recorder();
  let killed = 0;
  let spawn: (() => void) | undefined;
  const provisionFn = ((opts: ProvisionOptions) => {
    spawn = () => opts.onStop?.(() => killed++); // test controls when the spawn happens
    return new Promise<ProvisionResult>(() => {}); // still starting
  }) as never;
  register(r.api, { provisionFn });
  const svc = r.services[0]!;
  (svc.start as (s: unknown) => void)({ logger: r.api.logger });
  (svc.stop as () => void)(); // stop requested BEFORE onStop has fired
  assert.equal(killed, 0); // nothing spawned yet → nothing to kill
  spawn?.(); // now the child spawns…
  assert.equal(killed, 1); // …and is killed immediately (stop was already requested)
});

test("resolveUserId: config wins, then USER, then USERNAME, then OS, else undefined", () => {
  assert.equal(
    resolveUserId("cfg", { USER: "u", USERNAME: "n" }, () => "os"),
    "cfg",
  );
  assert.equal(
    resolveUserId(undefined, { USER: "u", USERNAME: "n" }, () => "os"),
    "u",
  );
  assert.equal(
    resolveUserId("", { USERNAME: "n" }, () => "os"),
    "n",
  ); // empty cfg falls through
  assert.equal(
    resolveUserId(undefined, {}, () => "os"),
    "os",
  ); // daemon case: OS account saves it
  assert.equal(
    resolveUserId("", {}, () => undefined),
    undefined,
  ); // truly unresolvable
});
