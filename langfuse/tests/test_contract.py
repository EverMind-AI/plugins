"""Offline contract checks for the migrated Langfuse integration."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FixtureContractTests(unittest.TestCase):
    def test_recording_is_the_complete_published_fixture(self) -> None:
        fixture = json.loads((ROOT / "recorded_trace.json").read_text(encoding="utf-8"))
        spans = fixture["spans"]

        self.assertEqual(fixture["everos_version"], "1.2.1")
        self.assertEqual(len(spans), 237)
        self.assertEqual(len({span["trace_id"] for span in spans}), 60)
        self.assertEqual(len(fixture["scores"]), 47)
        self.assertTrue(
            all(
                {"trace_id", "span_id", "parent_span_id", "name", "attributes"}
                <= span.keys()
                for span in spans
            )
        )

    def test_replay_defaults_to_the_fixture_next_to_the_script(self) -> None:
        replay = _load_module("everos_langfuse_replay", ROOT / "replay.py")

        self.assertEqual(replay.DEFAULT_FIXTURE, ROOT / "recorded_trace.json")
        self.assertTrue(replay.DEFAULT_FIXTURE.is_file())


@unittest.skipIf(os.name == "nt", "the recorder shutdown check uses POSIX SIGINT")
class ReplayRoundTripTests(unittest.TestCase):
    def test_recording_replays_into_the_local_sink(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "round-trip.json"
            recorder = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "record_trace.py"),
                    "--port",
                    str(port),
                    "--out",
                    str(output),
                    "--everos-version",
                    "round-trip-test",
                ],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if recorder.poll() is not None:
                        stderr = recorder.stderr.read() if recorder.stderr else ""
                        self.fail(f"recorder exited before readiness: {stderr}")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    self.fail("recorder did not become ready")

                environment = {
                    **os.environ,
                    "LANGFUSE_PUBLIC_KEY": "pk-local-test",
                    "LANGFUSE_SECRET_KEY": "sk-local-test",
                    "LANGFUSE_HOST": f"http://127.0.0.1:{port}",
                }
                replayed = subprocess.run(
                    [sys.executable, str(ROOT / "replay.py")],
                    cwd=ROOT,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(replayed.returncode, 0, replayed.stderr)
                self.assertIn("Replayed 237 span(s)", replayed.stdout)
                self.assertIn("Pushed 47 recall score(s)", replayed.stdout)

                recorder.send_signal(signal.SIGINT)
                recorder.wait(timeout=10)
                round_trip = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual(round_trip["everos_version"], "round-trip-test")
                self.assertEqual(len(round_trip["spans"]), 237)
                self.assertEqual(len(round_trip["scores"]), 47)
            finally:
                if recorder.poll() is None:
                    recorder.terminate()
                    recorder.wait(timeout=10)
                if recorder.stderr is not None:
                    recorder.stderr.close()


if __name__ == "__main__":
    unittest.main()
