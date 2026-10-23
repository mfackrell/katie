import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync("app/api/chat/route.ts", "utf8");

test("ordinary standalone messages cannot trigger project-only local arbitration", () => {
  assert.match(source, /if \(!isProjectStopRequest && \(startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)\)/);
  assert.doesNotMatch(source, /isProjectStopRequest && \(contextProjects\.length \|\|/);
  assert.match(source, /const localKatieResponse = \(startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)\) && pdfProgress\.projectClarification/);
});
test("explicit project commands retain project control dispatch", () => {
  assert.match(source, /const projectReply = \(startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)\)/);
});
