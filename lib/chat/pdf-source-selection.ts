import { hasUploadDateReference, prepareMemoryQuery } from "@/lib/media-memory/evidence";
import { isPdfContentRequest } from "@/lib/uploads/pdf-inventory";
import type { ConversationAttachment } from "./attachment-continuity";
import type { EvidenceHit } from "@/lib/media-memory/evidence";
import type { FileReference } from "@/lib/providers/types";
import type { AttachmentDecision } from "./attachment-selection";

type NamedPdf = { fileName: string; mimeType: string };
type PdfNames = { names: Set<string>; explicit: boolean; clarification?: string };
const sourceClarification = "I could not resolve the complete PDF filename. Quote the full filename or select the intended source.";

/** A space is legal inside a filename; it is not itself a source boundary. */
function filenamePrefix(prefix: string): boolean {
  const clause = prefix.split(/[\n;!?]/).at(-1)!.trim().replace(/^[,\s([{]+/, "");
  if (!clause) return true;
  const request = clause.replace(/^(?:(?:please|can you|could you|would you|i need you to|i want you to)\s+)+/i, "");
  // Direct-object references may have task syntax before the full name, but
  // unknown filename modifiers (e.g. "quarterly") must not be discarded.
  if (/^(?:read|review|inspect|analy[sz]e|summari[sz]e|compare|open|use|check|examine|process|and|with|versus|vs\.?|against|then)(?:\s+(?:only|also|both|the|my|this|that|attached|uploaded|saved|original|pdf|file|document|named|called))*\s*$/i.test(request)) return true;
  // In a content question, the preposition introduces the source, not a
  // suffix of a direct-object filename. Ambiguous other wording clarifies.
  return /^(?:what|where|which|how|why|when|does|did|is|are|tell me|find|locate)\b[\s\S]*\b(?:in|inside|within|from|of|for|about)\s+(?:(?:the|my|this|that|attached|uploaded|saved|pdf|file|document)\s+)*$/i.test(request + " ");
}

/** Shared exact-span resolver for stored sources and fresh-upload scope. */
export function resolvePdfNames(message: string, files: NamedPdf[]): PdfNames {
  const available = [...new Set(files.filter(file=>file.mimeType === "application/pdf").map(file=>file.fileName))].sort((a,b)=>b.length-a.length);
  const names = new Set<string>();
  const spans: Array<{start:number;end:number}> = [];
  let explicit = false;
  for (const pattern of [/"([^"\n]+\.pdf)"/gi, /“([^”\n]+\.pdf)”/gi, /'([^'\n]+\.pdf)'/gi, /‘([^’\n]+\.pdf)’/gi, /`([^`\n]+\.pdf)`/gi, /«([^»\n]+\.pdf)»/gi]) {
    for (const match of message.matchAll(pattern)) {
      if (spans.some(span=>match.index! >= span.start && match.index! < span.end)) continue;
      explicit = true;
      const name = available.find(value=>value.toLowerCase() === match[1].toLowerCase());
      if (!name) return {names,explicit,clarification:sourceClarification};
      names.add(name.toLowerCase());spans.push({start:match.index!,end:match.index!+match[0].length});
    }
  }
  let precedingEnd = 0;
  for (const extension of message.matchAll(/\.pdf\b/gi)) {
    const end = extension.index! + extension[0].length;
    const quoted = spans.find(span=>extension.index! >= span.start && end <= span.end);
    if (quoted) { precedingEnd=quoted.end;continue; }
    explicit = true;
    const name = available.find(value=>end >= value.length && message.slice(end-value.length,end).toLowerCase()===value.toLowerCase());
    const suffix = message.slice(end);
    if (!name || !/^(?:$|[\s,;:!?)}\]]|\.(?:\s|$)|['’]s\b)/u.test(suffix)
      || !filenamePrefix(message.slice(precedingEnd,end-name.length))) return {names,explicit,clarification:sourceClarification};
    names.add(name.toLowerCase());precedingEnd=end;
  }
  return {names,explicit};
}

export type FreshPdfSelection = { fileIds: Set<string>; clarification?: string };
/** Select once before restoration, classifiers, native analysis, and synthesis. */
export function selectFreshPdfSources(message: string, fresh: FileReference[]): FreshPdfSelection | null {
  const pdfs = fresh.filter(file=>file.mimeType === "application/pdf");
  if (!pdfs.length) return null;
  const none = (clarification?:string):FreshPdfSelection => ({fileIds:new Set(),...(clarification?{clarification}:{})});
  if (!isPdfContentRequest(message)) return none();
  const literal = resolvePdfNames(message,pdfs);
  if (literal.clarification) return none(literal.clarification);
  const wholeSet = /\b(?:all|both|each|every)\s+(?:(?:of\s+)?(?:the|these|attached|uploaded|other)\s+)*(?:pdfs?|files?|documents?|attachments?)\b/i.test(message);
  if (wholeSet && /\b(?:only|except|excluding|ignore|not|without)\b/i.test(message)) return none("The PDF selection includes conflicting or excluded sources. Specify the full filenames to inspect.");
  const chosen = literal.explicit && !wholeSet ? pdfs.filter(file=>literal.names.has(file.fileName.toLowerCase())) : pdfs;
  if (chosen.some(file=>chosen.some(other=>other.fileId !== file.fileId && other.fileName.toLowerCase() === file.fileName.toLowerCase())))
    return none("Several uploaded PDFs have the same filename. Select the intended source before I inspect it.");
  const all = /\b(?:compare|both|all|each)\b|\bevery\s+(?:attached\s+)?(?:pdf|file|document)\b/i.test(message);
  if (!literal.explicit && chosen.length > 1 && !all) return none("Which uploaded PDF should I inspect? Name one source, or ask to inspect all of them.");
  return {fileIds:new Set(chosen.map(file=>file.fileId))};
}

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
  const literal = resolvePdfNames(message,allPdfs);
  if (literal.clarification) return {method:"none",selections:[],clarification:literal.clarification};
  const literalNames = literal.names;
  const named = pdfs.filter(file => literalNames.has(file.fileName.toLowerCase()));
  // A date constraint can disambiguate duplicate names, but cannot substitute
  // another filename or silently drop one of several explicitly named sources.
  if ([...literalNames].some(name => !named.some(file => file.fileName.toLowerCase() === name)))
    return {method:"none",selections:[],clarification:"The explicitly named PDF does not match that upload-date range. Select the intended source or give a different date range."};
  let matched = literalNames.size ? named : pdfs.filter(file => hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!matched.length && /\b(?:saved|uploaded|my|the|that|this)\s+pdf\b/i.test(message)) matched = pdfs;
  if (!matched.length) return dateScoped ? {method:"none",selections:[],clarification:"No saved PDF matches that upload-date range. Select the intended source or give a different date range."} : null;
  if (matched.length > 1) return { method: "none", selections: [], clarification: `Which PDF source do you mean? ${matched.slice(0, 5).map(file => `${file.fileName} (chat ${file.chatId}, attachment ${file.id})`).join("; ")}` };
  return { method: "none", selections: [{ attachment: matched[0], mode: "source" }] };
}
