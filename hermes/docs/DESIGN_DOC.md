# Hermes Memory — EverOS: A Native Memory Provider for Hermes Agent

This document has three parts: **Part 1** establishes what Hermes Agent is and how its plugins work; **Part 2** surveys Hermes's built-in memory and the existing external memory providers; **Part 3** sets out the design of the Hermes Memory — EverOS native memory provider.

> Companion to the [OpenClaw plugin](../openclaw/) — the same EverOS backend serves both hosts.

---

## Part 1 — Introduction to Hermes Agent and its plugins

### 1.1 What is Hermes Agent

Hermes Agent is Nous Research's open-source, self-hosted personal AI agent ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)). It runs as a **Python** application on your own machine, in two modes: an interactive CLI and a **gateway** that connects chat platforms (Telegram, Slack, etc.) through channel adapters. Its signature loop is that it *learns from every task*: successful workflows become reusable **skills**, and conversations feed a persistent **memory** that survives across sessions.

Everything lives under `~/.hermes/` (or a profile-scoped `$HERMES_HOME`): `config.yaml` (all behavioral settings), `.env` (secrets), `state.db`, `sessions/`, `cron/`, `mcp-tokens/`, `plugins/`, and `memories/` (the built-in memory files). A workspace carries the agent's identity files (`AGENTS.md`, `SOUL.md`, skills).

Two facts matter most for us:

1. **Hermes is Python** — the same language as EverOS. There is no cross-runtime seam to bridge, unlike the TypeScript↔Python split in the OpenClaw integration.
2. **Memory is a first-class, single-select extension point** — Hermes has a dedicated `MemoryProvider` plugin category with its own discovery, lifecycle, and setup UX. We don't have to bend a generic hook system into a memory plugin; the socket is purpose-built.

### 1.2 How plugins work

A Hermes plugin is a directory with a `plugin.yaml` manifest and an `__init__.py` exposing `register(ctx)`. The `PluginContext` offers registration methods for tools, lifecycle hooks, slash commands, CLI subcommands, skills, platform adapters, and — the one we need — `ctx.register_memory_provider(provider)`.

Plugins are discovered from several sources: bundled with Hermes (`<repo>/plugins/`), the user directory (`~/.hermes/plugins/` — where installed plugins land, ours included), and pip packages (`hermes_agent.plugins` entry points), plus two niche ones (project-scoped, Nix). Later sources override earlier on name collision, so a user-installed plugin can shadow a bundled one.

Four plugin categories exist, with different selection semantics:

- **General plugins** — multi-select via `plugins.enabled` / `plugins.disabled` in `config.yaml`.
- **Memory providers** — **single-select**: all discovered, exactly one active via `memory.provider`. Live in a dedicated `plugins/memory/<name>/` subdirectory of any discovery source.
- **Context engines** — single-select via `context.engine`.
- **Model providers** — multi-register, picked per run.

Management goes through `hermes plugins` (interactive UI), `hermes plugins install <user/repo>` (GitHub), `enable` / `disable` / `update` / `remove`. A manifest may declare `requires_env:` — missing variables are prompted for during install and gate loading.

### 1.3 The lifecycle a memory provider sees

General plugins subscribe to hooks (`pre_llm_call`, `post_llm_call`, `on_session_start/end/finalize/reset`, `pre/post_tool_call`, …). A **memory provider does not need them**: once selected, the runtime drives it through a dedicated pipeline — this is the biggest structural difference from OpenClaw, where we assembled the same loop by hand out of four hooks.

```text
initialize(session_id, hermes_home)        agent startup (once)
system_prompt_block()                      static header into the system prompt
──── per turn, repeats ─────────────────────────────────────────────
1 · prefetch(query, session_id)            recall — injected into this turn
      model runs (tool loop)
2 · sync_turn(user, assistant, …, messages)   capture — non-blocking
──── endings ───────────────────────────────────────────────────────
on_session_end · on_pre_compress · shutdown   seal the tail
```

The runtime automation, verbatim from the docs: when a provider is active, Hermes "injects provider context into the system prompt, prefetches relevant memories before each turn, syncs conversation turns to the provider after each response, extracts memories on session end, mirrors built-in memory writes to the external provider, and adds provider-specific tools."

Two contract points to respect:

