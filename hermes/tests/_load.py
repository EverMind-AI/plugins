"""Load the plugin package outside a Hermes runtime.

Installs a stub ``agent.memory_provider`` (the ABC lives inside Hermes) and
imports the plugin directory as a package so its relative imports resolve.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PKG = "everos_plugin"


def load_plugin():
    if "agent.memory_provider" not in sys.modules:
        agent_pkg = types.ModuleType("agent")
        mp = types.ModuleType("agent.memory_provider")

        class MemoryProvider:  # minimal stand-in for the Hermes ABC
            pass

        mp.MemoryProvider = MemoryProvider
        agent_pkg.memory_provider = mp
        sys.modules["agent"] = agent_pkg
        sys.modules["agent.memory_provider"] = mp

    if PKG in sys.modules:
        return sys.modules[PKG]
    spec = importlib.util.spec_from_file_location(
        PKG,
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    return mod
