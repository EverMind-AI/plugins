# EverOS ⇄ Hermes Plugin — Handover Document

_As of 2026-08-06. For whoever picks up the build. Design docs are complete
and source-verified. This document is the bridge: the design's reasoning in
brief, how to build and test it, and how to release it._

---

## 1. Status snapshot

- **Done:** research (Hermes plugin system, the 8 in-tree competing providers,
  upstream policy), the four-document design set (full + simplified registers —
  structurally uniform, no drift), every interface claim **pinned against
  Hermes source at HEAD** (`agent/memory_provider.py`, `hermes_cli/memory_setup.py`,
  `hermes_cli/plugins_cmd.py`, `plugins/memory/query_rewrite.py`), all design
  decisions closed, Hermes installed on the dev machine (Quick Setup / Nous
  Portal / local terminal backend).

## 2. The design's reasoning, in one page

**What it is:** a native Hermes memory provider — one Python class
(`EverosMemoryProvider`) over EverOS's local HTTP API. Hermes drives it through
a purpose-built pipeline; we implement the methods, the host owns the loop:
**recall → converse → capture → seal**.

**The principles behind every decision:**

1. **Mirror EverOS — invent nothing.** The plugin forwards; all intelligence
   (extraction, storage, ranking, models) lives in EverOS. Anything smart you
   feel tempted to add to the plugin probably belongs in EverOS or nowhere.
2. **Fail-open, always.** EverOS down/slow → every method silently no-ops;
   recall returns `""` after ~5s. A memory backend must never break a
   conversation. This is enforced per-method, not globally.
3. **One brain, many agents.** The same unmodified EverOS server
   (`127.0.0.1:8000` by default) serves OpenClaw and Hermes, partitioned by
   `app_id` (`"hermes"` vs `"openclaw"`). Hence **HTTP, never `import everos`**
   (in-process would fork the store; the OME engine is single-instance by
   lock; process isolation contains crashes).

**Decisions you should not re-litigate without new evidence:**

- **Zero tools** (`get_tool_schemas() → []`): recall is automatic every turn
  (`prefetch`), capture automatic after (`sync_turn`). The model never has to
  remember to remember. This is also our market differentiator (every rival
  provider ships 2–5+ tools).
- **Detect-then-provision** in `initialize()`, daemon thread: health-check →
  start EverOS if installed (forcing `EVEROS_MEMORIZE__MODE=agent` so one
  `/add` stream feeds both tracks) → guide `everos init` if missing.
- **Coexist + mirror built-in memory**: Hermes's `MEMORY.md`/`USER.md` stay;
  `on_memory_write` forwards their edits to `/add` (premium curated facts;
  EverOS dedups).
- **Capture the full trajectory**: `sync_turn`'s optional `messages` kwarg
  carries tool calls/results — that feeds the agent track (cases + skills).
  Fallback `messages or [user_content, assistant_content]` covers old Hermes.
- **Seal on every ending**: `on_session_end`, `on_pre_compress` (flush, then
  `return ""` — it returns a *string* contribution to the compression
  summary), `shutdown` (flush + stop EverOS only if we spawned it), and
  `on_session_switch` (retarget cached `_sid`; flush first when `reset=True`).
- **`on_delegation`**: forward each subagent's task+result pair to `/add`
  (child transcripts stay in Hermes's SQLite SessionDB; child runs
  `skip_memory=True`).
- **Weighted query clip**: `query_max_units` (default 500) — CJK/fullwidth
  char = 2 units, else 1, via stdlib `unicodedata.east_asian_width`. Only
  fires on the fallback path (normally Hermes rewrites the query into one
  English question ≤320 chars first — `plugins/memory/query_rewrite.py`).
- **Prompt-injection hardening lives in `render`**: recalled text is fenced,
  labeled *untrusted historical data*, fence-lookalike tokens neutralized —
  port this **verbatim** from the OpenClaw plugin.

**ID mapping (recall MUST match capture or search returns nothing):**
`app_id="hermes"` (constant) · `project_id` = profile/cwd · user track =
configured `user_id` (default `$USER`) · agent track = constant `agent_id`
(default `"hermes"`) · `session_id` from the pipeline.

## 3. Artifact map

```text
EverMind-AI/plugins
├── openclaw/               the shipped OpenClaw plugin (TS) — the proven prior art
└── hermes/
    ├── docs/
    │   ├── DESIGN_DOC.md       the design spec
    │   ├── DESIGN_DOC_zh.md
    │   ├── HANDOFF.md          this document
    │   └── HANDOFF_zh.md
    └── (plugin code lands here: plugin.yaml, __init__.py, client.py,
        provision.py, cli.py, README.md, tests/)
```

