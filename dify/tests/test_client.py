from __future__ import annotations

import json
from typing import Any

import pytest
import requests

from utils.client import EverOSClient, EverOSError


class FakeResponse:
    def __init__(self, status_code: int, payload: object) -> None:
        self.status_code = status_code
        self.raw = json.dumps(payload).encode()
        self.closed = False

    def iter_content(self, chunk_size: int):
        del chunk_size
        yield self.raw

    def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(
        self,
        response: FakeResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    "url",
    [
        "",
        "memory.example.com",
        "ftp://memory.example.com",
        "https://user" + ":secret@memory.example.com",
        "https://memory.example.com?debug=1",
        "https://memory.example.com/#fragment",
        "https://memory.example.com/\nheader",
        "http://memory.example.com",
        "http://169.254.169.254/latest/meta-data",
        "http://[fe80::1]/metadata",
        "http://2852039166/latest/meta-data",
        "http://0xA9FEA9FE/latest/meta-data",
        "http://0251.0376.0251.0376/latest/meta-data",
        "https://169.254.169.254/latest/meta-data",
        "https://[fe80::1]/metadata",
        "https://0.0.0.0/service",
        "https://[::]/service",
        "https://2852039166/latest/meta-data",
        "https://0xA9FEA9FE/latest/meta-data",
        "https://0251.0376.0251.0376/latest/meta-data",
        "https://[::ffff:169.254.169.254]/latest/meta-data",
    ],
)
def test_rejects_unsafe_base_urls(url: str) -> None:
    with pytest.raises(EverOSError):
        EverOSClient(url)


def test_health_preserves_gateway_prefix_and_sends_token_without_redirects() -> None:
    response = FakeResponse(
        200,
        {
            "status": "ok",
            "version": "1.2.3",
            "capabilities": {"llm": True},
        },
    )
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com/everos/",
        "gateway-secret",
        session=session,  # type: ignore[arg-type]
    )

    assert client.health()["status"] == "ok"
    call = session.calls[0]
    assert call["url"] == "https://memory.example.com/everos/health"
    assert call["headers"]["Authorization"] == "Bearer gateway-secret"
    assert call["allow_redirects"] is False
    assert call["timeout"] == (5, 10)
    assert response.closed is True


def test_redirect_is_rejected_without_leaking_location() -> None:
    response = FakeResponse(307, {"message": "moved"})
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        "gateway-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError, match="redirect") as caught:
        client.health()
    assert "gateway-secret" not in str(caught.value)


def test_transport_error_is_sanitized() -> None:
    session = FakeSession(error=requests.ConnectionError("secret diagnostic"))
    client = EverOSClient(
        "https://memory.example.com",
        "gateway-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    assert str(caught.value) == "Could not connect to the configured EverOS endpoint"
    assert "secret" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__ is True


def test_http_error_does_not_echo_server_response() -> None:
    response = FakeResponse(401, {"message": "invalid gateway credential"})
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    assert str(caught.value) == "EverOS returned HTTP 401"
    assert "credential" not in str(caught.value)


def test_http_error_does_not_echo_credentials_or_upstream_details() -> None:
    response = FakeResponse(
        502,
        {
            "message": (
                "upstream rejected Authorization: Bearer gateway-secret; "
                "api_key=another-secret"
            )
        },
    )
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        "gateway-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    message = str(caught.value)
    assert message == "EverOS returned HTTP 502"
    assert "gateway-secret" not in message
    assert "another-secret" not in message
    assert "upstream" not in message


def test_response_size_is_bounded() -> None:
    response = FakeResponse(200, {"data": "x" * (2 * 1024 * 1024)})
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError, match="2 MiB"):
        client.health()
    assert response.closed is True


def test_context_manager_closes_session() -> None:
    session = FakeSession(FakeResponse(200, {"status": "ok"}))
    with EverOSClient(
        "http://127.0.0.1:8000",
        session=session,  # type: ignore[arg-type]
    ):
        pass
    assert session.closed is True


def test_health_rejects_a_generic_catch_all_response() -> None:
    session = FakeSession(FakeResponse(200, {"status": "ok"}))
    client = EverOSClient(
        "https://memory.example.com",
        session=session,  # type: ignore[arg-type]
    )
    with pytest.raises(EverOSError, match="valid EverOS health"):
        client.health()


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://[::1]:8000",
        "http://10.0.0.8:8000",
        "http://everos:8000",
        "http://host.docker.internal:8000",
    ],
)
def test_allows_http_only_for_local_or_private_deployments(url: str) -> None:
    assert EverOSClient(url).base_url == url


def test_rejects_gateway_token_over_plain_http() -> None:
    with pytest.raises(EverOSError, match="requires an HTTPS"):
        EverOSClient("http://127.0.0.1:8000", "gateway-secret")


@pytest.mark.parametrize(
    "token",
    [
        "gateway\nsecret",
        "gateway\x7fsecret",
        "gateway secret",
        "凭证",
        "x" * 4097,
        123,
    ],
)
def test_rejects_malformed_gateway_tokens_without_echoing_them(token: object) -> None:
    with pytest.raises(EverOSError) as caught:
        EverOSClient("https://memory.example.com", token)  # type: ignore[arg-type]

    assert str(caught.value) == "Gateway token must be a valid ASCII credential"
    assert caught.value.__cause__ is None
