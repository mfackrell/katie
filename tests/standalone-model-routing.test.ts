import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const route=readFileSync("app/api/chat/route.ts","utf8");
test("ordinary conversation cannot produce locally arbitrated project reply",()=>{
  assert.match(route,/const explicitProjectControl = startProjectIntent\(message\) \|\| followupProjectIntent\(message\) \|\| isProjectStopIntent\(message\)/);
  assert.match(route,/const projectReply = !pdfProgress\.projectClarification && !executiveReply && \(benchmarkRelay \|\| explicitProjectControl \|\| softwareBuildIntent\)/);
  assert.match(route,/const localKatieResponse = !standaloneFragment && \(explicitProjectControl \|\| newAttachments\.length > 0\) && pdfProgress\.projectClarification/);
});
test("attachment and explicit management still retain dedicated processing",()=>{
  assert.match(route,/newAttachments\.length > 0/);
  assert.match(route,/explicitProjectControl/);
});
