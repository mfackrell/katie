import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("integration: API starts with local mock persistence and serves core application endpoints", async t => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const authToken = "integration-owner-access";
  const authenticatedHeaders = { cookie: "katie_session_access=" + authToken };
  const tablesRead = [];
  let verifiedSessions = 0;
  const persistence = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const table = path.replace("/rest/v1/", "");
    response.setHeader("content-type", "application/json");
    if (path === "/auth/v1/user") {
      if (request.method !== "GET" || request.headers.authorization !== "Bearer " + authToken) {
        response.writeHead(401).end(JSON.stringify({ message: "Invalid session" }));
        return;
      }
      verifiedSessions += 1;
      response.end(JSON.stringify({ id: ownerId, is_anonymous: false }));
      return;
    }
    if (path === "/rest/v1/rpc/standalone_guest_actor_ids" && request.method === "POST") {
      tablesRead.push("standalone_guest_actor_ids");
      response.end("[]");
      return;
    }
    if (request.method !== "GET" || !["actors", "chats", "managed_agents"].includes(table)) {
      response.writeHead(404).end(JSON.stringify({ message: "Unexpected mock persistence request" }));
      return;
    }
    tablesRead.push(table);
    response.end("[]");
  });
  const persistencePort = await listen(persistence);
  t.after(() => new Promise((resolve, reject) => persistence.close(error => error ? reject(error) : resolve())));

  const reservation = createPortReservation();
  const apiPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(apiPort)], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "development",
      VERCEL_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${persistencePort}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "integration-anon-placeholder",
      SUPABASE_SERVICE_ROLE_KEY: "integration-service-placeholder",
      KATIE_OWNER_AUTH_USER_ID: ownerId,
      OPENAI_API_KEY: "", GOOGLE_API_KEY: "", GROK_API_KEY: "", XAI_API_KEY: "", grok_api_key: "",
      CLAUDE_API_KEY: "", claude_api_key: "",
    },
  });
  let output = "";
  server.stdout.on("data", chunk => { output += chunk.toString(); });
  server.stderr.on("data", chunk => { output += chunk.toString(); });
  const exited = once(server, "exit");
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const kill = signal => process.platform === "win32" ? server.kill(signal) : process.kill(-server.pid, signal);
    kill("SIGTERM");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => {
          kill("SIGKILL");
          reject(new Error("Integration server did not shut down completely"));
        }, 10_000); }),
      ]);
    } finally { clearTimeout(timer); }
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    assert.equal(server.exitCode, null, `API exited during startup:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/models`, { headers: authenticatedHeaders, signal: AbortSignal.timeout(5000) });
      if (response.status === 200) { ready = true; break; }
    } catch { /* The development server is still compiling its first route. */ }
    await sleep(1000);
  }
  assert.ok(ready, `API did not become ready:\n${output}`);

  const unsigned = await fetch(baseUrl + "/api/models", { signal: AbortSignal.timeout(30_000) });
  assert.equal(unsigned.status, 401, "missing session must be rejected");
  const forged = await fetch(baseUrl + "/api/models", {
    headers: { cookie: "katie_session_access=invalid-owner-session" },
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(forged.status, 401, "invalid cookie must not grant owner access");

  for (const [path, expected] of [["models", {}], ["actors", { actors: [] }], ["chats", { chats: [] }]]) {
    const response = await fetch(`${baseUrl}/api/${path}`, { headers: authenticatedHeaders, signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `${path} endpoint failed:\n${output}`);
    assert.deepEqual(await response.json(), expected);
  }
  assert.ok(verifiedSessions >= 4, "middleware and owner endpoints must verify Supabase Auth");
  assert.ok(tablesRead.includes("actors"), "actor response must traverse the persistence adapter");
  assert.ok(tablesRead.includes("managed_agents"), "actor identities must include managed agent metadata");
  assert.ok(tablesRead.includes("standalone_guest_actor_ids"), "owner listing must filter guest identities");
  assert.ok(tablesRead.includes("chats"), "chat response must traverse the persistence adapter");
});
