import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitChatRequest, hasResolvedChatSelection } from "../lib/chat/request-guards";

test("no request should be sent when actorId or chatId is blank", () => {
  assert.equal(canSubmitChatRequest("", "c1"), false);
  assert.equal(canSubmitChatRequest("a1", ""), false);
  assert.equal(canSubmitChatRequest("   ", "c1"), false);
  assert.equal(canSubmitChatRequest("a1", "   "), false);
});

test("request can be sent when actorId and chatId are present", () => {
  assert.equal(canSubmitChatRequest("a1", "c1"), true);
});

test("no request should be sent when actor/chat ids are not resolved from durable selections", () => {
  const actors = [{ id: "a-visible", name: "Visible", purpose: "x" }];
  const chats = [{ id: "c-visible", actorId: "a-visible", title: "Chat", createdAt: "2026-03-24T00:00:00.000Z", updatedAt: "2026-03-24T00:00:00.000Z" }];

  assert.equal(hasResolvedChatSelection("a-visible", "c-visible", actors, chats), true);
  assert.equal(hasResolvedChatSelection("a-missing", "c-visible", actors, chats), false);
  assert.equal(hasResolvedChatSelection("a-visible", "c-missing", actors, chats), false);
  assert.equal(hasResolvedChatSelection(" ", "c-visible", actors, chats), false);
});
