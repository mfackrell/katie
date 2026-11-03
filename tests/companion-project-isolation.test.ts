import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyAssistantToTaskProgress, applyUserToTaskProgress, emptyTaskProgress,
  rebuildTaskProgress,
} from "../lib/chat/task-progress";
import { decideResponsePolicy } from "../lib/chat/response-policy";

test("ordinary companion exchanges cannot create managed project obligations", () => {
  const turns = [
    { id: "u1", role: "user" as const, content: "a little pissy there eh katie" },
    { id: "a1", role: "assistant" as const, content: "Me? Never. Did you catch that look?" },
    { id: "u2", role: "user" as const, content: "maybe a bit" },
    { id: "a2", role: "assistant" as const, content: "What made you say that?" },
  ];
  const progress = rebuildTaskProgress(turns);
  assert.equal(progress.projectContext, undefined);
  assert.equal(progress.objective, null);
  assert.deepEqual(progress.pending, []);
  assert.deepEqual(progress.projects ?? [], []);
  const followup = applyUserToTaskProgress(progress, { messageId: "u3", text: "because you sounded annoyed" });
  assert.equal(followup.lastUserIntent, "conversation");
  assert.equal(followup.objective, null);
  assert.deepEqual(followup.answered, []);
  assert.equal(decideResponsePolicy({ message: "yes", responsePurpose: "conversation",
    hasPendingDeliverable: Boolean(followup.projectContext && followup.objective && followup.answered.length) }).purpose, "conversation");
});

test("legacy synthetic conversation state is retired without deleting legitimate project snapshots", () => {
  const work = applyUserToTaskProgress(emptyTaskProgress(), {
    messageId: "work", text: "Prepare a cash-flow forecast for our CFO review.",
  });
  const old = { ...work, projectContext: { userMessageId: "casual", text: "a little pissy there eh katie" },
    objective: { userMessageId: "casual", text: "a little pissy there eh katie" },
    pending: [{ id: "a1:1", assistantMessageId: "a1", index: 1, text: "What are you up to?" }],
    projects: [...(work.projects ?? []), { projectContext: { userMessageId: "casual", text: "a little pissy there eh katie" },
      objective: { userMessageId: "casual", text: "a little pissy there eh katie" }, pending: [], answered: [] }],
  };
  const next = applyUserToTaskProgress(old, { messageId: "next", text: "yeah a little" });
  assert.equal(next.projectContext, null);
  assert.equal(next.objective, null);
  assert.deepEqual(next.pending, []);
  assert.equal(next.projects?.length, 1);
  assert.equal(next.projects?.[0].projectContext.userMessageId, "work");
});

test("professional finance and coding projects retain pending questions and answer linkage", () => {
  for (const request of [
    "Prepare a cash-flow forecast for our CFO review.",
    "Implement an isolated fix for the TypeScript routing bug.",
    "Interim CFO for PE-backed manufacturing company: global audit and restructuring experience required.",
  ]) {
    let state = applyUserToTaskProgress(emptyTaskProgress(), { messageId: "work", text: request });
    assert.equal(state.projectContext?.userMessageId, "work", request);
    state = applyAssistantToTaskProgress(state, {
      messageId: "question", text: "1. What deadline should the deliverable meet?",
      responsePurpose: "deliverable",
    });
    assert.equal(state.pending.length, 1, request);
    state = applyUserToTaskProgress(state, { messageId: "answer", text: "1. Friday", projectRelation: "same_project" });
    assert.equal(state.lastUserIntent, "answer", request);
    assert.equal(state.pending.length, 0, request);
    assert.equal(state.answered[0].answer, "Friday", request);
  }
});

test("response policy production call requires a real project for answer-based pending work", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(route, /taskProgress\.projectContext && taskProgress\.objective && taskProgress\.lastUserIntent === "answer"/);
  assert.match(route, /\|\|\s*pendingReviewClarification/);
});
