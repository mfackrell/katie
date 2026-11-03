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
  assert.equal(short.write("Yes, that makes sense."), "Yes, that makes sense.", "Short replies must stream on the first safe delta.");
  assert.equal(short.flushAccepted(), "");
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

test("very short normal replies stream before the provider finishes", () => {
  for (const reply of ["Yeah.", "That is interesting.", "I hear you.", "Absolutely!", "Thanks for telling me."]) {
    const boundary = new ChatAnswerStreamBoundary();
    let visible = "";
    for (const char of reply) visible += boundary.write(char);
    assert.equal(visible, reply, reply);
    assert.equal(boundary.flushAccepted(), "", reply);
  }
});

test("a possible editorial timing prefix remains withheld across every stream split", () => {
  for (const candidate of ["1.5s\\n\\nThe user is describing the situation.", "12s\\r\\n\\r\\nThe user is thinking about this."]) {
    const raw = candidate.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    for (const splitIndex of [1, 2, 3, 5, 6, 8, 10, 15, 18, raw.length - 1]) {
      const boundary = new ChatAnswerStreamBoundary();
      const shown = boundary.write(raw.slice(0, splitIndex)) + boundary.write(raw.slice(splitIndex));
      assert.equal(shown, "", "Editorial planning text must not leak with any split.");
      assert.equal(boundary.flushAccepted(), "");
      assert.equal(resolveChatAnswer(raw), null);
    }
  }
});

test("normal numerical and duration-like replies are released once ruled out", () => {
  const examples = [
    ["1.5s", " is the measured delay."],
    ["12", " months of runway remain."],
    ["202", "6 revenue was higher."],
    ["1.", " A practical recommendation is to verify the ledger."],
  ];
  for (const [prefix, remainder] of examples) {
    const boundary = new ChatAnswerStreamBoundary();
    assert.equal(boundary.write(prefix), "", prefix);
    assert.equal(boundary.write(remainder), prefix + remainder, prefix + remainder);
    assert.equal(boundary.flushAccepted(), "");
  }
});

test("unresolved editorial prefixes are still fail-closed", () => {
  for (const prefix of ["1.5s", "1.5s\n", "1.5s\n\nThe u", "12s\r\n\r\nThe user"]) {
    const boundary = new ChatAnswerStreamBoundary();
    assert.equal(boundary.write(prefix), "", prefix);
    assert.equal(boundary.flushAccepted(), prefix, "A non-editorial completed reply remains eligible only after final validation.");
  }
});
