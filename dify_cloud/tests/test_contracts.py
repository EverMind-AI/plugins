from __future__ import annotations

import pytest

from utils.client import EverOSError
from utils.contracts import (
    validate_add_response,
    validate_flush_response,
    validate_search_response,
)


def test_validates_add_and_flush_envelopes() -> None:
    add = validate_add_response(
        {
            "request_id": "req-add",
            "data": {"message_count": 2, "status": "queued"},
        }
    )
    flush = validate_flush_response(
        {"request_id": "req-flush", "data": {"status": "no_extraction"}}
    )
    assert add["request_id"] == "req-add"
    assert add["data"]["status"] == "queued"
    assert flush["request_id"] == "req-flush"


def test_add_and_flush_only_return_allowlisted_contract_fields() -> None:
    add = validate_add_response(
        {
            "request_id": "req-add",
            "data": {
                "message_count": 2,
                "status": "extracted",
                "internal_debug": "must-not-leak",
            },
        }
    )
    flush = validate_flush_response(
        {
            "request_id": "req-flush",
            "data": {
                "status": "no_extraction",
                "internal_debug": "must-not-leak",
            },
        }
    )

    assert add["data"] == {"message_count": 2, "status": "extracted"}
    assert flush["data"] == {"status": "no_extraction"}


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"request_id": None, "data": {"message_count": 2, "status": "extracted"}},
        {"request_id": "req", "data": {"message_count": 1, "status": "extracted"}},
        {"request_id": "req", "data": {"message_count": 2, "status": "unknown"}},
    ],
)
def test_rejects_false_positive_add_responses(response: object) -> None:
    with pytest.raises(EverOSError):
        validate_add_response(response)


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"request_id": "req", "data": {}},
        {"request_id": "req", "data": {"status": "unknown"}},
    ],
)
def test_rejects_false_positive_flush_responses(response: object) -> None:
    with pytest.raises(EverOSError):
        validate_flush_response(response)


def test_search_requires_request_id_and_all_contract_arrays() -> None:
    response = {
        "request_id": "req-search",
        "data": {
            "episodes": [],
            "profiles": [],
            "agent_cases": [],
            "agent_skills": [],
            "unprocessed_messages": [],
        },
    }
    assert validate_search_response(response)["request_id"] == "req-search"

    response["request_id"] = None
    with pytest.raises(EverOSError):
        validate_search_response(response)


def test_search_rejects_missing_or_wrong_typed_arrays() -> None:
    with pytest.raises(EverOSError, match="episodes"):
        validate_search_response(
            {
                "request_id": "req",
                "data": {
                    "profiles": [],
                    "agent_cases": [],
                    "agent_skills": [],
                    "unprocessed_messages": [],
                },
            }
        )
