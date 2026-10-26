import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExplicitKatieSelfInspectionRequest } from "../lib/tools/self-inspection-intent";

test("production cognition transcript does not activate Katie self-inspection", () => {
  const message = readFileSync(join(process.cwd(), "tests/fixtures/2026-10-26-cognition-transcript.txt"), "utf8");
  assert.ok(message.includes("yourself talking through your plans, or do you simply know"));
  assert.equal(isExplicitKatieSelfInspectionRequest(message), false);
});

test("direct Katie source-inspection requests remain recognized", () => {
  for (const prompt of [
    "Can you see yourself?",
    "Inspect your own code.",
    "Katie, check your repository logs.",
    "Please inspect yourself",
  ]) {
    assert.equal(isExplicitKatieSelfInspectionRequest(prompt), true, prompt);
  }
});

test("ordinary reflections mentioning yourself or Katie stay conversational", () => {
  for (const prompt of [
    "Do you know yourself well?",
    "You should understand yourself before judging others.",
    "Katie, tell me about how people hear their own thoughts.",
  ]) {
    assert.equal(isExplicitKatieSelfInspectionRequest(prompt), false, prompt);
  }
});
