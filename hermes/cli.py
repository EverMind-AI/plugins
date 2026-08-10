"""Optional CLI: ``hermes everos [status]`` — is the provider configured and
is EverOS reachable? Read-only; safe to run any time.

Wired from ``register(ctx)`` via ``ctx.register_cli_command`` (the
PluginContext API); ``setup_cli`` receives our subparser, ``run_status`` is
the default handler.
"""
from __future__ import annotations

import os
from typing import Any

from . import load_config
from .client import EverosClient


def run_status(args: Any = None) -> None:
    hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    cfg = load_config(hermes_home)
    print(f"base_url:  {cfg.base_url}")
    print(f"user_id:   {cfg.user_id or '(unset)'}")
    print(f"agent_id:  {cfg.agent_id}")
    try:
        EverosClient(cfg.base_url).health(timeout_s=3.0)
        print("everos:    healthy")
    except Exception as err:
        print(f"everos:    unreachable ({err})")


def setup_cli(parser: Any) -> None:
    """Add arguments/sub-subcommands to the ``hermes everos`` subparser."""
    sub = parser.add_subparsers(dest="everos_cmd")
    status = sub.add_parser("status", help="show config and EverOS health")
    status.set_defaults(func=run_status)
