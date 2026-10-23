import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const route = readFileSync("app/api/chat/route.ts", "utf8");
const decoder = /const explicitSavedProjectReference = \/(.*?)\/i\.test\(message\);/s.exec(route);
assert.ok(decoder, "Saved-project reference gate must remain visible in the actual chat route");
const referencesSavedProject = new RegExp(decoder[1], "i");

test("ordinary biography does not reference a managed project", () => {
  for (const message of [
    "My professional identity: I am an interim CFO and executive. Here is my experience.",
    "Tell me who you think I am professionally",
    "How are you doing?",
    "Please remember my financial and operational background.",
  ]) assert.equal(referencesSavedProject.test(message), false, message);
});

test("explicit project resumption remains available", () => {
  for (const message of [
    "Resume the saved project",
    "Return to my earlier application",
    "Continue the project",
    "Go back to that project",
  ]) assert.equal(referencesSavedProject.test(message), true, message);
});

test("project command implementation is owned by Developer, not standalone conversation", () => {
  assert.match(route, /from '@\/lib\/developer\/project-conversation'/);
  const legacy = readFileSync("lib/projects/chat.ts", "utf8");
  assert.doesNotMatch(legacy, /projectRpc\s*</);
  assert.match(legacy, /from '@\/lib\/developer\/project-conversation'/);
});
