from __future__ import annotations

import importlib
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_manifest_requests_no_reverse_invocation_permissions() -> None:
    manifest = yaml.safe_load((ROOT / "manifest.yaml").read_text())
    permissions = manifest["resource"]["permission"]

    assert permissions["model"]["enabled"] is False
    assert permissions["tool"]["enabled"] is False
    assert permissions["node"]["enabled"] is False
    assert permissions["endpoint"]["enabled"] is False
    assert permissions["app"]["enabled"] is False
    assert permissions["storage"]["enabled"] is False
    assert manifest["created_at"].isoformat() == "2026-08-25T00:00:00+00:00"
    assert manifest["meta"]["minimum_dify_version"] == "1.14.2"
    assert manifest["name"] == "everos_cloud"
    assert manifest["author"] == "evermind-ai"


def test_manifest_references_existing_sources() -> None:
    manifest = yaml.safe_load((ROOT / "manifest.yaml").read_text())
    provider_path = ROOT / manifest["plugins"]["tools"][0]
    provider = yaml.safe_load(provider_path.read_text())

    assert provider_path.is_file()
    assert (ROOT / provider["extra"]["python"]["source"]).is_file()
    for tool_path in provider["tools"]:
        tool_file = ROOT / tool_path
        tool = yaml.safe_load(tool_file.read_text())
        assert tool_file.is_file()
        assert (ROOT / tool["extra"]["python"]["source"]).is_file()


def test_llm_cannot_choose_memory_owner_or_session() -> None:
    search = yaml.safe_load((ROOT / "tools/search_memory.yaml").read_text())
    add = yaml.safe_load((ROOT / "tools/add_memory.yaml").read_text())

    search_names = {parameter["name"] for parameter in search["parameters"]}
    add_names = {parameter["name"] for parameter in add["parameters"]}
    assert "user_id" not in search_names
    assert "user_id" not in add_names
    assert "conversation_id" not in add_names


def test_cloud_credentials_are_explicit_and_minimal() -> None:
    manifest = yaml.safe_load((ROOT / "manifest.yaml").read_text())
    provider_path = ROOT / manifest["plugins"]["tools"][0]
    provider = yaml.safe_load(provider_path.read_text())
    credentials = provider["credentials_for_provider"]

    assert set(credentials) == {"base_url", "api_key"}
    assert credentials["base_url"]["required"] is True
    assert credentials["base_url"]["default"] == "https://api.evermind.ai"
    assert credentials["api_key"]["required"] is True
    assert credentials["api_key"]["type"] == "secret-input"
    assert "project_id" not in credentials


def test_secret_files_are_excluded_from_git_and_dify_packages() -> None:
    for name in (".gitignore", ".difyignore"):
        rules = (ROOT / name).read_text().splitlines()
        assert ".env*" in rules
        assert "!.env.example" in rules
        assert "*.difypkg" in rules


def test_runtime_dependencies_use_uv_lock_as_single_source_of_truth() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text()
    lock = (ROOT / "uv.lock").read_text()
    assert not (ROOT / "requirements.txt").exists()
    assert '"dify_plugin>=0.9.0,<0.10.0"' in pyproject
    assert '"requests>=2.32.4,<3.0.0"' in pyproject
    assert 'name = "dify-plugin"\nversion = "0.9.1"' in lock
    assert 'name = "requests"\nversion = "2.34.2"' in lock


def test_dify_entry_modules_import() -> None:
    importlib.import_module("provider.everos_cloud")
    importlib.import_module("tools.add_memory")
    importlib.import_module("tools.search_memory")
