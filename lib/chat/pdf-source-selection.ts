import { isPdfLocatorRequest } from "@/lib/uploads/pdf-inventory";
import type { ConversationAttachment } from "./attachment-continuity";
import type { EvidenceHit } from "@/lib/media-memory/evidence";
import type { AttachmentDecision } from "./attachment-selection";

/** Resolve exact saved identities before generic excerpt recall can hide a new page request. */
export function selectPdfEvidenceSource(message: string, catalog: ConversationAttachment[], hits: EvidenceHit[], freshCount: number): AttachmentDecision | null {
  if (freshCount || isPdfLocatorRequest(message) || /\b(repository|codebase|function|codec)\b/i.test(message)) return null;
  const pdfs = catalog.filter(file => file.mimeType === "application/pdf");
  const named = pdfs.filter(file => message.toLowerCase().includes(file.fileName.toLowerCase()));
  let matched = named.length ? named : pdfs.filter(file => hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!matched.length && /\b(?:saved|uploaded|my|the|that|this)\s+pdf\b/i.test(message)) matched = pdfs;
  if (!matched.length) return null;
  if (matched.length > 1) return { method: "none", selections: [], clarification: `Which PDF source do you mean? ${matched.slice(0, 5).map(file => `${file.fileName} (chat ${file.chatId}, attachment ${file.id})`).join("; ")}` };
  return { method: "none", selections: [{ attachment: matched[0], mode: "source" }] };
}
