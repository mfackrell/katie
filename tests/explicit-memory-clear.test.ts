import test from "node:test";
import assert from "node:assert/strict";
import { isFullActorMemoryClear } from "../lib/memory/explicit-memory";

test("recognizes the real-world instruction that was incorrectly saved as a correction", () => {
  assert.equal(isFullActorMemoryClear("remove all of the existing entries you have in the long term memory layer for the Katie Agent"), true);
  assert.equal(isFullActorMemoryClear("Please delete all long-term memory entries"), true);
  assert.equal(isFullActorMemoryClear("Forget everything in your long-term memory"), true);
});

test("does not confuse single-entry deletion, correction, inspection or saving with a full clear", () => {
  for (const message of [
    "remove the incorrect memory about the meeting",
    "correct the saved memory about my preferences",
    "show me all entries in your long-term memory",
    "remember all of these facts in long-term memory",
    "delete the last message from this chat",
  ]) {
    assert.equal(isFullActorMemoryClear(message), false, message);
  }
});
