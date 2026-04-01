import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

function loadRoute() {
  const routePath = require.resolve("../app/api/internal/refresh-model-pricing/route");
  delete require.cache[routePath];
  return require("../app/api/internal/refresh-model-pricing/route") as typeof import("../app/api/internal/refresh-model-pricing/route");
}

function loadRunner() {
  const runnerPath = require.resolve("../lib/router/model-pricing-refresh-runner");
  delete require.cache[runnerPath];
  return require("../lib/router/model-pricing-refresh-runner") as typeof import("../lib/router/model-pricing-refresh-runner");
}

test("refresh-model-pricing endpoint rejects unauthorized requests", async () => {
  process.env.MODEL_PRICING_REFRESH_SECRET = "secret-123";
  const { POST } = loadRoute();

  const response = await POST(new NextRequest("http://localhost/api/internal/refresh-model-pricing", { method: "POST" }));
  assert.equal(response.status, 401);
});

test("refresh-model-pricing endpoint returns compact stats when authorized", async () => {
  process.env.MODEL_PRICING_REFRESH_SECRET = "secret-123";
  const route = loadRoute();
  const runner = loadRunner();
  runner.__setRefreshExecutorForTests(async () => ({
    total_models_seen: 4,
    total_rows_upserted: 4,
    total_rows_marked_inactive: 1,
    provider_errors: []
  }));

  const request = new NextRequest("http://localhost/api/internal/refresh-model-pricing", {
    method: "POST",
    headers: { "x-model-pricing-refresh-secret": "secret-123" }
  });

  const response = await route.POST(request);
  const payload = (await response.json()) as { ok: boolean; total_models_seen: number };

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.total_models_seen, 4);
});
