import { hasUploadDateReference, prepareMemoryQuery } from "@/lib/media-memory/evidence";
import { isPdfContentRequest, maskPdfSourceNames } from "@/lib/uploads/pdf-inventory";
import type { ConversationAttachment } from "./attachment-continuity";
import type { EvidenceHit } from "@/lib/media-memory/evidence";
import type { FileReference } from "@/lib/providers/types";
import type { AttachmentDecision } from "./attachment-selection";

type NamedPdf = { fileName: string; mimeType: string };
type PdfNames = { names: Set<string>; explicit: boolean; clarification?: string; scopeText?: string; sourceSpans?: Array<{start:number;end:number;name:string}> };
const sourceClarification = "I could not resolve the complete PDF filename. Quote the full filename or select the intended source.";

/** A space is legal inside a filename; it is not itself a source boundary. */
function filenamePrefix(prefix: string): boolean {
  const clause = prefix.split(/\bbut\b|[\n;!?]/i).at(-1)!.trim().replace(/^[,\s([{]+/, "");
  if (!clause) return true;
  const request = clause.replace(/^(?:(?:please|can you|could you|would you|i need you to|i want you to)\s+)+/i, "")
    .replace(/^(?:do not|don['’]t|never)\s+/i, "");
  // Page qualifiers between exact filenames are task syntax, not filename
  // prefixes. Physical-page validity is checked after identity selection.
  const pages = String.raw`(?:physical\s+)?pages?\s+\d+(?:\s*(?:[-–—]|to\b|through\b)\s*\d+)?(?:\s*(?:,\s*(?:and\b)?|and\b)\s*\d+(?:\s*(?:[-–—]|to\b|through\b)\s*\d+)?)*`;
  const connector = String.raw`(?:with|to|and|versus|vs\.?|against)`;
  if (new RegExp(String.raw`^(?:on\s+)?${pages}\s+${connector}(?:\s+(?:the|my|this|that|attached|uploaded|saved|original|new|fresh|current|previous|earlier|older|historical|version|copy|of|pdfs?|files?|documents?|named|called))*\s*$`, "i").test(request) ||
      new RegExp(String.raw`^${connector}\s+${pages}\s+(?:of|in|from)\s*$`, "i").test(request)) return true;
  // Direct-object references may have task syntax before the full name, but
  // unknown filename modifiers (e.g. "quarterly") must not be discarded.
  if (/^(?:read|review|inspect|ocr|transcribe|scan|find|locate|show|analy[sz]e|summari[sz]e|compare|open|use|check|examine|describe|audit|look at|look through|look over|process|and|with|to|versus|vs\.?|against|then)(?:\s+(?:only|also|both|the|my|this|that|attached|uploaded|saved|original|new|fresh|current|previous|earlier|older|historical|version|copy|of|pdfs?|files?|documents?|named|called))*\s*$/i.test(request)) return true;
  // In a content question, the preposition introduces the source, not a
  // suffix of a direct-object filename. Ambiguous other wording clarifies.
  return /^(?:what|where|which|how|why|when|does|did|is|are|tell me|find|locate|calculate|sum|total|summari[sz]e|extract|explain|interpret|reconcile|analy[sz]e|review|inspect|read|compare)\b[\s\S]*\b(?:in|inside|within|from|of|for|about)\s+(?:(?:the|my|this|that|attached|uploaded|saved|pdfs?|files?|documents?)\s+)*$/i.test(request + " ");
}

/** Shared exact-span resolver for stored sources and fresh-upload scope. */
export function resolvePdfNames(message: string, files: NamedPdf[]): PdfNames {
  const available = [...new Set(files.filter(file=>file.mimeType === "application/pdf").map(file=>file.fileName))].sort((a,b)=>b.length-a.length);
  const names = new Set<string>();
  const spans: Array<{start:number;end:number;name:string}> = [];
  let explicit = false;
  for (const pattern of [/"([^"\n]+\.pdf)"/gi, /“([^”\n]+\.pdf)”/gi, /'([^'\n]+\.pdf)'/gi, /‘([^’\n]+\.pdf)’/gi, /`([^`\n]+\.pdf)`/gi, /«([^»\n]+\.pdf)»/gi]) {
    for (const match of message.matchAll(pattern)) {
      if (spans.some(span=>match.index! >= span.start && match.index! < span.end)) continue;
      explicit = true;
      const name = available.find(value=>value.toLowerCase() === match[1].toLowerCase());
      if (!name) return {names,explicit,clarification:sourceClarification};
      names.add(name.toLowerCase());spans.push({start:match.index!,end:match.index!+match[0].length,name:name.toLowerCase()});
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
    names.add(name.toLowerCase());spans.push({start:end-name.length,end,name:name.toLowerCase()});precedingEnd=end;
  }
  const orderedSpans = [...spans].sort((a,b)=>a.start-b.start);
  const prohibited = new Set<string>(), permitted = new Set<string>();
  for (const [index,span] of orderedSpans.entries()) {
    const before = message.slice(index ? orderedSpans[index-1].end : 0,span.start)
      .split(/\b(?:but|and|then)\b|[;!?\n]/i).at(-1)!;
    const negative = /\b(?:do\s+not|don['’]t|never)\s+(?:read|review|inspect|ocr|transcribe|scan|analy[sz]e|summari[sz]e|compare|open|use|check|examine|describe|audit|process)(?:\s+(?:the|my|this|that|attached|uploaded|saved|new|fresh|current|previous|earlier|older|historical|version|copy|of|pdf|file|document))*\s*$/i.test(before);
    const outputConstraint = new Set(orderedSpans.map(item=>item.name)).size===1 &&
      /\b(?:do\s+not|don['’]t|never)\s+summari[sz]e\b/i.test(before) && isPdfContentRequest(message,available);
    (negative && !outputConstraint ? prohibited : permitted).add(span.name);
  }
  if ([...prohibited].some(name=>permitted.has(name)))
    return {names:new Set(),explicit,clarification:"The same PDF is both requested and prohibited. Specify only the sources to inspect."};
  for (const name of prohibited) names.delete(name);
  const scopeText = [...spans].sort((a,b)=>b.start-a.start).reduce((text,span)=>text.slice(0,span.start)+" __PDF_SOURCE__ "+text.slice(span.end),message);
  // All validated filenames, including unquoted names, are data. Apply
  // source exclusions only after masking their complete spans.
  if (/\b(?:except|excluding|exclude|ignore|not|without)\s+(?:(?:only|the|my|this|that|these|those|both|any|all|other|attached|uploaded|saved)\s+)*(?:__PDF_SOURCE__|pdfs?|files?|documents?)\b/i.test(scopeText))
    return {names:new Set(),explicit,clarification:"The PDF selection includes excluded sources. Specify only the full filenames to inspect."};
  return {names,explicit,scopeText,sourceSpans:[...spans].sort((a,b)=>a.start-b.start)};
}

function pdfNameRoles(message:string,literal:PdfNames) {
  const freshNames = new Set<string>(), savedNames = new Set<string>();
  const mentions:Array<{name:string;role:"fresh"|"saved"}>=[];
  let finalDateQualifier=false;
  const spans=literal.sourceSpans ?? [];
  for(const [index,span] of spans.entries()) {
    if (!literal.names.has(span.name)) continue;
    const before=message.slice(index ? spans[index-1].end : 0,span.start);
    const after=message.slice(span.end,spans[index+1]?.start ?? message.length).split(/\b(?:and|with|but|versus|against)\b|[;?!\n]/i)[0];
    const savedQualifier=/\b(?:saved|original|previous|earlier|older|historical)(?:\s+(?:pdfs?|files?|documents?|copy|version))?(?:\s+of)?\s*$/i.test(before);
    const datedQualifier=/^\s+(?:(?:(?:(?:that|which)\s+)?I\s+|(?:that|which)\s+)?(?:uploaded|saved|attached)\s+|from\s+(?=(?:yesterday|last\s+week|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago)\b))/i.test(after) && hasUploadDateReference(after);
    if(index===spans.length-1) finalDateQualifier=datedQualifier;
    const role=savedQualifier || datedQualifier ? "saved" : "fresh";
    mentions.push({name:span.name,role});
    if(role==="saved") savedNames.add(span.name);
    else freshNames.add(span.name);
  }
  if(finalDateQualifier && /\b(?:both|all|each)\s+__PDF_SOURCE__/i.test(literal.scopeText ?? "")) {
    for(const name of literal.names) savedNames.add(name);
    freshNames.clear();
    for(const mention of mentions) mention.role="saved";
  }
  return {freshNames,savedNames,mentions};
}

/** Trusted route metadata binds a retained identity to its filename occurrence. */
export function pdfSourceOccurrence(message:string,name:string,files:NamedPdf[],role:"fresh"|"saved"):number|undefined {
  const literal=resolvePdfNames(message,files);
  if(literal.clarification) return undefined;
  const mentions=pdfNameRoles(message,literal).mentions.filter(item=>item.name===name.toLowerCase());
  const matches=mentions.flatMap((item,index)=>item.role===role?[index]:[]);
  return matches.length===1?matches[0]:undefined;
}

export type FreshPdfSelection = { fileIds: Set<string>; clarification?: string };
/** Select once before restoration, classifiers, native analysis, and synthesis. */
export function selectFreshPdfSources(message: string, fresh: FileReference[], timelineActive = false, saved: NamedPdf[] = []): FreshPdfSelection | null {
  const pdfs = fresh.filter(file=>file.mimeType === "application/pdf");
  if (!pdfs.length) return null;
  const none = (clarification?:string):FreshPdfSelection => ({fileIds:new Set(),...(clarification?{clarification}:{})});
  // The chat composer uses "[file]" for a turn consisting solely of a fresh
  // upload. It is an explicit current-file handoff, not an empty text query
  // and never permission to retrieve similarly named historical sources.
  // Scope the sole attached PDF by immutable fileId; ambiguous batches must
  // ask which file instead of silently inspecting or dropping all content.
  if (/^\\s*\\[(?:file|files)\\]\\s*$/i.test(message)) {
    return fresh.length === 1 && pdfs.length === 1
      ? {fileIds:new Set([pdfs[0].fileId])}
      : none("Several files were attached. Which one should I inspect?");
  }
  if (!isPdfContentRequest(message,[...pdfs,...saved].map(file=>file.fileName))) return none();
  const literal = resolvePdfNames(message,[...pdfs,...saved]);
  if (literal.clarification) return none(literal.clarification);
  const scopeText = literal.scopeText ?? message;
  // A set qualified by another source ("documents in the video") is not
  // the uploaded set. Only unqualified or explicitly upload-scoped sets widen it.
  const setScopes = [...scopeText.matchAll(/\b(?:all|both|each|every)\s+(?:(?:of\s+)?(?:the|these|attached|uploaded|other)\s+)*(?:pdfs?|files?|documents?|attachments?)\b/gi)].map(match => {
    const suffix = scopeText.slice(match.index! + match[0].length);
    // Post-nominal current-upload qualifiers refer to these inputs, not another
    // source. Keep this fact for mixed media as well as explicitly named PDFs.
    const currentUpload = /^\s+(?:in|inside|within|from|of)\s+(?:(?:this|(?:the |my )?current)\s+(?:upload(?:\s+batch)?|attachment\s+(?:batch|set))|(?:these|the current)\s+attachments?)\b(?=\s*(?:$|[,;.!?)]|(?:and|then|to|for|that|which|so|as|using|with|without|while)\b))/i.test(suffix);
    const external = /^\s+(?:in|inside|within|from|of|shown|visible|depicted|displayed|mentioned|discussed|contained|appearing|stored|that|which)\b/i.test(suffix);
    return {whole:currentUpload || !external, uploaded:currentUpload || /\b(?:attached|uploaded)\b|\b(?:all|both)\s+(?:files|attachments)\b/i.test(match[0])};
  });
  const wholeSet = setScopes.some(scope=>scope.whole);
  // A named non-PDF input is already a source choice, not an invitation to
  // ask about or analyze neighboring PDFs in the same upload batch.
  const namesNonPdf = fresh.some(file=>file.mimeType !== "application/pdf" && message.toLowerCase().includes(file.fileName.toLowerCase()));
  const targetsNonPdfKind = /\b(?:videos?|clips?|recordings?|audio|sounds?|images?|photos?|pictures?|screenshots?|spreadsheets?|workbooks?|csv|text\s+files?|notes)\b/i.test(message);
  // Content nouns such as "statements" in a video are not PDF source targets.
  const targetsPdfKind = /\bpdfs?\b/i.test(scopeText);
  const allUploadedSources = setScopes.some(scope=>scope.whole && scope.uploaded);
  if (!literal.explicit && !targetsPdfKind && !allUploadedSources && (namesNonPdf || targetsNonPdfKind || timelineActive)) return none();
  if (wholeSet && /\b(?:only|except|excluding|exclude)\b/i.test(scopeText)) return none("The PDF selection includes conflicting or excluded sources. Specify the full filenames to inspect.");
  const freshNamed = pdfNameRoles(message,literal).freshNames;
  const genericHistoricalDate=/\b(?:pdfs?|files?|documents?)\s+(?:(?:(?:(?:that|which)\s+)?I\s+|(?:that|which)\s+)?(?:uploaded|saved|attached)\s+|from\s+(?=(?:yesterday|last\s+week|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago)\b))/i.test(scopeText) && hasUploadDateReference(scopeText);
  if (!literal.explicit && ((!wholeSet && /\b(?:saved|original|previous|earlier|older|historical)\s+(?:pdfs?|files?|documents?)\b/i.test(scopeText)) || genericHistoricalDate) &&
      !/\b(?:new|current|fresh|attached|this)\s+(?:pdfs?|files?|documents?|upload)\b/i.test(scopeText)) return none();
  const excludedNames = new Set((literal.sourceSpans ?? []).filter(span=>!literal.names.has(span.name)).map(span=>span.name));
  const chosen = (literal.explicit && !wholeSet ? pdfs.filter(file=>literal.names.has(file.fileName.toLowerCase()) && freshNamed.has(file.fileName.toLowerCase())) : pdfs).filter(file=>!excludedNames.has(file.fileName.toLowerCase()));
  if (chosen.some(file=>chosen.some(other=>other.fileId !== file.fileId && other.fileName.toLowerCase() === file.fileName.toLowerCase())))
    return none("Several uploaded PDFs have the same filename. Select the intended source before I inspect it.");
  const all = wholeSet || /\b(?:these|those|the\s+(?:attached|uploaded|current))\s+(?:pdfs|files|documents|attachments)\b|\bcompare\s+(?:(?:both|all)\s+)?them\b/i.test(scopeText);
  if (!literal.explicit && chosen.length > 1 && !all) return none("Which uploaded PDF should I inspect? Name one source, or ask to inspect all of them.");
  return {fileIds:new Set(chosen.map(file=>file.fileId))};
}

/** Resolve exact saved identities before generic excerpt recall can hide a new page request. */
export function selectPdfEvidenceSource(message: string, catalog: ConversationAttachment[], hits: EvidenceHit[], freshCount: number, now = new Date(), fresh: FileReference[] = []): AttachmentDecision | null {
  const knownNames=[...catalog,...fresh].filter(file=>file.mimeType==="application/pdf").map(file=>file.fileName);
  if ((freshCount && !fresh.length) || !isPdfContentRequest(message,knownNames) || /\b(repository|codebase|function|codec)\b/i.test(maskPdfSourceNames(message,knownNames))) return null;
  const freshPdfs = fresh.filter(file => file.mimeType === "application/pdf");
  const freshNames = new Set(freshPdfs.map(file=>file.fileName.toLowerCase()));
  const allPdfs = [...new Map(catalog.filter(file => file.mimeType === "application/pdf")
    .map(file=>[`${file.chatId}/${file.id}`,file])).values()];
  const relevant = /\bpdfs?\b|\.pdf\b/i.test(message) || allPdfs.some(file => message.toLowerCase().includes(file.fileName.toLowerCase()) || hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!relevant) return null;
  const literal = resolvePdfNames(message,[...allPdfs,...freshPdfs]);
  if (literal.clarification) return {method:"none",selections:[],clarification:literal.clarification};
  // Dates inside the document question do not qualify its upload identity.
  // Parse only a date clause attached to a source or an upload verb.
  const scopeText = literal.scopeText ?? message;
  const dateAnchors = [...scopeText.matchAll(/(?:__PDF_SOURCE__|\b(?:pdfs?|files?|documents?))\s+(?:(?:(?:that|which)\s+)?I\s+|(?:that|which)\s+)?(?:uploaded|saved|attached)\s+|\b(?:uploaded|saved|attached)\s+(?:(?:the|my|this|that)\s+)?(?:__PDF_SOURCE__|pdfs?|files?|documents?)\s+(?:(?:from|on|during|in)\s+)?|\b(?:uploaded|saved|attached)\s+(?!__PDF_SOURCE__|pdfs?\b|files?\b|documents?\b)|(?:__PDF_SOURCE__|\b(?:pdfs?|files?|documents?))\s+from\s+(?=(?:yesterday|last\s+week|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago)\b)/gi)];
  if (dateAnchors.length > 1) return {method:"none",selections:[],clarification:"This comparison gives multiple source-specific upload dates. Select each PDF version separately, or specify one shared upload-date range before comparing them."};
  const dateAnchor = dateAnchors[0];
  const dateText = dateAnchor ? scopeText.slice(dateAnchor.index + dateAnchor[0].length)
    .split(/\b(?:and|but|then|about|showing|containing|with)\b|[;?!\n]/i)[0] : "";
  const dateScoped = hasUploadDateReference(`from ${dateText}`);
  const date = dateScoped ? prepareMemoryQuery(`from ${dateText}`, now) : null;
  if (date?.clarification) return {method:"none",selections:[],clarification:date.clarification};
  const sourceTokens = [...scopeText.matchAll(/__PDF_SOURCE__/g)];
  const qualifiedToken = dateAnchor ? sourceTokens.findIndex(token => token.index >= dateAnchor.index && token.index < dateAnchor.index + dateAnchor[0].length) : -1;
  const sharedDate = qualifiedToken === sourceTokens.length - 1 && /\b(?:both|all|each)\s+__PDF_SOURCE__/i.test(scopeText);
  const datedName = qualifiedToken >= 0 && !sharedDate
    ? literal.sourceSpans?.[qualifiedToken]?.name : undefined;
  const excludedNames = new Set((literal.sourceSpans ?? []).filter(span=>!literal.names.has(span.name)).map(span=>span.name));
  const pdfs = allPdfs.filter(file => {
    if (excludedNames.has(file.fileName.toLowerCase())) return false;
    if (!dateScoped || (datedName && file.fileName.toLowerCase() !== datedName)) return true;
    const created = Date.parse(file.createdAt ?? "");
    return Number.isFinite(created) && (!date?.after || created >= Date.parse(date.after)) && (!date?.before || created < Date.parse(date.before));
  });
  const literalNames = new Set([...literal.names].filter(name=>!freshNames.has(name)));
  const requestedSavedNames = new Set([...literalNames,...(freshCount ? pdfNameRoles(message,literal).savedNames : [])]);
  // A fresh upload is not permission to restore arbitrary old PDFs. Explicit
  // saved names still join the comparison alongside independently scoped uploads.
  const genericMixedPdf = freshCount>0 && !freshPdfs.length && /\b(?:my|the|that|this)\s+pdfs?\b/i.test(scopeText);
  const requestsSavedSource = genericMixedPdf || /\b(?:saved|original|previous|earlier|older|historical)\s+(?:__PDF_SOURCE__|pdfs?|files?|documents?)\b/i.test(scopeText) || dateScoped;
  if (freshCount && !requestedSavedNames.size && !requestsSavedSource) return null;
  const named = pdfs.filter(file => requestedSavedNames.has(file.fileName.toLowerCase()));
  // A date constraint can disambiguate duplicate names, but cannot substitute
  // another filename or silently drop one of several explicitly named sources.
  if ([...requestedSavedNames].some(name => !named.some(file => file.fileName.toLowerCase() === name)))
    return {method:"none",selections:[],clarification:"The explicitly named PDF does not match that upload-date range. Select the intended source or give a different date range."};
  let matched = requestedSavedNames.size ? named
    : pdfs.filter(file => hits.some(hit => hit.attachment_id === file.id && hit.source_chat_id === file.chatId));
  if (!matched.length && (requestsSavedSource || /\b(?:saved|uploaded|my|the|that|this)\s+pdfs?\b/i.test(message))) matched = pdfs;
  if (!matched.length) return requestsSavedSource || dateScoped ? {method:"none",selections:[],clarification:"No saved PDF matches that upload-date range. Select the intended source or give a different date range."} : null;
  const duplicateIdentity = matched.some(file=>matched.some(other=>other!==file && other.fileName.toLowerCase()===file.fileName.toLowerCase()));
  const allSavedSources=/\b(?:all|both|each|every)\s+(?:(?:the|my|saved|uploaded|previous|earlier|older|historical)\s+)*(?:pdfs|files|documents)\b/i.test(scopeText);
  if(allSavedSources && matched.length>5) return {method:"none",selections:[],clarification:"Select up to five saved PDFs for this comparison, then continue with the remaining sources."};
  if (matched.length > 1 && !allSavedSources && (!requestedSavedNames.size || duplicateIdentity)) return { method: "none", selections: [], clarification: `Which PDF source do you mean? ${matched.slice(0, 5).map(file => `${file.fileName} (chat ${file.chatId}, attachment ${file.id})`).join("; ")}` };
  return { method: "none", selections: matched.map(attachment=>({ attachment, mode: "source" })) };
}