- **`is_available()` must make NO network calls** — env/config checks only; real connectivity is probed later.
- **`sync_turn()` must be non-blocking** — long work goes to a daemon thread (the docs show the exact pattern).

---

## Part 2 — Hermes's existing memory plugins

### 2.1 Built-in memory

Hermes always maintains two files in `~/.hermes/memories/`:

- **`MEMORY.md`** (~2,200-char cap) — the agent's own notes: environment facts, conventions, lessons.
- **`USER.md`** (~1,375-char cap) — the user profile: preferences, communication style.

Both are injected into the system prompt as a **frozen snapshot at session start**, and edited through a `memory` tool (`add` / `replace` / `remove`). This is honest, readable, and tiny — but it is a *snapshot*, capped at ~1,300 tokens total, with no retrieval: everything the agent "remembers" must fit in the file and is only as fresh as session start.

External memory providers exist to lift exactly those limits — and, notably, they run **alongside** the built-in files, never replacing them. (Contrast OpenClaw, where a memory plugin *displaces* the stock `memory-core`.)

### 2.2 The external providers

Eight providers ship in-tree under `plugins/memory/`; one may be active at a time via `memory.provider`:

- **Honcho**
  - *Storage:* cloud service (or self-hosted)
  - *Locality:* cloud
  - *Tools:* 5 — `honcho_profile`, `honcho_search`, `honcho_context`, `honcho_reasoning`, `honcho_conclude`
  - *Note:* dialectic *user modeling* — two-layer injection of session summary + peer card with LLM-synthesized reasoning.
- **OpenViking**
  - *Storage:* filesystem-style knowledge hierarchy
  - *Locality:* self-hosted, AGPL
  - *Tools:* 5 — `viking_search`, `viking_read`, `viking_browse`, `viking_remember`, `viking_add_resource`
  - *Note:* tiered context loading (L0 ~100 tokens → L1 ~2k → L2 full).
- **Mem0**
  - *Storage:* vector store + server-extracted facts
  - *Locality:* cloud / Docker / in-process OSS
  - *Tools:* 4 — `mem0_search`, `mem0_add`, `mem0_update`, `mem0_delete`
  - *Note:* server-side LLM fact extraction, semantic search, dedup.
- **Hindsight**
  - *Storage:* knowledge graph with entity resolution
  - *Locality:* cloud or local embedded PostgreSQL
  - *Tools:* 3 — `hindsight_retain`, `hindsight_recall`, `hindsight_reflect`
  - *Note:* `hindsight_reflect` cross-memory synthesis — unique among the eight.
- **Holographic**
  - *Storage:* local SQLite
  - *Locality:* local, zero external deps
  - *Tools:* 2 — `fact_store` (9 actions multiplexed), `fact_feedback`
  - *Note:* FTS5 + trust scoring + HRR compositional queries.
- **RetainDB**
  - *Storage:* cloud store, 7 memory types + delta compression
  - *Locality:* cloud, paid
  - *Tools:* 5 — `retaindb_profile`, `retaindb_search`, `retaindb_context`, `retaindb_remember`, `retaindb_forget`
  - *Note:* hybrid search (vector + BM25 + rerank).
- **ByteRover**
  - *Storage:* local Markdown knowledge tree
  - *Locality:* local (optional cloud sync)
  - *Tools:* 3 — `brv_query`, `brv_curate`, `brv_status`
  - *Note:* pre-compression insight extraction.
- **Supermemory**
  - *Storage:* session-graph semantic long-term store
  - *Locality:* cloud or self-hosted
  - *Tools:* 4 — `supermemory_store`, `supermemory_search`, `supermemory_forget`, `supermemory_profile`
  - *Note:* context fencing against recursive memory pollution.

### 2.3 Comparing the plugins

**Similarities:** all eight follow the same runtime pipeline (prefetch → sync → session-end extraction). The differences are in storage and locality.

