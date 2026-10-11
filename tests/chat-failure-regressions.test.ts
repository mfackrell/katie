import test from "node:test";
import assert from "node:assert/strict";
import { finishChatFailure, chatFailureContent } from "../lib/chat/request-failure";
import { validateManualOverrideWithRecovery } from "../lib/chat/manual-override-recovery";
import { filterCandidatesForIntent, buildCandidateMetadata, validateRoutingDecision } from "../lib/router/model-intent";
import type { LlmProvider } from "../lib/providers/types";

const google: LlmProvider = { name: "google", listModels: async () => [], generate: async () => ({ text: "ok", model: "gemini-3.8-flash", provider: "google" }) };
test("non-conversational models cannot enter primary or fallback text pools despite registry text flags", () => {
  const bad = ["lyria-3-pro-preview", "lyria-3.5", "gemini-3.8-flash-tts", "gemini-3.5-transcribe", "text-embedding-3-small", "whisper-1", "veo-3"];
  for (const model of bad) {
    const registryLookup = new Map([[`google:${model}`, { model_id: model, provider_name: "google", supports_text: true, supports_vision: true, supports_web_search: true }]]) as never;
    const pool = [{ provider: google, models: [model, "gemini-3.8-flash"] }];
    for (const intent of ["marketing-analysis", "general-text", "web-search", "vision-analysis"] as const) {
      assert.equal(filterCandidatesForIntent(pool, intent, { registryLookup }).some(p => p.models.includes(model)), false, `${model}:${intent}`);
    }
    assert.equal(buildCandidateMetadata("google", model, "marketing-analysis", { registryLookup }).supports_text, false);
    assert.equal(validateRoutingDecision({ providerName: "google", modelId: model }, pool, "marketing-analysis", { registryLookup }).modelId, "gemini-3.8-flash");
  }
  assert.throws(() => validateRoutingDecision({ providerName: "google", modelId: bad[0] }, [{ provider: google, models: bad }], "marketing-analysis"), /No compatible model/);
});

test("terminal failure persists a chat bubble and closes normally after delivering the error", async () => {
  const saved: unknown[] = [];
  let failedId: string | undefined;
  const stream = new ReadableStream<string>({
    start(controller) {
      void finishChatFailure({ requestId: "req", chatId: "chat", message: "Provider unavailable",
        save: async message => { saved.push(message); },
        markFailed: async id => { failedId = id; },
        emit: id => controller.enqueue(JSON.stringify({ type: "reasoning_error", messageId: id })),
        close: () => controller.close(),
      });
    },
  });
  const reader = stream.getReader();
  assert.equal(JSON.parse((await reader.read()).value!).messageId, "req");
  assert.equal((await reader.read()).done, true);
  assert.equal(failedId, "req");
  assert.match(JSON.stringify(saved), /Your message is saved/);
  assert.match(chatFailureContent("Provider unavailable"), /could not complete/);
});

test("storage outage does not prevent delivering and closing a terminal error", async () => {
  let emitted = false, closed = false;
  await finishChatFailure({ requestId: "req", chatId: "chat", message: "Failed",
    save: async () => { throw new Error("storage down"); },
    markFailed: async () => { throw new Error("status down"); },
    emit: id => { assert.equal(id, undefined); emitted = true; }, close: () => { closed = true; },
  });
  assert.equal(emitted && closed, true);
});

const claude: LlmProvider = {
  name: "anthropic",
  listModels: async () => ["claude-fable-5-1"],
  generate: async () => ({ text: "ok", model: "claude-fable-5-1", provider: "anthropic" }),
};

test("text-only manual override recovers from mistaken safety-sensitive-vision classification", () => {
  // Reproduces the October 11 production failure without modifying the
  // classifier or broadening Fable's heuristic vision capability flags.
  assert.throws(() => validateRoutingDecision(
    { providerName: "anthropic", modelId: "claude-fable-5-1" },
    [{ provider: claude, models: ["claude-fable-5-1"] }],
    "safety-sensitive-vision",
  ), /No compatible model available for safety-sensitive-vision/);

  for (const intent of ["safety-sensitive-vision", "vision-analysis", "multimodal-reasoning"] as const) {
    const recovered = validateManualOverrideWithRecovery({
      provider: claude, modelId: "claude-fable-5-1",
      availableModels: ["claude-fable-5-1"], intent,
      hasVisualInput: false, hasVideoInput: false,
    });
    assert.equal(recovered.decision.changed, false);
    assert.equal(recovered.decision.modelId, "claude-fable-5-1");
    assert.equal(recovered.recoveredIntent, "general-text");
  }
});

test("manual override recovery never downgrades real images, videos or unrelated intent failures", () => {
  for (const inputs of [
    { hasVisualInput: true, hasVideoInput: false, intent: "safety-sensitive-vision" as const },
    { hasVisualInput: false, hasVideoInput: true, intent: "safety-sensitive-vision" as const },
    { hasVisualInput: false, hasVideoInput: false, intent: "image-generation" as const },
  ]) {
    assert.throws(() => validateManualOverrideWithRecovery({
      provider: claude, modelId: "claude-fable-5-1",
      availableModels: ["claude-fable-5-1"], ...inputs,
    }), /No compatible model available for/);
  }
  const normal = validateManualOverrideWithRecovery({
    provider: claude, modelId: "claude-fable-5-1",
    availableModels: ["claude-fable-5-1"], intent: "general-text",
    hasVisualInput: false, hasVideoInput: false,
  });
  assert.equal(normal.recoveredIntent, null);
  assert.equal(normal.decision.changed, false);
});

test("manual override recovery preserves rejection of an unavailable or non-text selected model", () => {
  assert.throws(() => validateManualOverrideWithRecovery({
    provider: claude, modelId: "claude-fable-5-1",
    availableModels: [], intent: "safety-sensitive-vision",
    hasVisualInput: false, hasVideoInput: false,
  }), /No compatible model available for general-text/);
  const alternative = validateManualOverrideWithRecovery({
    provider: claude, modelId: "claude-fable-5-1",
    availableModels: ["claude-sonnet-4-6"], intent: "safety-sensitive-vision",
    hasVisualInput: false, hasVideoInput: false,
  });
  assert.equal(alternative.recoveredIntent, "general-text");
  assert.equal(alternative.decision.changed, true, "caller must still reject a changed manual override");
});

test("chat route uses targeted manual override recovery without changing classification", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(route, /validateManualOverrideWithRecovery\\(\\{/);
  assert.match(route, /const overrideClassification = await inferRequestClassification\\(/);
  assert.match(route, /resolvedRequestIntent = recoveredIntent/);
});
