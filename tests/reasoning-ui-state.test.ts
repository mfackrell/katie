import test from "node:test";
import assert from "node:assert/strict";
import { applyReasoningEvent, createReasoningUiState } from "../lib/chat/reasoning-stream";

test("renders live explainer updates incrementally", () => {
  let state = createReasoningUiState();
  state = applyReasoningEvent(state, {
    type: "reasoning_start",
    requestId: "req",
    categories: ["Architecture"],
    startedAt: "2026-03-28T00:00:00.000Z"
  });
  state = applyReasoningEvent(state, {
    type: "reasoning_update",
    requestId: "req",
    category: "Architecture",
    explanationDelta: "Hello ",
    score: null,
    confidence: null,
    progress: 10,
    updatedAt: "2026-03-28T00:00:00.050Z"
  });
  state = applyReasoningEvent(state, {
    type: "reasoning_update",
    requestId: "req",
    category: "Architecture",
    explanationDelta: "world",
    score: 7,
    confidence: 0.8,
    progress: 50,
    updatedAt: "2026-03-28T00:00:00.100Z"
  });

  assert.equal(state.liveExplainer, "Hello world");
  assert.equal(state.categories[0].score, 7);
});

test("reveals final answer only on final_answer event", () => {
  let state = createReasoningUiState();
  state = applyReasoningEvent(state, {
    type: "reasoning_start",
    requestId: "req",
    categories: ["Security"],
    startedAt: "2026-03-28T00:00:00.000Z"
  });
  assert.equal(state.finalAnswer, null);

  state = applyReasoningEvent(state, {
    type: "final_answer",
    requestId: "req",
    answer: "Complete answer",
    summaryScores: [{ name: "Security", score: 8, confidence: 0.9 }],
    completedAt: "2026-03-28T00:00:01.000Z"
  });

  assert.equal(state.finalAnswer, "Complete answer");
});

test("handles reasoning_error gracefully and supports snapshot rehydrate", () => {
  let state = createReasoningUiState();
  state = applyReasoningEvent(state, {
    type: "reasoning_error",
    requestId: "req",
    message: "Temporary stream issue",
    recoverable: true
  });
  assert.equal(state.error?.recoverable, true);

  state = applyReasoningEvent(state, {
    type: "reasoning_snapshot",
    requestId: "req",
    categories: [
      { name: "Cost", score: null, confidence: null, explanation: "Recovered", progress: 40 }
    ],
    overallProgress: 40,
    updatedAt: "2026-03-28T00:00:00.500Z"
  });

  assert.equal(state.categories[0].explanation, "Recovered");
  assert.equal(state.overallProgress, 40);
});
