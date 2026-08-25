from __future__ import annotations

from typing import Any

import pytest
from dify_plugin.core.runtime import Session
from dify_plugin.entities.tool import ToolRuntime

import tools.add_memory as add_module
import tools.search_memory as search_module
from utils.client import EverOSError
from utils.payloads import runtime_app_id, runtime_session_id, runtime_user_id


class SearchClient:
    payload: dict[str, Any] | None = None

    @classmethod
    def from_credentials(cls, _credentials: object) -> SearchClient:
        return cls()

    def __enter__(self) -> SearchClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        type(self).payload = payload
        return {
            "request_id": "req-search",
            "data": {
                "episodes": [],
                "profiles": [],
                "agent_cases": [],
                "agent_skills": [],
                "unprocessed_messages": [],
            },
        }


class AddClient:
    add_payload: dict[str, Any] | None = None
    flush_payload: dict[str, Any] | None = None

    @classmethod
    def from_credentials(cls, _credentials: object) -> AddClient:
        return cls()

    def __enter__(self) -> AddClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        type(self).add_payload = payload
        return {
            "request_id": "req-add",
            "data": {"message_count": 2, "status": "queued"},
        }

    def flush(self, payload: dict[str, Any]) -> dict[str, Any]:
        type(self).flush_payload = payload
        return {"request_id": "req-flush", "data": {"status": "extracted"}}


class AmbiguousAddClient(AddClient):
    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        type(self).add_payload = payload
        raise EverOSError("Could not read the configured EverOS endpoint")


def _runtime() -> ToolRuntime:
    return ToolRuntime(
        credentials={
            "base_url": "https://memory.example.com",
            "api_key": "cloud-secret",
        },
        user_id="platform-user",
        session_id="plugin-invocation-session",
    )


def _session() -> Session:
    session = Session.empty_session()
    session.app_id = "platform-app"
    session.conversation_id = "platform-conversation"
    return session


def test_search_ignores_attacker_supplied_scope_parameters(monkeypatch) -> None:
    monkeypatch.setattr(search_module, "EverOSClient", SearchClient)
    tool = search_module.SearchMemoryTool(_runtime(), _session())

    list(
        tool._invoke(
            {
                "query": "relevant context",
                "top_k": 5,
                "user_id": "attacker-selected-owner",
                "app_id": "attacker-selected-app",
            }
        )
    )

    assert SearchClient.payload is not None
    assert SearchClient.payload["user_id"] == runtime_user_id("platform-user")
    assert SearchClient.payload["app_id"] == runtime_app_id("platform-app")
    assert SearchClient.payload["project_id"] == "default"


def test_add_uses_platform_app_user_and_conversation(monkeypatch) -> None:
    monkeypatch.setattr(add_module, "EverOSClient", AddClient)
    tool = add_module.AddMemoryTool(_runtime(), _session())

    list(
        tool._invoke(
            {
                "user_message": "hello",
                "assistant_message": "hi",
                "user_id": "attacker-selected-owner",
                "conversation_id": "attacker-selected-session",
            }
        )
    )

    assert AddClient.add_payload is not None
    assert AddClient.flush_payload is not None
    expected_session = runtime_session_id("platform-conversation")
    expected_app = runtime_app_id("platform-app")
    assert AddClient.add_payload["messages"][0]["sender_id"] == runtime_user_id(
        "platform-user"
    )
    assert AddClient.add_payload["session_id"] == expected_session
    assert AddClient.flush_payload["session_id"] == expected_session
    assert AddClient.add_payload["app_id"] == expected_app
    assert AddClient.flush_payload["app_id"] == expected_app
    assert AddClient.add_payload["project_id"] == "default"
    assert AddClient.flush_payload["project_id"] == "default"


def test_add_transport_failure_reports_unknown_result_without_retry(
    monkeypatch,
) -> None:
    monkeypatch.setattr(add_module, "EverOSClient", AmbiguousAddClient)
    tool = add_module.AddMemoryTool(_runtime(), _session())

    with pytest.raises(RuntimeError) as caught:
        list(
            tool._invoke(
                {
                    "user_message": "hello",
                    "assistant_message": "hi",
                }
            )
        )

    message = str(caught.value)
    assert "result is unknown" in message
    assert "do not retry automatically" in message
