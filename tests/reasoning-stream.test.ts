import test from "node:test";
import assert from "node:assert/strict";
import { ReasoningStateAccumulator } from "../lib/chat/reasoning-stream";

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

