"""Strict response validation for the EverOS endpoints used by this plugin."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from utils.client import EverOSError

_SEARCH_ARRAYS = (
    "episodes",
    "profiles",
    "agent_cases",
    "agent_skills",
    "unprocessed_messages",
)


def _envelope(response: object, operation: str) -> tuple[str, Mapping[str, Any]]:
    if not isinstance(response, Mapping):
        raise EverOSError(f"EverOS {operation} returned an invalid response")
    request_id = response.get("request_id")
    data = response.get("data")
    if not isinstance(request_id, str) or not request_id:
        raise EverOSError(f"EverOS {operation} response did not contain request_id")
    if not isinstance(data, Mapping):
        raise EverOSError(f"EverOS {operation} response did not contain data")
    return request_id, data


def validate_search_response(response: object) -> dict[str, Any]:
    request_id, data = _envelope(response, "search")
    result: dict[str, Any] = {"request_id": request_id}
    for name in _SEARCH_ARRAYS:
        value = data.get(name)
        if not isinstance(value, list):
            raise EverOSError(
                f"EverOS search response field '{name}' was not a list"
            )
        result[name] = value
    return result


def validate_add_response(response: object) -> dict[str, Any]:
    request_id, data = _envelope(response, "add")
    message_count = data.get("message_count")
    status = data.get("status")
    if message_count != 2:
        raise EverOSError("EverOS add response reported an unexpected message count")
    if status not in {"accumulated", "extracted"}:
        raise EverOSError("EverOS add response reported an unknown status")
    return {
        "request_id": request_id,
        "data": {"message_count": message_count, "status": status},
    }


def validate_flush_response(response: object) -> dict[str, Any]:
    request_id, data = _envelope(response, "flush")
    status = data.get("status")
    if status not in {"extracted", "no_extraction"}:
        raise EverOSError("EverOS flush response reported an unknown status")
    return {"request_id": request_id, "data": {"status": status}}
