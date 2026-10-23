import test from "node:test";
import assert from "node:assert/strict";
import {referencesSavedProject} from "../lib/chat/project-reference";

test("ordinary biography does not reference a managed project", () => {
  const profile = "My professional identity: I am an interim CFO and executive. Here is my experience in M&A and financial operations.";
  assert.equal(referencesSavedProject(profile), false);
  assert.equal(referencesSavedProject("Tell me who you think I am professionally"), false);
  assert.equal(referencesSavedProject("How are you doing?"), false);
});

test("explicit project continuation remains available", () => {
  for (const input of [
    "Resume the saved project",
    "Return to my earlier application",
    "Continue the project",
    "Go back to that project",
  ]) assert.equal(referencesSavedProject(input), true, input);
});
