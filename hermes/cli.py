"""Optional CLI: ``hermes everos status`` — is the provider configured and is
EverOS reachable? Read-only; safe to run any time."""
from __future__ import annotations

import os
from typing import Any

from . import load_config
from .client import EverosClient


def _status(args: Any) -> None:
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


def register_cli(subparser: Any) -> None:
    p = subparser.add_parser("everos", help="EverOS memory provider utilities")
    sub = p.add_subparsers(dest="everos_cmd")
    s = sub.add_parser("status", help="show config and EverOS health")
    s.set_defaults(func=_status)
