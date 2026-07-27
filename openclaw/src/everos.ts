/**
 * EverOS HTTP client (Phase 1).
 *
 * Thin, typed wrapper over the local EverOS framework's memory API
 * (`/api/v1/memory/*`). Zero runtime dependencies — uses the global `fetch`.
 * Mirrors EverOS; invents nothing.
 *
 * Envelope contract:
 *   success (2xx): `{ request_id, data }`            → returns `data`
 *   error (non-2xx): `{ request_id, error: {...} }`  → throws `EverosError`
 *   GET /health: bare `{ "status": "ok" }`           → not enveloped
 */
import type {
  AddRequest,
  AddResponse,
  ErrorBody,
  FlushRequest,
  FlushResponse,
  HealthResponse,
  SearchRequest,
  SearchResponse,
} from "./types.js";

/** Raised when EverOS returns a non-2xx envelope, or the call itself fails. */
export class EverosError extends Error {
  constructor(
    /** HTTP status (`0` for client-side / network failures). */
    readonly status: number,
    /** EverOS error code (`HTTP_ERROR` / `SYSTEM_ERROR`) or a client code. */
    readonly code: string | undefined,
    message: string,
    readonly requestId?: string,
    readonly path?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EverosError";
  }
}

/** EverOS `PathSafeId`: `^[a-zA-Z0-9_.-]+$`, never `.` or `..`. */
const SCOPE_RE = /^[a-zA-Z0-9_.-]+$/;

export function assertScopeId(value: string, field: string): void {
  if (value === "." || value === ".." || !SCOPE_RE.test(value)) {
    throw new EverosError(
      0,
      "INVALID_SCOPE_ID",
      `invalid ${field}: ${JSON.stringify(value)} — must match ${String(SCOPE_RE)} and not be "." or ".."`,
    );
  }
}

export interface EverosClientOptions {
  baseUrl: string;
  /** Default per-request timeout (ms). Omit for none (recall sets its own ~5s). */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the client default for this call. */
  timeoutMs?: number;
}

export interface EverosClient {
  health(opts?: CallOptions): Promise<HealthResponse>;
  add(req: AddRequest, opts?: CallOptions): Promise<AddResponse>;
  search(req: SearchRequest, opts?: CallOptions): Promise<SearchResponse>;
  flush(req: FlushRequest, opts?: CallOptions): Promise<FlushResponse>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function createEverosClient(options: EverosClientOptions): EverosClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  function signalFor(opts?: CallOptions): AbortSignal | undefined {
    const ms = opts?.timeoutMs ?? options.timeoutMs;
    const timeout = ms != null && ms > 0 ? AbortSignal.timeout(ms) : undefined;
    if (timeout && opts?.signal) return AbortSignal.any([timeout, opts.signal]);
    return timeout ?? opts?.signal;
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: CallOptions | undefined,
  ): Promise<{ status: number; ok: boolean; parsed: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signalFor(opts),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new EverosError(0, "NETWORK_ERROR", `${method} ${path} failed: ${reason}`, undefined, path, { cause });
    }
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new EverosError(
          res.status,
          "BAD_RESPONSE",
          `${method} ${path}: non-JSON response (HTTP ${res.status})`,
          undefined,
          path,
        );
      }
    }
    return { status: res.status, ok: res.ok, parsed };
  }

  /** POST returning the `data` of a success envelope, else throws. */
  async function enveloped<T>(path: string, body: unknown, opts?: CallOptions): Promise<T> {
    const { status, ok, parsed } = await call("POST", path, body, opts);
    if (ok && isRecord(parsed) && "data" in parsed) {
      return (parsed as { data: T }).data;
    }
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const e = parsed.error as unknown as ErrorBody;
      const requestId = typeof parsed.request_id === "string" ? parsed.request_id : undefined;
      throw new EverosError(status, e.code, e.message, requestId, e.path ?? path);
    }
    throw new EverosError(status, undefined, `${path}: unexpected response (HTTP ${status})`, undefined, path);
  }

  return {
    async health(opts) {
      const { status, ok, parsed } = await call("GET", "/health", undefined, opts);
      if (ok && isRecord(parsed) && parsed.status === "ok") {
        return { status: "ok" };
      }
      throw new EverosError(status, undefined, `/health: unexpected response (HTTP ${status})`, undefined, "/health");
    },

    async add(req, opts) {
      if (req.app_id !== undefined) assertScopeId(req.app_id, "app_id");
      if (req.project_id !== undefined) assertScopeId(req.project_id, "project_id");
      return enveloped<AddResponse>("/api/v1/memory/add", req, opts);
    },

    async search(req, opts) {
      const hasUser = req.user_id != null;
      const hasAgent = req.agent_id != null;
      if (hasUser === hasAgent) {
        throw new EverosError(0, "INVALID_OWNER", "exactly one of user_id / agent_id must be set");
      }
      if (req.app_id !== undefined) assertScopeId(req.app_id, "app_id");
      if (req.project_id !== undefined) assertScopeId(req.project_id, "project_id");
      return enveloped<SearchResponse>("/api/v1/memory/search", req, opts);
    },

    async flush(req, opts) {
      if (req.app_id !== undefined) assertScopeId(req.app_id, "app_id");
      if (req.project_id !== undefined) assertScopeId(req.project_id, "project_id");
      return enveloped<FlushResponse>("/api/v1/memory/flush", req, opts);
    },
  };
}
