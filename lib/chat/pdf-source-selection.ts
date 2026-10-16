import { hasUploadDateReference, prepareMemoryQuery } from "@/lib/media-memory/evidence";
import { isPdfContentRequest } from "@/lib/uploads/pdf-inventory";
import type { ConversationAttachment } from "./attachment-continuity";
import type { EvidenceHit } from "@/lib/media-memory/evidence";
import type { AttachmentDecision } from "./attachment-selection";

/** Resolve exact saved identities before generic excerpt recall can hide a new page request. */
export function selectPdfEvidenceSource(message: string, catalog: ConversationAttachment[], hits: EvidenceHit[], freshCount: number, now = new Date()): AttachmentDecision | null {
  if (freshCount || !isPdfContentRequest(message) || /\b(repository|codebase|function|codec)\b/i.test(message)) return null;
  const allPdfs = catalog.filter(file => file.mimeType === "application/pdf");
  const relevant = /\bpdf\b|\.pdf\b/i.test(message) || allPdfs.some(file => message.toLowerCase().includes(file.fileName.toLowerCase()) || hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!relevant) return null;
  const dateScoped = hasUploadDateReference(message);
  const date = dateScoped ? prepareMemoryQuery(message, now) : null;
  if (date?.clarification) return {method:"none",selections:[],clarification:date.clarification};
  const pdfs = allPdfs.filter(file => {
    if (!dateScoped) return true;
    const created = Date.parse(file.createdAt ?? "");
    return Number.isFinite(created) && (!date?.after || created >= Date.parse(date.after)) && (!date?.before || created < Date.parse(date.before));
  });
  // Respect literal filename boundaries; report.pdf is not unknownreport.pdf.
  const escape = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = (name:string) => new RegExp(`(^|[\\s\\p{Quotation_Mark}([{])${escape(name)}(?=$|[\\s\\p{Quotation_Mark}?!,;:.)}\\]])`, "iu");
  const quoted = [...message.matchAll(/["“‘]([^"”’]+\.pdf)["”’]/gi)].map(match=>match[1].toLowerCase());
  if (quoted.some(name=>!allPdfs.some(file=>file.fileName.toLowerCase()===name))) return {method:"none",selections:[],clarification:"I could not resolve the explicitly named PDF. Select or upload that source."};
  let unnamed = message;
  for (const file of [...allPdfs].sort((a,b)=>b.fileName.length-a.fileName.length)) unnamed = unnamed.replace(mentions(file.fileName), "$1 ");
  if (/[^\s"'<>]+\.pdf\b/i.test(unnamed)) return {method:"none",selections:[],clarification:"I could not resolve the explicitly named PDF. Select or upload that source."};
  const named = pdfs.filter(file => mentions(file.fileName).test(message));
  let matched = named.length ? named : pdfs.filter(file => hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!matched.length && /\b(?:saved|uploaded|my|the|that|this)\s+pdf\b/i.test(message)) matched = pdfs;
  if (!matched.length) return dateScoped ? {method:"none",selections:[],clarification:"No saved PDF matches that upload-date range. Select the intended source or give a different date range."} : null;
  if (matched.length > 1) return { method: "none", selections: [], clarification: `Which PDF source do you mean? ${matched.slice(0, 5).map(file => `${file.fileName} (chat ${file.chatId}, attachment ${file.id})`).join("; ")}` };
  return { method: "none", selections: [{ attachment: matched[0], mode: "source" }] };
}
