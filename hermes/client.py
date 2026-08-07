"""EverOS HTTP client.

Thin, typed wrapper over the local EverOS memory API (``/api/v1/memory/*``).
Zero runtime dependencies — stdlib ``urllib`` only. Mirrors EverOS; invents
nothing. Ported from the shipped OpenClaw plugin's client (same contract).

Envelope contract:
  success (2xx): ``{request_id, data}``            -> returns ``data``
  error (non-2xx): ``{request_id, error: {...}}``  -> raises ``EverosError``
  GET /health: bare ``{"status": "ok"}``           -> not enveloped
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

SCOPE_RE = re.compile(r"^[a-zA-Z0-9_.-]+$")

# /add hard limit: Pydantic max_length=500 — a larger batch 422s wholesale.
ADD_MAX_MESSAGES = 500


class EverosError(Exception):
    """Raised when EverOS returns a non-2xx envelope, or the call fails."""

    def __init__(
        self,
        status: int,
        code: str | None,
        message: str,
        request_id: str | None = None,
        path: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status  # 0 for client-side / network failures
        self.code = code
        self.request_id = request_id
        self.path = path


def assert_scope_id(value: str, field: str) -> None:
    """EverOS ``PathSafeId``: ``^[a-zA-Z0-9_.-]+$``, never ``.`` or ``..``."""
    if value in (".", "..") or not SCOPE_RE.match(value):
        raise EverosError(
            0,
            "INVALID_SCOPE_ID",
            f"invalid {field}: {value!r} — must match {SCOPE_RE.pattern}"
            ' and not be "." or ".."',
        )


class EverosClient:
    """Synchronous client; every method accepts a per-call ``timeout_s``."""

    def __init__(self, base_url: str, timeout_s: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    # -- transport -----------------------------------------------------------

    def _call(
        self, method: str, path: str, body: dict[str, Any] | None, timeout_s: float | None
    ) -> tuple[int, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"content-type": "application/json"} if data is not None else {},
        )
        timeout = timeout_s if timeout_s is not None else self.timeout_s
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                status = res.status
                text = res.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:  # non-2xx still carries the envelope
            status = err.code
            text = err.read().decode("utf-8", errors="replace")
        except Exception as err:  # network / timeout / DNS — client-side failure
            raise EverosError(
                0, "NETWORK_ERROR", f"{method} {path} failed: {err}", path=path
            ) from err
        if not text:
            return status, None
        try:
            return status, json.loads(text)
        except ValueError as err:
            raise EverosError(
                status, "BAD_RESPONSE", f"{method} {path}: non-JSON response (HTTP {status})",
                path=path,
            ) from err

    def _enveloped(
        self, path: str, body: dict[str, Any], timeout_s: float | None
    ) -> dict[str, Any]:
        status, parsed = self._call("POST", path, body, timeout_s)
        if 200 <= status < 300 and isinstance(parsed, dict) and "data" in parsed:
            return parsed["data"]
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
            e = parsed["error"]
            raise EverosError(
                status,
                e.get("code"),
                e.get("message", f"{path}: HTTP {status}"),
                request_id=parsed.get("request_id"),
                path=e.get("path", path),
            )
        raise EverosError(
            status, None, f"{path}: unexpected response (HTTP {status})", path=path
        )

    # -- endpoints -----------------------------------------------------------

    def health(self, timeout_s: float | None = None) -> dict[str, Any]:
        status, parsed = self._call("GET", "/health", None, timeout_s)
        if 200 <= status < 300 and isinstance(parsed, dict) and parsed.get("status") == "ok":
            return {"status": "ok"}
        raise EverosError(
            status, None, f"/health: unexpected response (HTTP {status})", path="/health"
        )

    def add(self, req: dict[str, Any], timeout_s: float | None = None) -> dict[str, Any]:
        if "app_id" in req:
            assert_scope_id(req["app_id"], "app_id")
        if "project_id" in req:
            assert_scope_id(req["project_id"], "project_id")
        return self._enveloped("/api/v1/memory/add", req, timeout_s)

    def search(self, req: dict[str, Any], timeout_s: float | None = None) -> dict[str, Any]:
        # EverOS requires exactly one owner per search (XOR -> 422 server-side).
        if ("user_id" in req) == ("agent_id" in req):
            raise EverosError(
                0, "INVALID_OWNER", "exactly one of user_id / agent_id must be set"
            )
        if "app_id" in req:
            assert_scope_id(req["app_id"], "app_id")
        if "project_id" in req:
            assert_scope_id(req["project_id"], "project_id")
        return self._enveloped("/api/v1/memory/search", req, timeout_s)

    def flush(self, req: dict[str, Any], timeout_s: float | None = None) -> dict[str, Any]:
        if "app_id" in req:
            assert_scope_id(req["app_id"], "app_id")
        if "project_id" in req:
            assert_scope_id(req["project_id"], "project_id")
        return self._enveloped("/api/v1/memory/flush", req, timeout_s)
