import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync("app/api/chat/route.ts", "utf8");
test("bare standalone fragments stay on LLM path rather than project arbitration", () => {
  assert.match(source, /const standaloneFragment =/);
  assert.match(source, /!standaloneFragment && \(contextProjects\.length \|\| freshTaskEvidence\.length/);
  assert.match(source, /const projectReply = !pdfProgress\.projectClarification && !executiveReply && !standaloneFragment/);
  assert.match(source, /const localKatieResponse = !standaloneFragment && pdfProgress\.projectClarification/);
});
test("explicit project and attachment routing remains available", () => {
  assert.match(source, /contextProjects\.length \|\| freshTaskEvidence\.length \|\| startProjectIntent\(message\) \|\| followupProjectIntent\(message\)/);
});
