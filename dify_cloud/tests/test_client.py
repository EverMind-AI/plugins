from __future__ import annotations

import json
import socket
from typing import Any

import pytest
import requests

import utils.client as client_module
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


@pytest.fixture(autouse=True)
def public_dns(monkeypatch) -> None:
    monkeypatch.setattr(
        client_module.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ],
    )


@pytest.mark.parametrize(
    "url",
    [
        "",
        "memory.example.com",
        "ftp://memory.example.com",
        "http://memory.example.com",
        "https://user:secret@memory.example.com",
        "https://memory.example.com?debug=1",
        "https://memory.example.com/#fragment",
        "https://memory.example.com/\nheader",
        "https://memory.example.com/\x7fheader",
        "https://memory.example.com:99999",
        "https://localhost:8000",
        "https://everos",
        "https://service.local",
        "https://127.0.0.1:8000",
        "https://10.0.0.8",
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
def test_rejects_unsafe_cloud_urls(url: str) -> None:
    with pytest.raises(EverOSError):
        EverOSClient(url, "cloud-secret")


@pytest.mark.parametrize("key", [None, "", "   "])
def test_requires_cloud_api_key(key: object) -> None:
    with pytest.raises(EverOSError, match="API Key is required"):
        EverOSClient("https://memory.example.com", key)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "key",
    [
        "cloud\nsecret",
        "cloud\x7fsecret",
        "cloud secret",
        "凭证",
        "x" * 4097,
        123,
    ],
)
def test_rejects_malformed_api_keys_without_echoing_them(key: object) -> None:
    with pytest.raises(EverOSError) as caught:
        EverOSClient("https://memory.example.com", key)  # type: ignore[arg-type]

    assert str(caught.value) == (
        "EverOS Cloud API Key must be a valid ASCII credential"
    )
    assert caught.value.__cause__ is None


def test_health_preserves_prefix_sends_key_and_disables_redirects() -> None:
    response = FakeResponse(
        200,
        {
            "message": "ok",
            "service": "evermemos-gateway",
        },
    )
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com/everos/",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    assert client.health()["message"] == "ok"
    call = session.calls[0]
    assert call["url"] == "https://memory.example.com/everos/health"
    assert call["headers"]["Authorization"] == "Bearer cloud-secret"
    assert call["allow_redirects"] is False
    assert call["timeout"] == (5, 10)
    assert response.closed is True


def test_rejects_hostname_that_resolves_to_private_address(monkeypatch) -> None:
    monkeypatch.setattr(
        client_module.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443))
        ],
    )
    session = FakeSession(FakeResponse(200, {}))
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError, match="private address"):
        client.health()
    assert session.calls == []


def test_rejects_unresolvable_hostname(monkeypatch) -> None:
    def fail(*_args, **_kwargs):
        raise socket.gaierror("private diagnostic")

    monkeypatch.setattr(client_module.socket, "getaddrinfo", fail)
    session = FakeSession(FakeResponse(200, {}))
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    assert str(caught.value) == "Could not resolve the EverOS Cloud API hostname"
    assert "private diagnostic" not in str(caught.value)
    assert session.calls == []


def test_redirect_is_rejected_without_leaking_key() -> None:
    response = FakeResponse(307, {"message": "moved"})
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError, match="redirect") as caught:
        client.health()
    assert "cloud-secret" not in str(caught.value)


def test_transport_error_is_sanitized() -> None:
    session = FakeSession(error=requests.ConnectionError("secret diagnostic"))
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    assert str(caught.value) == "Could not connect to the configured EverOS endpoint"
    assert "secret" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__ is True


def test_http_error_does_not_echo_credentials_or_upstream_details() -> None:
    response = FakeResponse(
        502,
        {"message": "upstream rejected Bearer cloud-secret; api_key=other-secret"},
    )
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError) as caught:
        client.health()
    assert str(caught.value) == "EverOS returned HTTP 502"
    assert "secret" not in str(caught.value)
    assert "upstream" not in str(caught.value)


def test_response_size_is_bounded() -> None:
    response = FakeResponse(200, {"data": "x" * (2 * 1024 * 1024)})
    session = FakeSession(response)
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )

    with pytest.raises(EverOSError, match="2 MiB"):
        client.health()
    assert response.closed is True


def test_context_manager_closes_session() -> None:
    session = FakeSession(
        FakeResponse(200, {"message": "ok", "service": "evermemos-gateway"})
    )
    with EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    ):
        pass
    assert session.closed is True


def test_health_rejects_generic_catch_all_response() -> None:
    session = FakeSession(FakeResponse(200, {"message": "ok"}))
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )
    with pytest.raises(EverOSError, match="valid EverOS Cloud health"):
        client.health()


def test_health_rejects_an_unexpected_service() -> None:
    session = FakeSession(
        FakeResponse(200, {"message": "ok", "service": "unrelated-service"})
    )
    client = EverOSClient(
        "https://memory.example.com",
        "cloud-secret",
        session=session,  # type: ignore[arg-type]
    )
    with pytest.raises(EverOSError, match="valid EverOS Cloud health"):
        client.health()
