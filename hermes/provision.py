"""Detect-then-provision of the EverOS server.

On startup (from the provider's ``initialize``, in a daemon thread):
health-check EverOS; if it's not up, try to start it (spawn the configured
command, forcing ``mode=agent`` + the right port), then poll until healthy.
Everything is **fail-open** — if EverOS can't be reached or started, we log
and carry on; recall/capture just no-op.

Ported from the shipped OpenClaw plugin's provisioner, including the OME
single-instance-lock handling: a freshly-spawned child that dies with a lock
conflict is NOT a failure — another instance is (coming) up, so we keep
polling health and self-heal onto it.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

from .client import EverosClient

logger = logging.getLogger(__name__)

# EverOS's OME engine holds an exclusive lock (ome.db.lock); losing the race
# to a live instance prints one of these.
_LOCK_RE = re.compile(
    r"EngineLockHeldError|OfflineEngine instance already holds|LockException", re.I
)
_MAX_OUTPUT_TAIL = 4000

DEFAULT_START_CMD = ["everos", "server", "start"]


@dataclass
class ProvisionResult:
    status: str  # "already-running" | "started" | "failed"
    detail: str
    child: subprocess.Popen | None = None  # set when WE spawned the server


def port_from_url(base_url: str) -> str:
    """Port for ``EVEROS_API__PORT`` (defaults: 443 https, else 80). Never raises."""
    try:
        u = urlparse(base_url)
        if u.port:
            return str(u.port)
        return "443" if u.scheme == "https" else "80"
    except Exception:
        return "8000"


def wait_for_healthy(
    client: EverosClient,
    timeout_s: float,
    interval_s: float,
    should_abort=None,
) -> bool:
    """Poll ``/health`` until healthy or the budget runs out; abort early when
    ``should_abort()`` says the spawned child is dead (unless it lost the lock
    race — the caller encodes that in ``should_abort``)."""
    deadline = time.monotonic() + timeout_s
    while True:
        if should_abort is not None and should_abort():
            return False
        try:
            client.health(timeout_s=min(2.0, max(0.5, interval_s * 2)))
            return True
        except Exception:
            if should_abort is not None and should_abort():
                return False
            if time.monotonic() >= deadline:
                return False
            time.sleep(interval_s)


def provision(
    client: EverosClient,
    start_cmd: list[str] | None,
    everos_dir: str | None,
    readiness_timeout_s: float = 60.0,
    readiness_interval_s: float = 1.0,
) -> ProvisionResult:
    """Detect EverOS and, if absent, attempt to start it. Never raises."""
    # 1. Already running?
    try:
        client.health(timeout_s=2.0)
        logger.info("[everos] already running at %s", client.base_url)
        return ProvisionResult("already-running", "health check passed")
    except Exception:
        logger.info("[everos] not reachable at %s; attempting to start", client.base_url)

    # 2. Start it (forcing agent mode + the configured port).
    cmd = start_cmd or DEFAULT_START_CMD
    env = dict(os.environ)
    env["EVEROS_MEMORIZE__MODE"] = "agent"
    env["EVEROS_API__PORT"] = port_from_url(client.base_url)
    try:
        child = subprocess.Popen(
            cmd,
            cwd=everos_dir or None,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            start_new_session=True,  # a Ctrl-C in the host's terminal must not kill it
        )
    except FileNotFoundError:
        detail = (
            f"start command not found: {cmd[0]!r}. Install EverOS, run `everos init` "
            "once, put API keys in ~/.everos/everos.toml, and set everos_dir/start_cmd "
            "via `hermes memory setup` — fail-open"
        )
        logger.warning("[everos] %s", detail)
        return ProvisionResult("failed", detail)
    except Exception as err:
        logger.warning("[everos] failed to spawn (%s): %s — fail-open", " ".join(cmd), err)
        return ProvisionResult("failed", str(err))

    # Drain output on a reader thread: keep a bounded tail for diagnostics and
    # LATCH the lock-conflict signal as chunks arrive (later output can evict it
    # from the tail; the flag must survive).
    tail: list[str] = [""]
    saw_lock = threading.Event()
    drained = threading.Event()

    def _drain() -> None:
        try:
            assert child.stdout is not None
            for line in child.stdout:
                if not saw_lock.is_set() and _LOCK_RE.search(line):
                    saw_lock.set()
                tail[0] = (tail[0] + line)[-_MAX_OUTPUT_TAIL:]
        finally:
            drained.set()

    threading.Thread(target=_drain, daemon=True).start()

    # 3. Wait until it answers /health. Bail early once the child is dead —
    # UNLESS it lost the OME lock race (another instance may still come up).
    healthy = wait_for_healthy(
        client,
        readiness_timeout_s,
        readiness_interval_s,
        # Only treat a dead child as fatal once its output is fully drained —
        # the lock-conflict line can arrive AFTER exit (TOCTOU on saw_lock).
        should_abort=lambda: (
            child.poll() is not None
            and drained.wait(timeout=1.0)
            and not saw_lock.is_set()
        ),
    )

    def last_lines() -> str:
        return " | ".join(x.strip() for x in tail[0].splitlines() if x.strip())[-300:]

    if healthy:
        if child.poll() is not None:
            # Our start lost the lock race but EverOS is up via an instance we
            # don't own — no child handle back (killing it isn't ours to do).
            logger.info("[everos] healthy via another instance (our start hit the OME lock)")
            return ProvisionResult(
                "already-running", "another instance holds the OME lock and is healthy"
            )
        logger.info("[everos] started and healthy at %s", client.base_url)
        return ProvisionResult("started", "spawned + healthy", child=child)

    if child.poll() is not None:
        if saw_lock.is_set():
            detail = (
                "OME lock held by another EverOS instance that never became healthy — "
                "a stray 'everos server' process may be holding ome.db.lock"
            )
        else:
            detail = f"child exited (code={child.returncode}) before healthy: {last_lines()}"
        logger.warning("[everos] %s — fail-open", detail)
        return ProvisionResult("failed", detail)

    # Still alive but not healthy yet — likely a slow cold start. Do NOT kill it:
    # it may warm up shortly; recall/capture fail-open until then. Hand the child
    # back so shutdown can stop it.
    logger.warning(
        "[everos] not healthy within %ss; leaving it running — fail-open",
        readiness_timeout_s,
    )
    return ProvisionResult("failed", "readiness timeout (left running)", child=child)


def stop_child(child: subprocess.Popen | None) -> None:
    """Terminate a server WE spawned (never one we merely found running)."""
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
    except Exception:
        pass