**Differences — storage:** readable files (ByteRover's Markdown tree), local databases (Holographic's SQLite, Hindsight's embedded Postgres), knowledge graphs (Hindsight), and remote services (Honcho, RetainDB, Supermemory, Mem0 cloud).

**Differences — locality:** fully local and free (Holographic, ByteRover default, OpenViking self-hosted) versus cloud/paid (Honcho, RetainDB, Supermemory, Mem0 cloud).

**The EverOS fit.** The most useful thing this provider list proves is that everything EverOS does is already confirmed to work, piece by piece: **local, human-readable Markdown as the source of truth** — ByteRover proves that path works; **hybrid vector + BM25 + scalar retrieval** — RetainDB proves its retrieval value (EverOS does it locally via LanceDB); **LLM extraction into profiles/episodes/facts** — Mem0/Honcho prove automatic extraction holds up (EverOS runs it self-hosted). What EverOS does is combine those separately-validated properties in one already-in-production backend — plus the **agent track** (cases + skills) none of the eight offers. Nor is the combination theoretical: since the OpenClaw plugin shipped, the EverOS server, its API, and its provisioning flow have been running and validated under a live agent host. The plugin adds no new mechanism — it carries a field-proven backend into a purpose-built socket.

---

## Part 3 — Hermes Memory — EverOS design details

### 3.1 Goal and design principles

**Goal:** give Hermes cross-session, persistent memory backed by EverOS — the same EverOS instance that already serves OpenClaw.

Hermes Memory — EverOS is a **native Hermes memory provider** — a thin Python `MemoryProvider` over EverOS's local HTTP API. It becomes the single active external provider (`memory.provider: "everos"`) and captures **both EverOS tracks**: the developer's profile + episodes (user track) and the agent's distilled cases + skills (agent track), which requires EverOS running `mode = "agent"`.

**Principles** (unchanged from the OpenClaw plugin):

1. **Mirror EverOS — invent nothing.** The provider forwards to EverOS and supplies only what each request requires.
2. **Fail-open.** If EverOS is unavailable, every provider method no-ops and the session proceeds normally.

And one new principle this host makes possible:

3. **One brain, many agents.** The provider talks to the *same* EverOS server as the OpenClaw plugin — same store, same infrastructure, partitioned by `app_id` (`"hermes"` vs `"openclaw"`). Nothing is duplicated on disk or in process.

### 3.2 Decisions

1. **HTTP, not import.** Hermes and EverOS are both Python, so the tempting shortcut is `import everos` in-process. We deliberately keep the **HTTP request path** (`POST /add`, `/search`, `/flush`): (a) one EverOS server must serve multiple agent hosts concurrently — in-process would fork the store; (b) EverOS's OME engine is single-instance by lock — two embedded copies cannot coexist; (c) process isolation keeps a memory-backend crash from taking the agent down. Python-native still pays off — in provisioning (below) and in shipping zero extra runtimes.
2. **Detect-then-provision, in `initialize()`.** On agent startup the provider health-checks EverOS: use it if up; start it if installed (same detect-then-start flow the OpenClaw plugin proved, including the venv start command and `EVEROS_MEMORIZE__MODE=agent` + port forcing); guide the user if missing (`everos init`, keys in `~/.everos/everos.toml`). All of it in a daemon thread — `initialize` returns immediately, fail-open.
3. **Context-mode only — no tools.** The provider implements `prefetch`/`sync_turn`/`on_session_end` and returns **no tool schemas**. Recall is automatic every turn; EverOS's only write path is `/add`, which sync already covers. This mirrors the OpenClaw decision (no model-callable memory tools) and matches the "context" recall mode several Hermes providers offer.
4. **Built-in memory stays; we mirror its writes.** Hermes's `MEMORY.md`/`USER.md` remain active by design (providers run alongside, never replace). We implement `on_memory_write` to forward those explicit, user-approved notes into EverOS via `/add` — they are exactly the durable facts EverOS's extractor wants, and the extractor dedups.

### 3.3 Architecture

```text
Hermes session (Python)
        │
Hermes Memory — EverOS        MemoryProvider · plugins/memory/everos/
        │   app_id="hermes"
EverOS backend (unmodified) · 127.0.0.1:8000
        │   POST /search · /add · /flush
Markdown (source of truth) · SQLite (state · audit · queue) · LanceDB (vector + BM25 + scalar)
```

EverOS is **unmodified**. Everything funnels through three endpoints, and every request is stamped `app_id="hermes"` — the label that keeps Hermes's memories scoped inside the store. (The same server can serve other agent hosts side by side.)

### 3.4 File layout

```
plugins/memory/everos/            # under ~/.hermes/plugins/ (user install)
├── plugin.yaml                   # manifest: name, version, description, hooks
├── __init__.py                   # EverosMemoryProvider + register(ctx)
├── client.py                     # thin HTTP client (/search, /add, /flush, /health)
├── provision.py                  # detect-then-provision of the EverOS server
├── cli.py                        # optional: `hermes everos status`
└── README.md                     # setup + config reference
```

**`plugin.yaml`** — the manifest declares identity and which optional pipeline methods we implement:

```yaml
name: everos
version: "1.0.0"
manifest_version: 1
description: "EverOS-backed cross-session memory — markdown source of truth, hybrid recall, user + agent tracks."
hooks:
  - sync_turn
  - on_session_end
  - on_pre_compress
  - on_session_switch
  - on_memory_write
  - on_delegation
```

No `requires_env:` — EverOS's keys are EverOS configuration (`~/.everos/everos.toml`), not plugin configuration (mirror principle). What the *plugin* needs is prompted by `hermes memory setup` via `get_config_schema()` (§3.8).

**Versioning:** `version` is a per-release label — bump it each release; nothing enforces it. The one field Hermes *does* enforce is `manifest_version`: the installer refuses plugins that require a newer manifest format than it understands. Since monorepo-subdirectory installs keep no `.git`, `hermes plugins update` refuses them — users update by re-running the install command (the optional pip channel versions via the package).

### 3.5 Implementation: the provider

The whole integration is one class implementing the documented `MemoryProvider` surface, plus a two-line `register`:

```python
# __init__.py — sketch; error handling and rendering elided, the shape is exact
from agent.memory_provider import MemoryProvider
from .client import EverosClient
from .provision import detect_then_provision

class EverosMemoryProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "everos"

    def is_available(self) -> bool:
        return True                      # config/env checks only — NO network (contract)

    def initialize(self, session_id: str, **kwargs) -> None:
        self._sid = session_id                           # kept for the seal-point flushes
        self._home = kwargs.get("hermes_home")           # profile-scoped config path
        self._cfg = load_config(self._home)              # $HERMES_HOME/everos.json
        self._client = EverosClient(self._cfg.base_url)
        detect_then_provision(self._client, self._cfg)   # daemon thread; fail-open

    # ── recall (before each model call) ─────────────────────────────────────
    def prefetch(self, query: str, *, session_id: str = "") -> str:
        try:  # two owner-scoped searches, concurrent; ~5s cap; fail-open
            user, agent = search_both_tracks(self._client, query, self._cfg)
            return render(user, agent)   # fenced, labeled untrusted historical context
        except Exception:
            return ""                    # slow/down → turn proceeds without memory

    # ── capture (after each completed turn; must be non-blocking) ───────────
    def sync_turn(self, user_content, assistant_content, *, session_id="", messages=None):
        spawn_daemon(lambda: self._client.add(
            to_turn(messages or [user_content, assistant_content],   # full turn incl. tool calls
                    session_id, self._cfg)))

    # ── seal the tail ────────────────────────────────────────────────────────
    def on_session_end(self, messages) -> None:
        self._client.flush(session_id=self._sid, app_id="hermes")    # fail-open

    def on_pre_compress(self, messages) -> str:
        self._client.flush(session_id=self._sid, app_id="hermes")    # seal before context discard
        return ""                        # no contribution to the compression summary

    def on_session_switch(self, new_session_id, *, reset=False, **kwargs) -> None:
        if reset:                        # genuinely new conversation — seal the old one
            self._client.flush(session_id=self._sid, app_id="hermes")
        self._sid = new_session_id       # /resume, /branch, compression — keep _sid fresh

    # ── mirror built-in MEMORY.md / USER.md writes ───────────────────────────
    def on_memory_write(self, action, target, content, metadata=None) -> None:
        self._client.add(note_as_turn(action, target, content, self._cfg))

    # ── capture delegated subagent work (task + result) ──────────────────────
    def on_delegation(self, task, result, *, child_session_id="", **kwargs) -> None:
        spawn_daemon(lambda: self._client.add(
            delegation_as_turn(task, result, child_session_id, self._cfg)))

    def get_tool_schemas(self) -> list:
        return []                        # context-mode only — no model-callable tools (§3.2)

    def shutdown(self) -> None:
        stop_spawned_everos_if_ours()

def register(ctx) -> None:
    ctx.register_memory_provider(EverosMemoryProvider())
```

Points of fidelity:

- **`prefetch` is the recall hot path** — the analog of OpenClaw's `before_prompt_build → prependContext`. Same two-track search, same rendering with the fenced *"untrusted historical data"* label, same fence-token neutralization (the prompt-injection hardening carries over verbatim — it lives in `render`).
- **`sync_turn` receives `messages`** — "OpenAI-style conversation context as of the completed turn," including tool calls and tool results. That is the same fidelity `agent_end` gave us in OpenClaw: the agent track gets full trajectories, not just the user/assistant text. The daemon-thread pattern satisfies the non-blocking contract (the fire-and-forget analog).
- **`on_pre_compress` is a gift** — a hook OpenClaw never offered. Hermes tells the provider *before* context compaction discards messages, so the tail is sealed at exactly the moment it is about to become unrecoverable. (In OpenClaw we needed a session-switch safety net for a related gap; here the host hands us the signal.)
- **`is_available` honors the no-network contract** — actual reachability is probed inside `initialize`'s provisioning thread and per-request with fail-open.
- **`system_prompt_block()` is deliberately not implemented** — it injects a static, session-long header, and nothing of ours belongs there: no tools to explain (§3.2), and the *untrusted historical data* labeling travels inline with each `prefetch` block (in `render`), where it cannot drift away from the content it guards.

### 3.6 ID / track mapping

| Hermes identifier | EverOS request field | Track |
|---|---|---|
| `session_id` (pipeline argument) | `session_id` | — |
| constant `"hermes"` | `app_id` | — |
| profile (`$HERMES_HOME` basename) or cwd project | `project_id` | — |
| developer id (config; default `$USER` / OS account) | user message `sender_id` | **user** |
| constant agent id (config; default `"hermes"`) | assistant `sender_id` = `agent_id` | **agent** |

Recall must use the same `app_id`/`project_id` as capture or it searches a different tree. EverOS must run `mode = "agent"` for one `/add` stream to feed both tracks — the provider forces `EVEROS_MEMORIZE__MODE=agent` when it spawns EverOS, exactly as the OpenClaw plugin does. The agent id is a single pooled constant per host: every model Hermes routes to accumulates into one agent's cases and skills.

**Cross-host note:** the user track is partitioned by `app_id`, so Hermes memories and OpenClaw memories live side by side in one store but do not automatically cross-pollinate. Cross-app recall is an EverOS-level capability decision, not something either plugin invents (mirror principle).

### 3.7 Runtime flows

- **Recall** (read, hot path): the runtime calls `prefetch(query)` before each model call — and Hermes centrally **rewrites the query into one concise English question** first (`plugins/memory/query_rewrite`, an auxiliary LLM; ≤320 chars), a host service OpenClaw didn't provide. (In OpenClaw the plugin built the query itself from the raw **latest N user messages** verbatim — no question-rewrite; here that job moves to the host.) Two owner-scoped `/search` calls run concurrently (`user_id` → episodes + profile via `include_profile`; `agent_id` → cases + skills), results render into a fenced block, ~5s fail-open cap.
- **Capture** (write, background): `sync_turn` after every completed turn → `/add` with the full turn (`messages` param), in a daemon thread. EverOS buffers and auto-extracts on topic boundaries, as always.
- **Seal** (three signals, all → `/flush`): `on_session_end` (every conversation close), `on_pre_compress` (before context compaction), and `shutdown` (process exit — flush then stop a self-spawned EverOS). `on_session_switch` keeps the seals honest: Hermes rotates `session_id` mid-process (`/resume`, `/branch`, `/reset`, compression), so the provider retargets its cached id — flushing first on a true reset. Hermes's session model (`on_session_end` fires at the end of every `run_conversation` and CLI exit) is richer than the OpenClaw TUI's was, so the stranded-tail class of bug is structurally smaller here.
- **Mirror** (write, rare): `on_memory_write` forwards built-in `MEMORY.md`/`USER.md` edits into `/add` — explicit user-curated facts are premium extraction input; EverOS dedups.
- **Delegation** (write, occasional): `on_delegation` forwards each subagent's task + result pair into `/add` — the parent-visible summary of delegated work is a distilled trajectory the agent track wants; the child's full transcript stays in Hermes's session store (child runs `skip_memory=True`).
- **Lifecycle** (bootstrap, once): `initialize` → detect-then-provision (health-check → start if installed → guide `everos init` if not), non-blocking, fail-open.

### 3.8 Configuration

Provider config is prompted by **`hermes memory setup`** (the host's built-in setup flow — no custom installer needed, unlike OpenClaw where we shipped `everos-setup`) via `get_config_schema()`, and persisted by `save_config()` to `$HERMES_HOME/everos.json`:

| Key | Default | Purpose |
|---|---|---|
| `base_url` | `http://127.0.0.1:8000` | Where EverOS is (scheme-less values normalized) |
| `user_id` | `$USER` / OS account | Developer identity for the user track |
| `agent_id` | `"hermes"` | Constant pooled agent identity |
| `query_max_units` | `500` | Weighted head-clip ceiling for the recall query (CJK char = 2 units, other = 1) |
| `everos_dir` | — | EverOS checkout, for auto-start from a venv |
| `start_cmd` | `everos server start` | Auto-start command (quotes group spaced paths) |

> `memory.provider: "everos"` in `config.yaml` activates it (written by the setup picker). Query construction knobs are plugin-side; extraction, storage, and models remain EverOS's own (`~/.everos/everos.toml`) — the mirror principle unchanged. The same goes for the port: `8000` is just EverOS's shipped default (`default.toml`), user-changeable in `~/.everos/everos.toml` — `base_url` here follows wherever EverOS listens.
>
> **Query construction differs from OpenClaw.** There, the plugin assembled the query itself from the raw latest N user messages (an `EVEROS_OC_QUERY_N` knob, head-clipped by a plain character count). Hermes instead rewrites the latest message into one concise English question *before* `prefetch` (`plugins/memory/query_rewrite`), so there is **no `query_n`** here — message blending is the host's job. The clip therefore only fires on the fallback path, when the rewrite fails and the raw (possibly CJK) message reaches the provider. And it is a **weighted** clip: a naive character count is unfair across languages (500 CJK characters carry far more than 500 Latin ones), so — following the 2:1 weighting that Twitter/X and the Unicode East-Asian-Width standard both use — a CJK/fullwidth character counts as 2 units and everything else as 1, capped at `query_max_units` (default 500, computed with stdlib `unicodedata.east_asian_width`, no dependency).

### 3.9 Privacy and performance

- **Cascade lag** — a just-written memory becomes searchable a few seconds later; acceptable, the value is cross-session.
- **Privacy** — *stays local:* the store (Markdown/SQLite/LanceDB) and the provider↔EverOS link (`127.0.0.1`). *Leaves the machine:* conversation text goes to EverOS's configured LLM + embedding providers for extraction — cloud by default unless EverOS is pointed at local models. Per Hermes convention the provider README must "document what data leaves the device"; `sync_turn`'s payload is exactly that documentation surface.
- **Threading** — recall is capped (~5s, fail-open); capture and flush run in daemon threads; `initialize` returns immediately. The provider never blocks a turn.

### 3.10 Install and run

**Install** (GitHub, the native channel for user plugins):

```bash
hermes plugins install EverMind-AI/plugins           # monorepo → ~/.hermes/plugins/memory/everos/
hermes memory setup                                   # pick "everos"; prompts the schema fields
hermes memory status                                  # verify: provider active, EverOS healthy
```

`hermes memory setup` writes `memory.provider: "everos"` and the provider config; `initialize` detect-then-provisions EverOS on next start. There is **no consent-grant step**: unlike OpenClaw (where third-party plugins are blocked from conversation content until `allowConversationAccess` is granted), a selected Hermes memory provider receives turns by design — selection *is* consent. Enabling the plugin and choosing it as the provider are the explicit user actions.

**One-time setup outside the plugin** (identical to OpenClaw): EverOS needs `everos init` once and API keys in `~/.everos/everos.toml`. First run detects the missing config and points the user at it.

**One full iteration:**

1. Install, `hermes memory setup`, pick `everos`.
2. EverOS keys once (if not already set up for OpenClaw — shared!).
3. Start Hermes → `initialize` provisions EverOS → recall is live.
4. Work → each turn syncs via `/add`; session end / pre-compress / exit flush; the cascade indexes into LanceDB — and the same memories are on disk in Markdown, readable in `~/.everos/hermes/`.

