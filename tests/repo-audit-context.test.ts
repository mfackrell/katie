import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHAT_ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

test("repo audit context includes inspected/omitted/error metadata and visibility summary instructions", () => {
  assert.match(CHAT_ROUTE, /files_inspected:/);
  assert.match(CHAT_ROUTE, /omitted_files_or_limits:/);
  assert.match(CHAT_ROUTE, /fetch_errors:/);
  assert.match(CHAT_ROUTE, /confidence_visibility_summary:/);
  assert.match(CHAT_ROUTE, /do not ask the user to paste files/i);
});

test("generic repo discovery avoids Katie-specific hard-coded core audit file paths", () => {
  assert.doesNotMatch(CHAT_ROUTE, /CORE_AUDIT_FILES/);
  assert.doesNotMatch(CHAT_ROUTE, /katie/i);
});
