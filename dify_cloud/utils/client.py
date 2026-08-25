"""Small, defensive HTTP client for the EverOS public API."""

from __future__ import annotations

import ipaddress
import json
import socket
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_CONNECT_TIMEOUT_SECONDS = 5


class EverOSError(RuntimeError):
    """A safe-to-display EverOS transport or protocol error."""


def _normalize_base_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EverOSError("EverOS Cloud API URL is required")

    raw = value.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in raw):
        raise EverOSError("EverOS Cloud API URL must not contain control characters")
    parsed = urlsplit(raw)
    if parsed.scheme != "https":
        raise EverOSError("EverOS Cloud API URL must use HTTPS")
    if not parsed.hostname:
        raise EverOSError("EverOS Cloud API URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise EverOSError("EverOS Cloud API URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise EverOSError("EverOS Cloud API URL must not contain a query or fragment")
    try:
        _ = parsed.port
    except ValueError:
        raise EverOSError("EverOS Cloud API URL contains an invalid port") from None

    host = parsed.hostname.rstrip(".").lower()
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or "." not in host
    ):
        raise EverOSError("EverOS Cloud API URL must use a public hostname")
    address = _parse_ip_literal(parsed.hostname)
    if address is not None and not address.is_global:
        raise EverOSError("EverOS Cloud API URL must not target a private address")

    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _parse_ip_literal(
    hostname: str,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    host = hostname.rstrip(".").lower()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # inet_aton recognizes legacy IPv4 spellings such as a single decimal
        # integer, hex, and octal. It performs no DNS lookup.
        try:
            address = ipaddress.ip_address(socket.inet_aton(host))
        except OSError:
            return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def _validate_public_resolution(hostname: str, port: int) -> None:
    """Reject DNS answers that route a cloud credential to a non-public host."""
    try:
        answers = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise EverOSError("Could not resolve the EverOS Cloud API hostname") from None
    if not answers:
        raise EverOSError("Could not resolve the EverOS Cloud API hostname")
    for answer in answers:
        address = ipaddress.ip_address(answer[4][0])
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global:
            raise EverOSError(
                "EverOS Cloud API hostname resolved to a private address"
            )


def _normalize_api_key(value: object) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise EverOSError("EverOS Cloud API Key is required")
    if not isinstance(value, str):
        raise EverOSError("EverOS Cloud API Key must be a valid ASCII credential")
    token = value.strip()
    if len(token) > 4096 or any(not 0x21 <= ord(char) <= 0x7E for char in token):
        raise EverOSError("EverOS Cloud API Key must be a valid ASCII credential")
    return token


class EverOSClient:
    """Call one operator-configured EverOS endpoint.

    Redirects are deliberately disabled so an authorization header cannot be
    forwarded to a different origin. Responses are bounded before decoding.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        session: requests.Session | None = None,
    ) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.api_key = _normalize_api_key(api_key)
        self._session = session or requests.Session()

    @classmethod
    def from_credentials(
        cls,
        credentials: Mapping[str, object],
        *,
        session: requests.Session | None = None,
    ) -> EverOSClient:
        return cls(
            base_url=credentials.get("base_url", ""),
            api_key=credentials.get("api_key", ""),
            session=session,
        )

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> EverOSClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def health(self) -> dict[str, Any]:
        payload = self._request("GET", "/health", read_timeout=10)
        if not (
            payload.get("message") == "ok"
            and payload.get("service") == "evermemos-gateway"
        ):
            raise EverOSError(
                "Endpoint did not return a valid EverOS Cloud health response"
            )
        return payload

    def search(self, payload: Mapping[str, object]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/v2/memory/search",
            json_body=payload,
            read_timeout=60,
        )

    def add(self, payload: Mapping[str, object]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/v2/memory/add",
            json_body=payload,
            read_timeout=275,
        )

    def flush(self, payload: Mapping[str, object]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/v2/memory/flush",
            json_body=payload,
            read_timeout=275,
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, object] | None = None,
        read_timeout: int,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        headers["Authorization"] = f"Bearer {self.api_key}"

        parsed = urlsplit(self.base_url)
        _validate_public_resolution(parsed.hostname or "", parsed.port or 443)

        response: requests.Response | None = None
        try:
            response = self._session.request(
                method,
                f"{self.base_url}{path}",
                headers=headers,
                json=dict(json_body) if json_body is not None else None,
                timeout=(_CONNECT_TIMEOUT_SECONDS, read_timeout),
                allow_redirects=False,
                stream=True,
            )
            raw = self._read_bounded(response)
        except requests.Timeout:
            raise EverOSError("EverOS request timed out") from None
        except requests.RequestException:
            raise EverOSError(
                "Could not connect to the configured EverOS endpoint"
            ) from None
        finally:
            if response is not None:
                response.close()

        try:
            decoded = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EverOSError("EverOS returned an invalid JSON response") from exc

        if 300 <= response.status_code < 400:
            raise EverOSError(
                "EverOS endpoint returned a redirect; redirects are not followed"
            )
        if response.status_code >= 400:
            # Response bodies can contain gateway internals, reflected request
            # headers, or memory content. Never echo them into Dify errors.
            raise EverOSError(f"EverOS returned HTTP {response.status_code}")
        if not isinstance(decoded, dict):
            raise EverOSError("EverOS returned an unexpected JSON response")
        return decoded

    @staticmethod
    def _read_bounded(response: requests.Response) -> bytes:
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > _MAX_RESPONSE_BYTES:
                raise EverOSError("EverOS response exceeded the 2 MiB safety limit")
            chunks.append(chunk)
        return b"".join(chunks)
