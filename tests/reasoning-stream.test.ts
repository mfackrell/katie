import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReasoningStateAccumulator, ChatAnswerStreamBoundary, resolveChatAnswer } from "../lib/chat/reasoning-stream";

test("emits reasoning_start then updates then final_answer in order", () => {
  const acc = new ReasoningStateAccumulator("req-1", ["Architecture", "Security"]);
  const start = acc.start(new Date("2026-03-28T00:00:00.000Z"));
  const update = acc.addDelta("Drafting a safe plan.", new Date("2026-03-28T00:00:00.100Z"));
  const final = acc.finalize("Done", new Date("2026-03-28T00:00:01.000Z"));

  assert.equal(start.type, "reasoning_start");
  assert.equal(update?.type, "reasoning_update");
  assert.equal(final.type, "final_answer");
});

test("handles missing/partial scores and snapshot reflects latest state", () => {
  const acc = new ReasoningStateAccumulator("req-2", ["Architecture"]);
  acc.start();
  acc.addDelta("short", new Date("2026-03-28T00:00:00.100Z"));
  const snap = acc.snapshot(new Date("2026-03-28T00:00:00.200Z"));

  assert.equal(snap.categories[0].score, null);
  assert.equal(snap.categories[0].explanation, "short");
});

test("emits reasoning_error payload", () => {
  const acc = new ReasoningStateAccumulator("req-3", ["Reliability"]);
  const error = acc.error("provider timeout", true);
  assert.deepEqual(error, {
    type: "reasoning_error",
    requestId: "req-3",
    message: "provider timeout",
    recoverable: true
  });
});

test("final answer is only emitted once", () => {
  const acc = new ReasoningStateAccumulator("req-4", ["Cost"]);
  acc.start();
  acc.finalize("first");
  assert.throws(() => acc.finalize("second"), /already emitted/);
});


const editorialExample = [
  "1.5s",
  "",
  "The user is explaining a meaningful personal observation. I should receive it plainly.",
  "I need to avoid over-explaining, keep the reply brief, and not invent extra motivations.",
  "The content is clear enough to answer without another question.",
  "Match his tone - plain, direct, not performing empathy.That tracks with what you said earlier.",
  "",
  "It makes sense that you prefer working around other people.",
].join("\n");
const expectedReply = "That tracks with what you said earlier.\n\nIt makes sense that you prefer working around other people.";

test("holds a fragmented editorial opening and recovers its final conversational reply", () => {
  const boundary = new ChatAnswerStreamBoundary();
  let shown = "";
  for (const character of editorialExample) shown += boundary.write(character);
  assert.equal(shown, "", "Do not stream any editorial prefix");
  assert.equal(boundary.flushAccepted(), "", "Do not flush a held prefix");
  assert.equal(resolveChatAnswer(editorialExample), expectedReply);
});

test("ordinary streaming responses are untouched, including short replies", () => {
  const long = "You can tell me what you noticed. ".repeat(10);
  const guard = new ChatAnswerStreamBoundary();
  let streamed = "";
  for (const character of long) streamed += guard.write(character);
  streamed += guard.flushAccepted();
  assert.equal(streamed, long);
  assert.equal(resolveChatAnswer(long), long);
  const short = new ChatAnswerStreamBoundary();
  assert.equal(short.write("Yes, that makes sense."), "");
  assert.equal(short.flushAccepted(), "Yes, that makes sense.");
  assert.equal(resolveChatAnswer("1.5s is the measured delay in the report."), "1.5s is the measured delay in the report.");
});

test("unseparated editorial drafts are blocked, not silently accepted", () => {
  const draft = "1.5s\n\nThe user is stating a preference. I should respond concisely.";
  const boundary = new ChatAnswerStreamBoundary();
  assert.equal(boundary.write(draft), "");
  assert.equal(resolveChatAnswer(draft), null);
  assert.equal(boundary.flushAccepted(), "");
});

test("an explicit final-answer separator safely recovers the remainder", () => {
  const draft = "1.5s\n\nThe user is describing an issue.\n\nFINAL ANSWER: You are right to flag this. It needs correction.";
  assert.equal(resolveChatAnswer(draft), "You are right to flag this. It needs correction.");
});

test("chat route protects streams and persisted content with the same boundary", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(route, /chatAnswerBoundary\.write\(delta\)/);
  const sanitize = route.indexOf("const rawAssistantText = resolveChatAnswer(originalAssistantText)");
  const save = route.indexOf("await saveMessage(chatId, {\n              id: assistantMessageId");
  assert.ok(sanitize > 0 && save > sanitize);
  assert.match(route, /chatAnswerBoundary\.flushAccepted\(\)/);
});
