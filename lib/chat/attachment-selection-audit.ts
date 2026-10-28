import { explicitlyReferencesAttachment, requestedAttachmentKind, type ConversationAttachment } from "./attachment-continuity";
import { rankAttachmentCandidates, type AttachmentDecision } from "./attachment-selection";
import type { Message } from "@/lib/types/chat";

// Service-role-only diagnostic evidence. No image bytes, source summaries,
// complete user messages, or provider credentials are written.
export function buildAttachmentSelectionAudit(input: {
  actorId: string;
  chatId: string;
  requestId: string;
  message: string;
  decision: AttachmentDecision;
  catalog: ConversationAttachment[];
  history: Message[];
  sourceIds: Set<string>;
  newUploadCount: number;
  activeProjectText: string | null;
}) {
  const { message, decision, catalog, history } = input;
  const candidates = rankAttachmentCandidates(
    [message, input.activeProjectText].filter(Boolean).join("\n"), catalog, history);
  const rationale = decision.rationale?.trim().slice(0, 400) || null;
  return {
    actor_id: input.actorId,
    chat_id: input.chatId,
    request_id: input.requestId,
    selection_method: decision.method,
    selector_rationale: decision.method === "summary-selector" ? rationale : null,
    context_signals: {
      new_upload_count: input.newUploadCount,
      saved_catalog_count: catalog.length,
      requested_attachment_kind: requestedAttachmentKind(message),
      active_project_context: Boolean(input.activeProjectText),
    },
    selected_files: decision.selections.map(({ attachment, mode }) => ({
      attachment_id: attachment.id,
      source_chat_id: attachment.chatId ?? input.chatId,
      filename: attachment.fileName.slice(0, 160),
      mime_type: attachment.mimeType,
      selected_mode: mode,
      source_available: mode === "source" && input.sourceIds.has(attachment.id),
      summary_coverage: attachment.summaryCoverage ?? null,
      candidate_rank: candidates.findIndex(file => file.id === attachment.id) + 1,
      explicitly_referenced: explicitlyReferencesAttachment(message, attachment),
      filename_in_request: Boolean(attachment.fileName && message.toLowerCase().includes(attachment.fileName.toLowerCase())),
    })),
  };
}
