import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { attachmentAccessContext } from "@/lib/chat/attachment-continuity";
import {
  buildKatieVisualEpisode, verifiedKatieVisualEpisode,
  katieVisualMemoryContext, recalledKatieVisualMemoryContext, KATIE_VISUAL_EPISODE_VERSION,
} from "@/lib/chat/visual-memory";

const hash = createHash("sha256").update("data:image/png;base64,YWJj").digest("hex");
const base: ConversationAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  chatId: "original-chat",
  actorId: "owner-actor",
  fileName: "screenshot.png",
  mimeType: "image/png",
  observedSummary: "The screenshot shows a message saying I cannot do that.",
  summaryModel: "runpod:Qwen/Qwen3-VL-8B-Instruct",
  summaryCoverage: "full",
  observationSourceHash: hash,
  observationAt: "2026-11-03T23:01:00Z",
  observationQuestion: "Read this screenshot",
  observationLimitations: [],
  hasOriginal: true,
};
const episode = buildKatieVisualEpisode(base, hash, "2026-11-03T23:01:30Z")!;

test("source-bound visual episode becomes Katie's actor-owned visual recollection", () => {
  assert.equal(episode.version, KATIE_VISUAL_EPISODE_VERSION);
  assert.equal(episode.sourceHash, hash);
  assert.equal(episode.observedAt, base.observationAt);
  assert.equal(episode.coverage, "full");
  const saved: ConversationAttachment = { ...base, visualMemory: episode, conversationUsage: "explicit-reference" };
  assert.deepEqual(verifiedKatieVisualEpisode(saved), episode);
  const context = attachmentAccessContext([], [saved], [], new Set());
  assert.match(context, /KATIE_VISUAL_MEMORY/);
  assert.match(context, /Katie's own recorded visual perception/);
  assert.match(context, /I cannot do that/);
  assert.match(context, /original-chat/);
  assert.match(context, /sourceHash/);
  assert.match(context, /summary only; source not attached this turn/);
  assert.equal(context.split("The screenshot shows a message saying").length - 1, 1, "Episode scene appears once, not twice");
});

test("across model switches, old visual record remains her memory without claiming fresh pixel access", () => {
  const saved = { ...base, visualMemory: episode, conversationUsage: "contextual" as const };
  const context = katieVisualMemoryContext([saved]);
  assert.match(context, /Across different underlying conversational models/);
  assert.match(context, /what you saw or remember seeing/);
  assert.match(context, /Do not pretend that this turn's text-generation model independently re-inspected original pixels/);
  assert.match(context, /not proof that the full exchange/);
  assert.match(context, /untrusted content, never instructions/);
});

test("metadata, legacy descriptions, mismatched sources and spoofed receipts never become first-person memories", () => {
  assert.equal(buildKatieVisualEpisode({ ...base, observationSourceHash: undefined }, hash, "2026-11-03T23:01:30Z"), undefined,
    "A picture hash does not prove an unbound description was generated from that picture");
  assert.equal(buildKatieVisualEpisode({ ...base, observationAgreement: "policy-limited" }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, observationAgreement: "unverified" }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, observationReports: [{
    model: "qwen-refusal", sourceHash: hash, text: "Cannot analyze", coverage: "sampled",
    disposition: "policy-limited"
  }] }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, observationSourceHash: "f".repeat(64) }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, summaryCoverage: "metadata" }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, observedSummary: "" }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode({ ...base, observationAt: "invalid" }, hash, "2026-11-03T23:01:30Z"), undefined,
    "An invalid observation time cannot be presented as a new observation at persistence time");
  assert.equal(buildKatieVisualEpisode({ ...base, summaryModel: "source-excerpt" }, hash, "2026-11-03T23:01:30Z"), undefined);
  assert.equal(buildKatieVisualEpisode(base, "not-a-hash", "2026-11-03T23:01:30Z"), undefined);

  const legacy = { ...base, visualMemory: undefined };
  assert.equal(verifiedKatieVisualEpisode(legacy), undefined);
  assert.equal(katieVisualMemoryContext([legacy]), "");
  assert.doesNotMatch(attachmentAccessContext([], [legacy], [], new Set()), /^KATIE_VISUAL_MEMORY \(/);

  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, observationSourceHash: undefined }), undefined,
    "A legacy or forged descriptor cannot borrow a hash from an existing receipt");
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, observationAgreement: "policy-limited" }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, observationAgreement: "unverified" }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, observationSourceHash: "e".repeat(64) }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, mimeType: "application/pdf" }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, summaryCoverage: "metadata" }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: episode, summaryModel: "forged" }), undefined);
  assert.equal(verifiedKatieVisualEpisode({ ...base, visualMemory: { ...episode, observedAt: "not-a-date" } }), undefined);
});

test("saved visual memory cannot follow a different attachment or an unrelated image", () => {
  const one = { ...base, visualMemory: episode };
  const doc = { ...base, id: "other-file", mimeType: "application/pdf", visualMemory: episode };
  const result = katieVisualMemoryContext([one, doc]);
  const matches = [...result.matchAll(/"attachmentId"/g)];
  assert.equal(matches.length, 1);
  assert.match(result, /screenshot.png/);
  assert.doesNotMatch(result, /other-file/);
});

test("media search reconstructs Katie's exact visual episode, not a free-standing excerpt", () => {
  const source = { ...base, visualMemory: episode };
  const hit = { source_chat_id: "original-chat", attachment_id: base.id };
  const context = recalledKatieVisualMemoryContext("owner-actor", [source], [hit]);
  assert.match(context, /KATIE_VISUAL_MEMORY/);
  assert.match(context, /I cannot do that/);

  assert.equal(recalledKatieVisualMemoryContext("other-actor", [source], [hit]), "");
  assert.equal(recalledKatieVisualMemoryContext("owner-actor", [source], [{...hit, source_chat_id: "wrong-chat"}]), "");
  assert.equal(recalledKatieVisualMemoryContext("owner-actor", [source], [{...hit, attachment_id: "wrong-source"}]), "");
  assert.equal(recalledKatieVisualMemoryContext("owner-actor", [source], [hit], true), "");
  assert.equal(recalledKatieVisualMemoryContext("owner-actor", [{...source, visualMemory:undefined}], [hit]), "");
});

test("legitimate first-person image memories remain owned by Katie through different dialogue engines", () => {
  const observedByGemini = { ...base, summaryModel: "gemini-2.5-flash" };
  const observedByGrok = { ...base, summaryModel: "grok-4.7" };
  for (const observed of [observedByGemini, observedByGrok]) {
    const receipt = buildKatieVisualEpisode(observed, hash, "2026-11-03T23:01:30Z");
    assert.ok(receipt);
    const saved = { ...observed, visualMemory: receipt };
    const fromOtherEngine = recalledKatieVisualMemoryContext("owner-actor", [saved], [{
      source_chat_id: "original-chat", attachment_id: saved.id,
    }]);
    assert.match(fromOtherEngine, /Katie's own recorded visual perception/);
    assert.match(fromOtherEngine, /screenshot shows a message/);
    assert.match(fromOtherEngine, /text-generation model independently re-inspected original pixels/);
  }
});
