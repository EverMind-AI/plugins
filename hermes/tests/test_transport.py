"""Client transport (real HTTP round-trips), provision unit paths, CLI wiring."""
from __future__ import annotations

import argparse
import http.server
import json
import threading
import unittest

from _load import load_plugin

mod = load_plugin()
client_mod = __import__(f"{mod.__name__}.client", fromlist=["*"])
provision_mod = __import__(f"{mod.__name__}.provision", fromlist=["*"])
cli_mod = __import__(f"{mod.__name__}.cli", fromlist=["*"])


class Handler(http.server.BaseHTTPRequestHandler):
    routes: dict[str, tuple[int, str]] = {}

    def log_message(self, *args):  # keep test output quiet
        pass

    def _serve(self):
        not_found = json.dumps(
            {"request_id": "x", "error": {"code": "HTTP_ERROR", "message": "nf"}}
        )
        status, body = self.routes.get(self.path, (404, not_found))
        payload = body.encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _serve  # noqa: N815 — stdlib handler method names
    do_POST = _serve  # noqa: N815


class TestClientTransport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def client(self):
        return client_mod.EverosClient(self.base, timeout_s=3.0)

    def test_success_envelope_returns_data(self):
        ok = json.dumps({"request_id": "r", "data": {"status": "extracted"}})
        Handler.routes = {"/api/v1/memory/flush": (200, ok)}
        self.assertEqual(self.client().flush({"session_id": "s"})["status"], "extracted")

    def test_error_envelope_raises_with_code_and_status(self):
        err = json.dumps(
            {
                "request_id": "r",
                "error": {"code": "INTERNAL_ERROR", "message": "boom", "path": "/p"},
            }
        )
        Handler.routes = {"/api/v1/memory/flush": (500, err)}
        with self.assertRaises(client_mod.EverosError) as cm:
            self.client().flush({"session_id": "s"})
        self.assertEqual(cm.exception.status, 500)
        self.assertEqual(cm.exception.code, "INTERNAL_ERROR")

    def test_non_json_response_raises_bad_response(self):
        Handler.routes = {"/api/v1/memory/flush": (200, "<html>nope</html>")}
        with self.assertRaises(client_mod.EverosError) as cm:
            self.client().flush({"session_id": "s"})
        self.assertEqual(cm.exception.code, "BAD_RESPONSE")

    def test_health_bare_envelope(self):
        Handler.routes = {"/health": (200, json.dumps({"status": "ok"}))}
        self.assertEqual(self.client().health(), {"status": "ok"})

    def test_network_error_wrapped(self):
        dead = client_mod.EverosClient("http://127.0.0.1:9", timeout_s=0.5)
        with self.assertRaises(client_mod.EverosError) as cm:
            dead.health()
        self.assertEqual(cm.exception.status, 0)
        self.assertEqual(cm.exception.code, "NETWORK_ERROR")


class FakeHealthClient:
    """Healthy after N failed polls (0 = immediately healthy)."""

    def __init__(self, healthy_after: int = 0):
        self.base_url = "http://fake"
        self.n = 0
        self.healthy_after = healthy_after

    def health(self, timeout_s=None):
        self.n += 1
        if self.n > self.healthy_after:
            return {"status": "ok"}
        raise RuntimeError("down")


class TestProvision(unittest.TestCase):
    def test_port_from_url(self):
        self.assertEqual(provision_mod.port_from_url("http://127.0.0.1:8000"), "8000")
        self.assertEqual(provision_mod.port_from_url("https://x.example"), "443")
        self.assertEqual(provision_mod.port_from_url("http://x.example"), "80")

    def test_wait_for_healthy_polls_until_ok(self):
        c = FakeHealthClient(healthy_after=2)
        self.assertTrue(provision_mod.wait_for_healthy(c, timeout_s=5, interval_s=0.01))
        self.assertGreaterEqual(c.n, 3)

    def test_wait_for_healthy_abort_stops_early(self):
        c = FakeHealthClient(healthy_after=10**6)
        self.assertFalse(
            provision_mod.wait_for_healthy(c, 5, 0.01, should_abort=lambda: True)
        )
        self.assertEqual(c.n, 0)

    def test_provision_already_running(self):
        res = provision_mod.provision(FakeHealthClient(), None, None)
        self.assertEqual(res.status, "already-running")
        self.assertIsNone(res.child)

    def test_provision_missing_command_fails_open_with_guidance(self):
        res = provision_mod.provision(
            FakeHealthClient(healthy_after=10**6),
            ["definitely-not-a-command-xyz"],
            None,
            readiness_timeout_s=0.2,
            readiness_interval_s=0.05,
        )
        self.assertEqual(res.status, "failed")
        self.assertIn("everos init", res.detail)


class TestCliWiring(unittest.TestCase):
    def test_setup_cli_wires_status(self):
        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers()
        everos = sub.add_parser("everos")
        cli_mod.setup_cli(everos)
        args = parser.parse_args(["everos", "status"])
        self.assertIs(args.func, cli_mod.run_status)


if __name__ == "__main__":
    unittest.main()
