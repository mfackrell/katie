import test from "node:test";
import assert from "node:assert/strict";
import type { ChatThread } from "../lib/types/chat";
import { resolveStarterChat } from "../lib/chat/starter-chat";

test("starter chat flow returns existing chat for repeated requests", () => {
  const firstChat: ChatThread = {
    id: "chat-1",
    actorId: "actor-1",
    title: "Chat",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
  };

  const firstResolution = resolveStarterChat([], { createStarterChat: true });
  assert.equal(firstResolution, null);

  const secondResolution = resolveStarterChat([firstChat], { createStarterChat: true });
  assert.equal(secondResolution?.id, "chat-1");
});

test("manual new chat requests do not reuse existing starter chat", () => {
  const existingChats: ChatThread[] = [
    {
      id: "chat-1",
      actorId: "actor-1",
      title: "Chat",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    },
  ];

  const resolution = resolveStarterChat(existingChats, { createStarterChat: false });
  assert.equal(resolution, null);
});
