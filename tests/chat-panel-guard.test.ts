import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitChatRequest } from "../lib/chat/request-guards";

test("no request should be sent when actorId or chatId is blank", () => {
  assert.equal(canSubmitChatRequest("", "c1"), false);
  assert.equal(canSubmitChatRequest("a1", ""), false);
  assert.equal(canSubmitChatRequest("   ", "c1"), false);
  assert.equal(canSubmitChatRequest("a1", "   "), false);
});

test("request can be sent when actorId and chatId are present", () => {
  assert.equal(canSubmitChatRequest("a1", "c1"), true);
});
