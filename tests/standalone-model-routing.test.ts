import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseLocalProjectControl } from "../lib/chat/project-control-boundary";

test("ambiguous ordinary standalone messages stay on LLM path", () => {
  for (const text of ["it", "that", "hello", "what about that?", "Please share 3 to 5 examples of relevant experience."]) {
    assert.equal(shouldUseLocalProjectControl(text), false, text);
  }
});

test("explicit project operations retain their control path", () => {
  assert.equal(shouldUseLocalProjectControl("Start a new software project to build a budgeting application"), true);
});