The EverOS server itself lives at
[`EverMind-AI/EverOS`](https://github.com/EverMind-AI/EverOS).

## 4. Build plan

File layout (per §3.4 of the main doc): `plugin.yaml`, `__init__.py`
(provider + `register(ctx)`), `client.py`, `provision.py`, optional `cli.py`,
`README.md`, `tests/`.

Order of work:

1. **Two live checks first** (with a stub plugin, ~5 min each):
   `hermes plugins install <repo>/<subdir>` actually lands in
   `~/.hermes/plugins/memory/<name>/`; the stub appears in the
   `hermes memory setup` picker.
2. **Write `implementation-contract.md`** — mostly transcription of the
   already-pinned facts. Verify the
   MemoryManager call sites while at it (`prefetch_all`, `_prefetch_provider`
   thread pattern, `queue_prefetch_all`).
3. **`client.py`** — thin HTTP: `/health`, `/search`, `/add`, `/flush`.
   Port from OpenClaw: URL normalization, timeouts, fail-open per call.
4. **`render`** — two-track block + injection fence. Port **verbatim**.
5. **`provision.py`** — the detect-then-provision state machine (venv start
   command, quoted paths, `EVEROS_MEMORIZE__MODE=agent`, port forcing).
6. **The provider class** — exactly the §3.5 sketch surface.
7. **Tests** (below), then live verification (below).

Contract facts already pinned (don't re-derive): `is_available()` must make
no network calls; `sync_turn` must not block (daemon thread); `initialize`
kwargs include `hermes_home` + `platform` always, and possibly
`agent_context` (`"primary"`/`"subagent"`/`"cron"`/`"flush"` — **skip writes
when non-primary**), `agent_identity`, `user_id` (gateway); config flows via
`get_config_schema()` → wizard → `save_config(values, hermes_home)`
(`post_setup` is a duck-typed full-delegation alternative we don't use).

## 5. How to test

**Unit tests (no Hermes, no EverOS):** a fake runtime driving the provider +
a stub EverOS HTTP server (or a recording fake client). The contract points
are the test list:

- `is_available()` performs zero network I/O (assert no socket use).
- `initialize()` returns immediately (provisioning on a daemon thread).
- `prefetch()`: two owner-scoped searches with matching
  `app_id`/`project_id`; returns `""` on timeout/error/empty; the rendered
  block carries the untrusted-data fence; fence-lookalike tokens in memory
  content are neutralized.
- Weighted clip: pure-EN 500 chars untouched; CJK clipped at ~250 chars;
  mixed cases; clip only applied on the fallback (raw) path.
- `sync_turn()`: returns before the HTTP call completes; payload uses
  `messages` when present, falls back to the pair when absent; correct
  sender ids per track; **no write when `agent_context` ≠ primary**.
- Seals: `on_session_end`/`on_pre_compress` flush the *current* `_sid`;
  `on_pre_compress` returns `""`; `on_session_switch(reset=True)` flushes old
  sid then swaps; `shutdown` stops EverOS only if we spawned it.
- `on_memory_write` / `on_delegation` produce well-formed `/add` payloads.
- Everything above under a dead server: no exception escapes any method.

**Live verification — backend-receipts discipline** (chat-level "does it
remember" demos are confounded; only EverOS receipts count):

1. Fresh `$HERMES_HOME`, install plugin, `hermes memory setup` → pick
   `everos`, `hermes memory status`.
2. Chat a few turns → verify **EverOS-side**: `/add` payloads arrive with
   correct ids; flush fires on exit/reset; markdown appears under
   `~/.everos/` (hermes subtree); recall block visible in next-turn context
   and traceable to stored memories.
3. Cross-host check: run OpenClaw simultaneously against the same server;
   confirm `app_id` partition (no cross-contamination in search results).
4. Watch the two known runtime gotchas from OpenClaw's live tests:
   long-running EverOS degrading search latency past the 5s cap, and the
   OME-lock handoff race when restarting.

## 6. How to release

1. **Code review + tests green** in the monorepo (`EverMind-AI/plugins`,
   subfolder e.g. `hermes/`). Follow the OpenClaw plugin's conventions.
2. **Bump `version:`** in `plugin.yaml` (semver label; informational).
   `manifest_version: 1` stays until Hermes changes its plugin format.
3. **README duties** (Hermes convention): document *exactly what data leaves
   the device* (the `sync_turn` payload → EverOS's configured LLM/embedding
   providers), the install command, the update caveat, and the one-time
   EverOS setup (`everos init` + keys in `~/.everos/everos.toml`).
4. **Tag/merge to main.** Users install with
   `hermes plugins install EverMind-AI/plugins/<subfolder>` — subdir installs
   are supported natively. **Update caveat:** subdir installs keep no `.git`,
   so `hermes plugins update` refuses them — users re-run the install command
   to upgrade. Put this in the README.
5. **Later, optional:** PyPI channel (`hermes-everos` with a
   `hermes_agent.plugins` entry point and/or an install-shim CLI, à la
   `hermes-memori`) — gives real package versioning and `pip` upgrades.
