"""Small, defensive HTTP client for the EverOS public API."""

from __future__ import annotations

import ipaddress
import json
import re
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
        raise EverOSError("EverOS Base URL is required")

    raw = value.strip()
    if any(ord(char) < 32 for char in raw):
        raise EverOSError("EverOS Base URL must not contain control characters")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"}:
        raise EverOSError("EverOS Base URL must use http or https")
    if not parsed.hostname:
        raise EverOSError("EverOS Base URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise EverOSError("EverOS Base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise EverOSError("EverOS Base URL must not contain a query or fragment")
    address = _parse_ip_literal(parsed.hostname)
    if address is not None and _is_unsafe_address(address):
        raise EverOSError("EverOS Base URL must not target an unsafe IP address")
    if parsed.scheme == "http" and not _is_local_http_host(parsed.hostname):
        raise EverOSError("Public EverOS endpoints must use HTTPS")

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


def _is_unsafe_address(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> bool:
    if address.is_loopback:
        return False
    return (
        address.is_link_local
        or address.is_unspecified
        or address.is_multicast
        or address.is_reserved
    )


def _is_local_http_host(hostname: str) -> bool:
    host = hostname.rstrip(".").lower()
    address = _parse_ip_literal(host)
    if address is not None:
        if address.is_loopback:
            return True
        if _is_unsafe_address(address):
            return False
        return address.is_private
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or host in {"host.docker.internal", "gateway.docker.internal"}
    ):
        return True
    # Docker/service-discovery names are commonly a single DNS label. Require
    # an alphabetic first character so legacy numeric IPv4 spellings (decimal,
    # hex, or octal) cannot bypass the IP checks above.
    if "." not in host and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", host):
        return not host.endswith("-")
    return False


def _normalize_gateway_token(value: object) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str):
        raise EverOSError("Gateway token must be a valid ASCII credential")
    token = value.strip()
    if not token:
        return ""
    if len(token) > 4096 or any(not 0x21 <= ord(char) <= 0x7E for char in token):
        raise EverOSError("Gateway token must be a valid ASCII credential")
    return token


class EverOSClient:
    """Call one operator-configured EverOS endpoint.

    Redirects are deliberately disabled so an authorization header cannot be
    forwarded to a different origin. Responses are bounded before decoding.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        session: requests.Session | None = None,
    ) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.api_key = _normalize_gateway_token(api_key)
        if self.api_key and urlsplit(self.base_url).scheme != "https":
            raise EverOSError("Gateway token requires an HTTPS EverOS Base URL")
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
            api_key=credentials.get("api_key") or None,
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
        capabilities = payload.get("capabilities")
        if (
            payload.get("status") != "ok"
            or not isinstance(payload.get("version"), str)
            or not payload["version"]
            or not isinstance(capabilities, Mapping)
            or not isinstance(capabilities.get("llm"), bool)
        ):
            raise EverOSError("Endpoint did not return a valid EverOS health response")
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
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

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
