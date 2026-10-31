import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderPayloadCaptureTrace } from "../lib/chat/provider-payload-trace";
import type { Message } from "../lib/types/chat";

const make = (id: string, role: "user" | "assistant", model?: string): Message => ({
  id, role, chatId: "chat", createdAt: "2026-10-31T17:00:00Z", content: id,
  ...(model ? { model } : {}),
});

test("trace reports diagnostic-pair exclusions without changing message history", () => {
  const messages = [
    make("u1", "user"), make("a1", "assistant"),
    make("u2", "user"), make("a2", "assistant", "katie-local"),
    make("u3", "user"),
  ];
  const trace = buildProviderPayloadCaptureTrace({
    actorId: "actor", chatId: "chat", requestId: "req",
    historySource: "stm", recentMessages: messages,
    shortTermMemory: { version: 2, exchanges: [{ user: { id: "u1" }, assistant: { id: "a1" } }] },
    history: messages.slice(0, 2), summary: "old",
  });
  assert.equal(trace.stmLastAssistantId, "a1");
  assert.equal(trace.persistedLastCompletedAssistantId, "a1");
  assert.equal(trace.stmMatchesPersistedTail, true);
  assert.deepEqual(trace.excludedTurns.map(x => [x.id, x.reason]), [
    ["u2", "local-diagnostic-pair"],
    ["a2", "local-diagnostic-pair"],
    ["u3", "awaiting-assistant"],
  ]);
  assert.deepEqual(trace.historyTurns.map(x=>x.id), ["u1","a1"]);
});

test("trace explicitly flags a stale STM snapshot", () => {
  const trace = buildProviderPayloadCaptureTrace({
    actorId: "actor", chatId: "chat", requestId: "req", historySource: "stm",
    recentMessages: [make("u1", "user"),make("a1", "assistant"), make("u2","user"),make("a2","assistant")],
    shortTermMemory: { version: 2, exchanges: [{ assistant: { id: "a1" } }] },
    history: [make("u1", "user"),make("a1", "assistant")],summary:"older",
  });
  assert.equal(trace.stmMatchesPersistedTail, false);
  assert.equal(trace.persistedLastCompletedAssistantId, "a2");
  assert.equal(trace.stmLastAssistantId, "a1");
});
