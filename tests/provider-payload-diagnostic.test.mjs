import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/chat/route.ts", "utf8");
const claude = readFileSync("lib/providers/claude-provider.ts", "utf8");

test("owner-only test capture requires an explicit request and grant", () => {
  assert.ok(route.includes("providerPayloadCapture: z.literal(true).optional()"));
  assert.ok(route.includes("await authorizeSelfToolCaller(request, actorId, chatId)"));
  assert.ok(route.includes('overrideProvider !== "anthropic"'));
});

test("wire payload is derived from the exact same body builder as the outgoing Claude call", () => {
  assert.ok(claude.includes("function claudeWireRequestBody("));
  assert.ok(claude.includes("...claudeWireRequestBody(params)"));
  assert.ok(claude.includes("wireRequest: claudeWireRequestBody("));
});
