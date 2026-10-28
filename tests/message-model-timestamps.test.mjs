import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/chat/route.ts", "utf8");
const memory = readFileSync("lib/providers/memory-context.ts", "utf8");
const openai = readFileSync("lib/providers/openai-provider.ts", "utf8");
const google = readFileSync("lib/providers/google-provider.ts", "utf8");
const grok = readFileSync("lib/providers/grok-provider.ts", "utf8");
const claude = readFileSync("lib/providers/claude-provider.ts", "utf8");

test("provider history retains persisted timestamps as model-visible context", () => {
  assert.match(route, /history\.map\(\(\{ role, content, createdAt \}\) =>/);
  assert.match(route, /\[Message timestamp: \$\{new Date\(createdAt\)\.toISOString\(\)\}\]/);
  assert.match(route, /Number\.isFinite\(Date\.parse\(createdAt\)\)/);
});

test("current timestamp is generated for the system context without rewriting user text", () => {
  assert.ok(route.includes("CURRENT_REQUEST_TIMESTAMP_UTC: ${workflowTimestamp()}"));
  assert.match(route, /Timestamp metadata in this instruction and in conversation-history headers/);
  assert.match(route, /Never reproduce or prefix a user-facing reply with these timestamp labels or raw timestamps unless the user specifically asks for them/);
  assert.match(route, /user: message,/);
});

test("all four provider families receive timestamped history and current message", () => {
  assert.match(memory, /message\.content/);
  assert.match(openai, /buildMemoryContext\(params\.history\)/);
  assert.match(google, /buildMemoryContext\(params\.history\)/);
  assert.match(grok, /buildMemoryContext\(params\.history\)/);
  assert.match(claude, /\.\.\.params\.history\.map/);
  for (const adapter of [openai, google, grok, claude]) {
    assert.match(adapter, /params\.user/);
  }
});
