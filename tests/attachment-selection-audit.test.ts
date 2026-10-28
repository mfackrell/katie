import test from "node:test";
import assert from "node:assert/strict";
import { buildAttachmentSelectionAudit } from "../lib/chat/attachment-selection-audit";
import type { ConversationAttachment } from "../lib/chat/attachment-continuity";

const image: ConversationAttachment = {
  id: "413c0025-0900-4eb9-ae92-1d6a7729bff6",
  fileName: "IMG_4449.jpeg", mimeType: "image/jpeg",
  summaryCoverage: "metadata", observedSummary: "Private source material; never stored in audit.",
  chatId: "source-chat",
};

test("audit records evidence and stated relevance without storing private inputs", () => {
  const audit = buildAttachmentSelectionAudit({
    actorId: "actor", chatId: "chat", requestId: "request",
    message: "I have not heard back on the dating app",
    catalog: [image], history: [], sourceIds: new Set([image.id]),
    newUploadCount: 0, activeProjectText: null,
    decision: {
      method: "summary-selector",
      rationale: "The prior image might relate to the dating discussion.",
      selections: [{ attachment: image, mode: "source" }],
    },
  });
  assert.equal(audit.selector_rationale, "The prior image might relate to the dating discussion.");
  assert.equal(audit.selected_files[0].candidate_rank, 1);
  assert.equal(audit.selected_files[0].source_available, true);
  assert.equal(audit.selected_files[0].explicitly_referenced, false);
  assert.equal(audit.context_signals.new_upload_count, 0);
  assert.equal(audit.selected_files[0].selected_mode, "source");
  const stored = JSON.stringify(audit);
  assert.doesNotMatch(stored, /Private source material|have not heard back/);
});

test("audit cannot promote a fallback into a model-stated explanation", () => {
  const audit = buildAttachmentSelectionAudit({
    actorId: "actor", chatId: "chat", requestId: "request",
    message: "What is in the picture?", catalog: [image], history: [],
    sourceIds: new Set(), newUploadCount: 0, activeProjectText: null,
    decision: {method: "fallback", rationale: "unsupported", selections: [{attachment: image, mode: "source"}]},
  });
  assert.equal(audit.selector_rationale, null);
  assert.equal(audit.selected_files[0].source_available, false);
  assert.equal(audit.selected_files[0].explicitly_referenced, true);
});
