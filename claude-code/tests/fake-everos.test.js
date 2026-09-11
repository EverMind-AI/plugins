import test from "node:test";
import assert from "node:assert/strict";
import { startFakeEveros } from "./helpers/fake-everos.js";

test("fake EverOS records requests and answers the four routes", async () => {
  const server = await startFakeEveros();
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const search = await fetch(`${server.baseUrl}/api/v2/memory/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "me", query: "hi" }),
    });
    assert.deepEqual((await search.json()).data.episodes, []);

    assert.equal(server.only("/api/v2/memory/search").length, 1);
    assert.equal(server.only("/api/v2/memory/search")[0].body.user_id, "me");
  } finally {
    await server.close();
  }
});

test("fake EverOS 404s an unknown path with the real error envelope", async () => {
  const server = await startFakeEveros();
  try {
    const res = await fetch(`${server.baseUrl}/api/v2/memory/nope`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  } finally {
    await server.close();
  }
});
