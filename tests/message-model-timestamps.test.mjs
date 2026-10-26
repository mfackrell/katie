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

test("current message includes a freshly computed server timestamp", () => {
  assert.match(route, /user: `\[Current message timestamp: \$\{new Date\(\)\.toISOString\(\)\}\]/);
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
