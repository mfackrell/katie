import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { verifiedKatieVisualEpisode, buildKatieVisualEpisode } from "@/lib/chat/visual-memory";
import { applyTrustedVisualCorrection, type TrustedVisualCorrection } from "@/lib/uploads/verified-visual-corrections";
import { reconcileActorVisualCorrections } from "@/lib/uploads/stored-uploads";
import { observeStandaloneStillImages, reusableImageObservation, imageObservationHash } from "@/lib/uploads/still-image-observations";
import type { FileReference } from "@/lib/providers/types";

const pixels = "data:image/png;base64," + Buffer.from("same-canonical-image-pixels").toString("base64");
const hash = imageObservationHash(pixels);
const actor = "actor-owner";
const chat = "conversation-owner";
const id = "exact-attachment";
const old: ConversationAttachment = {
  id, actorId: actor, chatId: chat, fileName: "photo.png", mimeType: "image/png",
  observedSummary: "The photo shows a hand holding a foot, with water nearby.",
  summaryModel: "runpod:Qwen/Qwen3-VL-8B-Instruct", summaryCoverage: "full",
  observationVersion: "still-image-observation-v2",
  observationQuestion: "[image]",
  observationSourceHash: hash, observationAt: "2026-11-04T19:53:32Z",
  observationReports: [{
    model: "runpod:Qwen/Qwen3-VL-8B-Instruct", sourceHash: hash,
    text: "Original report: foot.", coverage: "full", disposition: "observation",
  }],
  hasOriginal: true,
};
old.visualMemory = buildKatieVisualEpisode(old, hash, old.observationAt!)!;
const correctedDescription = "A close-up image showing an exposed penis held by a hand over a white toilet. A thin droplet hangs beneath the hand. The fluid composition cannot be determined from the image alone.";
const approval: TrustedVisualCorrection = {
  actor_id: actor, source_chat_id: chat, attachment_id: id, source_hash: hash,
  description: correctedDescription, correction_model: "manual:ChatGPT-verified-visual-correction",
  corrected_at: "2026-11-05T12:53:17Z", original_model: old.summaryModel!,
  source_message_id: "verified-source-message", approved_by_user: true,
};

const image: FileReference = {
  fileId: "new-message", fileName: old.fileName, mimeType: old.mimeType,
  attachmentKind: "image", preview: "retained original", imageDataUrl: pixels,
};

test("only the approved exact actor/chat/image hash can override the old report", () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  assert.equal(patched.observedSummary, correctedDescription);
  assert.equal(patched.summaryModel, approval.correction_model);
  assert.equal(patched.manualCorrection?.approvedByUser, true);
  assert.equal(patched.visualMemory?.observedBy, approval.correction_model);
  assert.deepEqual(verifiedKatieVisualEpisode(patched), patched.visualMemory);
  assert.deepEqual(patched.observationReports, old.observationReports, "Original Qwen audit remains intact");
  assert.equal(applyTrustedVisualCorrection(old, {...approval, actor_id: "different-actor"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, source_chat_id: "different-chat"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, attachment_id: "another-file"}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, source_hash: "b".repeat(64)}), undefined);
  assert.equal(applyTrustedVisualCorrection(old, {...approval, approved_by_user: false}), undefined);
  assert.equal(applyTrustedVisualCorrection({...old, visualMemory: undefined}, approval), undefined);
});

test("canonical sync writes only changed approved records, and remains idempotent", async () => {
  let writes = 0;
  const writer = async (_before: ConversationAttachment, after: ConversationAttachment) => {
    writes++;
    assert.equal(after.visualMemory?.sourceHash, hash);
  };
  const list = async () => [approval];
  const first = await reconcileActorVisualCorrections(actor, [old], writer, list);
  assert.equal(first[0].observedSummary, correctedDescription);
  assert.equal(writes, 1);
  const second = await reconcileActorVisualCorrections(actor, first, writer, list);
  assert.equal(second[0].observedSummary, correctedDescription);
  assert.equal(writes, 1);
  const wrong = await reconcileActorVisualCorrections(actor, [{...old, id: "different-id"}], writer, list);
  assert.equal(wrong[0].observedSummary, old.observedSummary);
  assert.equal(writes, 1);
});

test("look again challenges use the corrected image memory; no Qwen, Venice or premium dispatch", async () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  // The old Qwen report intentionally comes first to exercise override priority.
  assert.equal(reusableImageObservation(image, [old, patched], "A foot? Look again, you are confused")?.observedSummary, correctedDescription);
  let paidCalls = 0;
  const observed = await observeStandaloneStillImages([image], {
    question: "A foot? Look again, you are confused",
    saved: [old, patched],
    qwen: async () => { paidCalls++; throw Error("Qwen must not be dispatched"); },
    venice: async () => { paidCalls++; throw Error("Venice must not be dispatched"); },
    escalate: async () => { paidCalls++; throw Error("Premium vision must not be dispatched"); },
  });
  assert.equal(paidCalls, 0);
  assert.equal(observed.get(image.fileId)?.observedSummary, correctedDescription);
  assert.equal(observed.get(image.fileId)?.summaryModel, approval.correction_model);
  assert.equal(reusableImageObservation({...image, imageDataUrl: "data:image/png;base64,different"}, [patched], "look again"), undefined);
});

test("explicit original-pixel reinspection remains possible when deliberately requested", async () => {
  const patched = applyTrustedVisualCorrection(old, approval)!;
  let qwenCalls = 0;
  const result = await observeStandaloneStillImages([image], {
    question: "Please run Qwen and inspect the original pixels",
    saved: [patched], deferEscalation: true,
    qwen: async () => { qwenCalls++; return {model: "runpod:Qwen/Qwen3-VL-8B-Instruct", coverage: "full", text: "This new inspection describes a different subject in the frame."}; },
  });
  assert.equal(qwenCalls, 1);
  assert.match(result.get(image.fileId)?.observedSummary??"", /new inspection/);
});
