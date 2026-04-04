import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const API_PORT = process.env.INTEGRATION_API_PORT ?? "3100";
const baseUrl = `http://127.0.0.1:${API_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApiReady(timeoutMs = 60000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/models`);
      if (response.status < 500) {
        return;
      }
    } catch {
      // keep polling until startup completes
    }

    await sleep(1000);
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

test("integration: API boots with Postgres + Redis env and serves core MCP endpoints", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must be set for integration test");
  assert.ok(process.env.REDIS_URL, "REDIS_URL must be set for integration test");
  assert.equal(process.env.GITHUB_API_BASE_URL, "http://127.0.0.1:9090", "GitHub API must be mocked in CI");

  const env = {
    ...process.env,
    PORT: API_PORT,
    NODE_ENV: "test",
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "integration-service-role-key",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "integration-anon-key"
  };

  const server = spawn("npm", ["run", "dev", "--", "-p", API_PORT], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  t.after(() => {
    if (!server.killed) {
      server.kill("SIGTERM");
    }
  });

  await waitForApiReady();

  const modelsRes = await fetch(`${baseUrl}/api/models`);
  assert.ok(modelsRes.status < 500, `models endpoint should not 5xx, got ${modelsRes.status}`);

  const actorsRes = await fetch(`${baseUrl}/api/actors`);
  assert.ok(actorsRes.status < 500, `actors endpoint should not 5xx, got ${actorsRes.status}`);

  const chatsRes = await fetch(`${baseUrl}/api/chats`);
  assert.ok(chatsRes.status < 500, `chats endpoint should not 5xx, got ${chatsRes.status}`);

  if (modelsRes.status >= 500 || actorsRes.status >= 500 || chatsRes.status >= 500) {
    throw new Error(`Server output:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
});
