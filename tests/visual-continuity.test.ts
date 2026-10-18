import test from "node:test";
import assert from "node:assert/strict";
import { chooseVisualSubjects, canonicalSubject } from "../lib/chat/visual-continuity";

const chatId = "chat-1";
const rows = [
  { subject_key: "katie", label: "Katie", source_chat_id: chatId, updated_at: "2026-10-18T14:18:20Z" },
  { subject_key: "jess", label: "Jess", source_chat_id: chatId, updated_at: "2026-10-18T14:17:25Z" },
  { subject_key: "chloe", label: "Chloe", source_chat_id: chatId, updated_at: "2026-10-18T14:16:32Z" },
  { subject_key: "client", label: "Client", source_chat_id: "other-chat", updated_at: "2026-10-17T12:00:00Z" },
];

test("individual portraits choose their original identity and do not overwrite it as a new scene", () => {
  const plan = chooseVisualSubjects("Create another photorealistic image of Chloe at the park", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe"]);
  assert.deepEqual(plan.anchor, { key: "chloe", label: "Chloe", replace: false });
});

test("corrections reference and replace the last individual identity", () => {
  const latestChloe = [rows[2], rows[1], rows[0], rows[3]];
  const plan = chooseVisualSubjects("She's blonde…", latestChloe, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe"]);
  assert.equal(plan.anchor?.replace, true);
});

test("Katie's identity resolves from 'you' without generating an unrelated person", () => {
  const plan = chooseVisualSubjects("Now create an image of you", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["katie"]);
  assert.equal(plan.anchor?.key, "katie");
});

test("group portraits use same-chat cast, not unrelated actor-wide identities", () => {
  const plan = chooseVisualSubjects("Now create an image of all of you along with Ellie at the beach", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["katie", "jess", "chloe"]);
  assert.equal(plan.anchor, null);
});

test("explicit two-person request retains both labels and never overwrites either identity", () => {
  const plan = chooseVisualSubjects("Draw Chloe and Jess together", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, ["chloe", "jess"]);
  assert.equal(plan.anchor, null);
});

test("actor-wide names are available explicitly across chats without attaching an entire other cast", () => {
  const plan = chooseVisualSubjects("Generate a picture of Client", rows, "Katie", "new-chat");
  assert.deepEqual(plan.keys, ["client"]);
  assert.equal(plan.anchor?.key, "client");
});

test("unrelated image does not hijack an existing identity", () => {
  const plan = chooseVisualSubjects("Create an image of a mountain lake", rows, "Katie", chatId);
  assert.deepEqual(plan.keys, []);
  assert.equal(plan.anchor, null);
});

test("subject labels are bounded and canonicalized", () => {
  assert.equal(canonicalSubject("  Chloe!  "), "chloe");
  assert.ok(canonicalSubject("a".repeat(200)).length <= 64);
});
