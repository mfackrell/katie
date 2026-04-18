import test from "node:test";
import assert from "node:assert/strict";
import { buildGenerationFailureChunk } from "../lib/chat/stream-events";

test("provider selection / generation failures emit structured stream error chunk", () => {
  const chunk = buildGenerationFailureChunk({
    message: "No eligible provider",
    provider: "google",
    modelId: "gemini-3.1-pro",
    stage: "provider_selection",
    recoverable: false
  });

  assert.deepEqual(chunk, {
    type: "generation_failure",
    stage: "provider_selection",
    message: "No eligible provider",
    provider: "google",
    modelId: "gemini-3.1-pro",
    recoverable: false
  });
});
