import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync("app/api/chat/route.ts", "utf8");

test("normal standalone conversation never triggers local historical-project arbitration by length", () => {
  assert.match(source, /const explicitProjectOperation = startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)/);
  assert.match(source, /if \(!isProjectStopRequest && explicitProjectOperation && !currentAgentTask\(\)/);
  assert.match(source, /const projectReply = !pdfProgress\.projectClarification && !executiveReply && explicitProjectOperation/);
  assert.match(source, /const localKatieResponse = explicitProjectOperation && pdfProgress\.projectClarification/);
  assert.match(source, /if \(!explicitProjectOperation && !currentAgentTask\(\)\) pdfProgress\.projectClarification = undefined/);
  assert.doesNotMatch(source, /standaloneFragment/);
});

test("project-management operations remain explicitly authorized", () => {
  assert.match(source, /explicitProjectOperation = startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)/);
});
