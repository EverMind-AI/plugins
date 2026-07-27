/**
 * Wire types for the EverOS memory API (`/api/v1/memory/*`).
 *
 * These mirror the EverOS request/response DTOs exactly — we forward to
 * EverOS and invent nothing. Source of truth: the EverOS repo
 * (`memorize.py`, `search/dto.py`) and `implementation-contract.md` §4.
 */

// ─── Shared ────────────────────────────────────────────────────────────────

/** Message author role accepted by `/add`. */
export type Role = "user" | "assistant" | "tool";

/** A non-text content part (image / audio / doc / …). */
export interface ContentItem {
  type: "text" | "image" | "audio" | "doc" | "pdf" | "html" | "email";
  text?: string;
  uri?: string;
  base64?: string;
  ext?: string;
  name?: string;
  extras?: Record<string, unknown>;
}

/** An assistant tool call, mirroring EverOS `ToolCallDTO` (OpenAI Chat Completions shape). */
export interface ToolCall {
  id: string;
  /** Defaults to "function" server-side. */
  type?: string;
  /** `arguments` is a JSON **string**, per the OpenAI spec EverOS follows. */
  function: { name: string; arguments: string };
}

/** One message in an `/add` batch. `timestamp` is UNIX **milliseconds**. */
export interface MessageItem {
  sender_id: string;
  role: Role;
  /** UNIX epoch in **milliseconds** (EverOS contract — not seconds). */
  timestamp: number;
  content: string | ContentItem[];
  sender_name?: string;
  /** Assistant-side tool calls (role "assistant"). */
  tool_calls?: ToolCall[];
  /** Links a role "tool" result back to its originating call. */
  tool_call_id?: string;
}

/** Response envelope error body (non-2xx). */
export interface ErrorBody {
  code: string;
  message: string;
  timestamp?: string;
  path?: string;
}

// ─── /api/v1/memory/add ──────────────────────────────────────────────────

export interface AddRequest {
  session_id: string;
  messages: MessageItem[];
  /** Defaults to `"default"` server-side. Path-segment — keep recall in sync. */
  app_id?: string;
  /** Defaults to `"default"` server-side. Workspace/repo scope. */
  project_id?: string;
}

export interface AddResponse {
  message_count: number;
  status: "accumulated" | "extracted";
}

// ─── /api/v1/memory/search ─────────────────────────────────────────────────

export type SearchMethod = "keyword" | "vector" | "hybrid" | "agentic";

/** Exactly one of `user_id` / `agent_id` — enforced at the type level. */
export type SearchOwner = { user_id: string; agent_id?: undefined } | { agent_id: string; user_id?: undefined };

export type SearchRequest = SearchOwner & {
  query: string;
  app_id?: string;
  project_id?: string;
  /** Default `hybrid`. */
  method?: SearchMethod;
  /** `-1` (unlimited) or `1..100`. We omit it and let EverOS default. */
  top_k?: number;
  /**
   * Cosine-similarity threshold (0..1). We do NOT set it — EverOS owns the
   * default (`_effective_radius`). Present only for completeness.
   */
  radius?: number;
  /** User track only — fetch the profile regardless of query. */
  include_profile?: boolean;
  /** Agent track only. */
  enable_llm_rerank?: boolean;
  filters?: unknown;
};

/** The five result arrays — always present (default `[]`). */
export interface SearchResponse {
  episodes: unknown[];
  profiles: unknown[];
  agent_cases: unknown[];
  agent_skills: unknown[];
  unprocessed_messages: unknown[];
}

// ─── /api/v1/memory/flush ──────────────────────────────────────────────────

export interface FlushRequest {
  session_id: string;
  app_id?: string;
  project_id?: string;
}

export interface FlushResponse {
  status: "extracted" | "no_extraction";
}

// ─── GET /health (bare body — NOT enveloped) ─────────────────────────────────

export interface HealthResponse {
  status: "ok";
}
