import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/chat/route.ts", "utf8");

test("owner boundary checks trusted workflow before provider routing", () => {
  assert.match(route, /const ownerSexualBoundaryEnabled = Boolean\(/);
  assert.match(route, /verifiedWorkflow\?\.workflow\.owner_id === process\.env\.KATIE_OWNER_AUTH_USER_ID/);
  assert.match(route, /const sexualBoundaryRefusal = ownerSexualBoundaryEnabled/);
  assert.match(route, /isOwnerEroticRequest\(message, history\)/);
  const gate = route.indexOf("const sexualBoundaryRefusal = ownerSexualBoundaryEnabled");
  const providers = route.indexOf("const configuredProviders = getAvailableProviders()");
  assert.ok(gate >= 0 && providers > gate, "direct erotic requests stop before provider dispatch");
  assert.match(route, /sexualBoundaryRefusal\s*\?\s*\{\s*reason:\s*"boundary" as const/);
});

test("common provider params propagate the owner policy to all candidate routes", () => {
  assert.match(route, /prepareCandidateRequest = /);
  assert.match(route, /ownerSexualBoundaryEnabled \? \[OWNER_SEXUAL_BOUNDARY_INSTRUCTIONS\] : \[\]/);
  assert.match(route, /ownerSexualBoundaryEnabled\) return;/);
});

test("post-generation output screen precedes persistence", () => {
  assert.match(route, /looksLikeEroticAssistantOutput\(rawAssistantText\)/);
  assert.match(route, /const boundedAssistantText =/);
  assert.match(route, /const presentationResult = presentationEnabled[\s\S]{0,160}boundedAssistantText/);
  assert.match(route, /if \(boundedAssistantText !== rawAssistantText\) imageAssets = \[\];/);
});
