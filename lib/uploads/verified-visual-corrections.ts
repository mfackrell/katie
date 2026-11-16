import type { ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { buildKatieVisualEpisode, verifiedKatieVisualEpisode } from "@/lib/chat/visual-memory";

export type TrustedVisualCorrection = {
  actor_id: string;
  source_chat_id: string;
  attachment_id: string;
  source_hash: string;
  description: string;
  correction_model: string;
  corrected_at: string;
  original_model: string;
  source_message_id: string;
  approved_by_user: boolean;
};

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** Never infer authority merely from a provider's claim or a model-generated string. */
export function hasVerifiedManualVisualCorrection(file: ConversationAttachment): boolean {
  return file.manualCorrection?.approvedByUser === true &&
    Boolean(file.summaryModel?.startsWith("manual:")) &&
    Boolean(verifiedKatieVisualEpisode(file));
}

/** This is applied only to rows read from the private, service-only correction table.
 * Exact actor, source chat, attachment and image identity must agree; unrelated images
 * cannot borrow a manual correction.
 */
export function applyTrustedVisualCorrection(
  file: ConversationAttachment, row: TrustedVisualCorrection,
): ConversationAttachment | undefined {
  if (!row.approved_by_user ||
      file.actorId !== row.actor_id ||
      file.chatId !== row.source_chat_id ||
      file.id !== row.attachment_id ||
      !file.mimeType.startsWith("image/") ||
      !HEX_SHA256.test(row.source_hash) ||
      file.observationSourceHash !== row.source_hash ||
      file.visualMemory?.sourceHash !== row.source_hash ||
      !row.correction_model.startsWith("manual:") ||
      !row.original_model.trim() ||
      !row.source_message_id.trim() ||
      row.description.trim().length < 30 ||
      row.description.length > 7000 ||
      Number.isNaN(Date.parse(row.corrected_at))) return;

  const corrected: ConversationAttachment = {
    ...file,
    observedSummary: row.description,
    summaryModel: row.correction_model,
    observationAt: row.corrected_at,
    summaryCoverage: "full",
    manualCorrection: {
      approvedByUser: true,
      correctedAt: row.corrected_at,
      correctedBy: row.correction_model,
      originalSummaryModel: row.original_model,
      sourceMessageId: row.source_message_id,
    },
    // Keep observationReports unchanged: Qwen's original output is an audit
    // trail, not the authoritative description after an approved correction.
  };
  const visualMemory = buildKatieVisualEpisode(corrected, row.source_hash, row.corrected_at);
  if (!visualMemory) return;
  return { ...corrected, visualMemory };
}
