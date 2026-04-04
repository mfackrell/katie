#!/usr/bin/env node

const baseUrl = process.env.WORKER_API_BASE_URL ?? "http://127.0.0.1:3000";
const refreshSeconds = Number(process.env.MODEL_REGISTRY_REFRESH_INTERVAL_SECONDS ?? 300);
const internalToken = process.env.INTERNAL_API_TOKEN;

if (!internalToken) {
  console.error("INTERNAL_API_TOKEN is required for the worker refresh loop.");
  process.exit(1);
}

const endpoint = new URL("/api/internal/model-registry/refresh", baseUrl).toString();

async function tick() {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": internalToken
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker refresh failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  console.log(`[worker] refresh ok: ${new Date().toISOString()} ${JSON.stringify(payload)}`);
}

async function run() {
  console.log(`[worker] started. target=${endpoint} interval=${refreshSeconds}s`);

  while (true) {
    try {
      await tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] ${message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, refreshSeconds * 1000));
  }
}

run();
