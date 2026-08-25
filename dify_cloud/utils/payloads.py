"""Validate Dify inputs and construct EverOS API requests."""

from __future__ import annotations

import re
import secrets
import time
from hashlib import sha256
from typing import Any

AGENT_ID = "dify"
DEFAULT_PROJECT_ID = "default"
_PATH_SAFE_RE = re.compile(r"^[a-zA-Z0-9_.@+-]+$")
_MAX_TEXT_LENGTH = 100_000


class InputError(ValueError):
    """A user-actionable tool input error."""


def _required_text(
    value: object,
    name: str,
    *,
    max_length: int,
    preserve_whitespace: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InputError(f"{name} is required")
    text = value.strip()
    if len(text) > max_length:
        raise InputError(f"{name} must be at most {max_length} characters")
    return value if preserve_whitespace else text


def _path_safe_id(value: object, name: str) -> str:
    identifier = _required_text(value, name, max_length=128)
    if identifier in {".", ".."} or not _PATH_SAFE_RE.fullmatch(identifier):
        raise InputError(
            f"{name} may contain only letters, numbers, _, ., @, +, and -"
        )
    return identifier


def session_id(value: object) -> str:
    identifier = _required_text(value, "conversation_id", max_length=128)
    if any(ord(char) < 32 for char in identifier):
        raise InputError("conversation_id must not contain control characters")
    return identifier


def _runtime_scope_id(value: object, *, field: str, domain: str) -> str:
    identifier = _required_text(value, field, max_length=10_000)
    digest = sha256(f"{domain}\0{identifier}".encode()).hexdigest()
    return f"dify-{domain}-{digest}"


def runtime_user_id(value: object) -> str:
    """Domain-hash Dify's platform-controlled user id for EverOS ownership."""
    return _runtime_scope_id(value, field="Dify runtime user_id", domain="u")


def runtime_app_id(value: object) -> str:
    """Derive a stable EverOS app scope from Dify's platform app id."""
    return _runtime_scope_id(value, field="Dify runtime app_id", domain="a")


def runtime_session_id(value: object) -> str:
    """Use Dify's session id, or create an isolated id for non-chat workflows."""
    if isinstance(value, str) and value.strip():
        return _runtime_scope_id(value, field="Dify runtime session_id", domain="s")
    return f"dify-s-{secrets.token_hex(16)}"


def top_k(value: object) -> int:
    if value in (None, ""):
        return 5
    if isinstance(value, bool):
        raise InputError("top_k must be an integer from 1 to 100")
    if isinstance(value, float) and not value.is_integer():
        raise InputError("top_k must be an integer from 1 to 100")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise InputError("top_k must be an integer from 1 to 100") from exc
    if parsed < 1 or parsed > 100:
        raise InputError("top_k must be an integer from 1 to 100")
    return parsed


def build_search_payload(
    *,
    user_id: object,
    query: object,
    limit: object,
    app: str,
    project: str,
) -> dict[str, Any]:
    return {
        "user_id": _path_safe_id(user_id, "user_id"),
        "app_id": _path_safe_id(app, "app_id"),
        "project_id": _path_safe_id(project, "project_id"),
        "query": _required_text(
            query,
            "query",
            max_length=_MAX_TEXT_LENGTH,
            preserve_whitespace=True,
        ),
        # EverOS Cloud recommends hybrid retrieval for normal chat recall.
        "method": "hybrid",
        "top_k": top_k(limit),
        "include_profile": True,
    }


def build_add_payload(
    *,
    user_id: object,
    conversation_id: object,
    user_message: object,
    assistant_message: object,
    app: str,
    project: str,
    timestamp_ms: int | None = None,
) -> dict[str, Any]:
    uid = _path_safe_id(user_id, "user_id")
    sid = session_id(conversation_id)
    project = _path_safe_id(project, "project_id")
    now = timestamp_ms if timestamp_ms is not None else time.time_ns() // 1_000_000
    if now <= 0:
        raise InputError("timestamp must be positive")
    return {
        "session_id": sid,
        "app_id": _path_safe_id(app, "app_id"),
        "project_id": project,
        "messages": [
            {
                "sender_id": uid,
                "role": "user",
                "timestamp": now,
                "content": _required_text(
                    user_message,
                    "user_message",
                    max_length=_MAX_TEXT_LENGTH,
                    preserve_whitespace=True,
                ),
            },
            {
                "sender_id": AGENT_ID,
                "role": "assistant",
                "timestamp": now + 1,
                "content": _required_text(
                    assistant_message,
                    "assistant_message",
                    max_length=_MAX_TEXT_LENGTH,
                    preserve_whitespace=True,
                ),
            },
        ],
    }


def build_flush_payload(
    *, conversation_id: object, app: str, project: str
) -> dict[str, str]:
    return {
        "session_id": session_id(conversation_id),
        "app_id": _path_safe_id(app, "app_id"),
        "project_id": _path_safe_id(project, "project_id"),
    }
