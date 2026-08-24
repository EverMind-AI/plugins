from __future__ import annotations

import pytest

from utils.payloads import (
    InputError,
    build_add_payload,
    build_flush_payload,
    build_search_payload,
    project_id,
    runtime_app_id,
    runtime_session_id,
    runtime_user_id,
    top_k,
)


def test_search_uses_llm_only_keyword_path_and_platform_app_scope() -> None:
    payload = build_search_payload(
        user_id="user+1@example.com",
        query="What did I decide?",
        limit=7,
        app="dify-a-apphash",
        project="product-a",
    )

    assert payload == {
        "user_id": "user+1@example.com",
        "app_id": "dify-a-apphash",
        "project_id": "product-a",
        "query": "What did I decide?",
        "method": "keyword",
        "top_k": 7,
        "include_profile": True,
    }


def test_add_and_flush_share_identical_scope() -> None:
    add = build_add_payload(
        user_id="user-1",
        conversation_id="conversation/accepted-by-everos",
        user_message="I prefer short answers.",
        assistant_message="Understood.",
        app="dify-a-apphash",
        project="default",
        timestamp_ms=1_700_000_000_000,
    )
    flush = build_flush_payload(
        conversation_id="conversation/accepted-by-everos",
        app="dify-a-apphash",
        project="default",
    )

    assert add["session_id"] == flush["session_id"]
    assert add["app_id"] == flush["app_id"] == "dify-a-apphash"
    assert add["project_id"] == flush["project_id"] == "default"
    assert add["messages"] == [
        {
            "sender_id": "user-1",
            "role": "user",
            "timestamp": 1_700_000_000_000,
            "content": "I prefer short answers.",
        },
        {
            "sender_id": "dify",
            "role": "assistant",
            "timestamp": 1_700_000_000_001,
            "content": "Understood.",
        },
    ]


@pytest.mark.parametrize("value", [".", "..", "a/b", "a b", "a\\b"])
def test_rejects_unsafe_path_identifiers(value: str) -> None:
    with pytest.raises(InputError):
        build_search_payload(
            user_id=value,
            query="query",
            limit=5,
            app="dify",
            project="default",
        )


@pytest.mark.parametrize("value", [0, -1, 5.5, 101, True, "nope"])
def test_rejects_invalid_top_k(value: object) -> None:
    with pytest.raises(InputError):
        top_k(value)


def test_project_id_defaults_to_default() -> None:
    assert project_id({}) == "default"


def test_rejects_oversized_content_before_network_call() -> None:
    with pytest.raises(InputError, match="100000"):
        build_add_payload(
            user_id="user",
            conversation_id="conversation",
            user_message="x" * 100_001,
            assistant_message="answer",
            app="dify",
            project="default",
        )


def test_preserves_message_whitespace() -> None:
    payload = build_add_payload(
        user_id="user",
        conversation_id="conversation",
        user_message="  indented user text\n",
        assistant_message="  indented answer\n",
        app="dify",
        project="default",
        timestamp_ms=1,
    )
    assert payload["messages"][0]["content"] == "  indented user text\n"
    assert payload["messages"][1]["content"] == "  indented answer\n"


def test_runtime_ids_are_domain_separated_and_collision_resistant() -> None:
    user = runtime_user_id("stable-id")
    app = runtime_app_id("stable-id")
    assert user.startswith("dify-u-")
    assert app.startswith("dify-a-")
    assert user != app
    assert user == runtime_user_id("stable-id")
    assert len(user) == 71
    assert runtime_user_id(user) != user


def test_runtime_session_id_is_bounded_and_has_non_chat_fallback() -> None:
    mapped = runtime_session_id("conversation/1")
    assert mapped.startswith("dify-s-")
    assert len(mapped) == 71
    assert len(runtime_session_id("x" * 129)) == 71
    fallback = runtime_session_id(None)
    assert fallback.startswith("dify-s-")
    assert len(fallback) == 39


@pytest.mark.parametrize("value", [None, ""])
def test_runtime_app_id_fails_closed_when_platform_scope_is_missing(
    value: object,
) -> None:
    with pytest.raises(InputError, match="runtime app_id"):
        runtime_app_id(value)
