/** An explicit, user-selected source action; never infer an approved document from chat history. */
export const SAVED_DOCUMENT_EXPORT_PROMPT =
  'Export this saved response as a Word document and PDF. Preserve its wording without rewriting. Inspect the rendered pages and provide both download links.';

/** Cheap routing only. No renderer, storage client or model is loaded by this module. */
export function documentRequest(message: string): { pages?: number } | null {
  if (/^\s*(?:explain\b|how\s+(?:do|does|can|to)\b|what\s+(?:is|are)\b)/i.test(message) ||
      /\b(?:do not|don't|never)\s+(?:create|produce|generate|make|export|save|convert)\b/i.test(message)) return null;
  // Format references used as INPUT must not turn PDF analysis into file production.
  const output = message.replace(/\b(?:attached|uploaded|source|existing|this|that)\s+(?:pdf|docx|word (?:document|file))\b/gi, 'source attachment');
  const explicitOutput = /\b(?:as|in|into|to)\s+(?:a\s+)?(?:docx|word (?:document|file|version|copy)|pdf)\b/i.test(output);
  // Only an affirmative CURRENT instruction may start the document pipeline.
  // A discussion like "we are trying to get you to generate pdf's" contains
  // the same action words, but is a status report, not a generation request.
  // Inspect each candidate: an actual instruction may follow a status report.
  const requestLead = /^(?:(?:hey\s+)?katie[,:]?\s+)?(?:(?:please|now|also|just|then|kindly|go\s+ahead\s+and)\s+|(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+help\s+me(?:\s+to)?)?\s+|(?:i|we)\s+(?:want|need|would\s+like|would\s+appreciate)\s+(?:you\s+)?to\s+|(?:i['’]d|we['’]d)\s+like\s+(?:you\s+)?to\s+|let['’]s\s+|let\s+us\s+|help\s+me(?:\s+to)?\s+|you\s+(?:need\s+to|have\s+to|must|should)\s+)*$/i;
  const requested = [...output.matchAll(/\b(?:create|produce|generate|prepare|format|make|deliver|export|save|convert|build|give\s+me)\b([^.!?\n]{0,120})\b(?:docx|word (?:document|file|version|copy)|pdf)\b/gi)]
    .some(production => {
      const preceding = output.slice(0, production.index);
      const boundary = Math.max(preceding.lastIndexOf('\n'), preceding.lastIndexOf('.'),
        preceding.lastIndexOf('!'), preceding.lastIndexOf('?'), preceding.lastIndexOf(';'));
      const lead = preceding.slice(boundary + 1).trimStart();
      // Imperative lead-ins also include "Use these notes to create a PDF"
      // and "Based on the résumé, generate a PDF"; these are real requests.
      const prefacedInstruction = /^(?:please\s+)?(?:use|take)\b[^.!?\n]{1,120}\b(?:to|and)\s+$/i.test(lead) ||
        /^(?:based\s+on|using|with|from|for)\b[^.!?\n]{1,120},\s*(?:please\s+)?$/i.test(lead);
      // "Build a PDF generator" and "Make sure Katie can generate a PDF"
      // request engineering capability, not a PDF artifact.
      const capabilityTask = /\b(?:make\s+sure|able\s+to|capable\s+of|ability\s+to|capability\s+to|feature\s+(?:to|that|for)|support\s+for|tool\s+(?:to|that|for)|system\s+(?:to|that)|backend\s+(?:to|that)|pipeline\s+(?:to|that)|endpoint\s+(?:to|that)|api\s+to)\b/i.test(production[0]) ||
        /^\s*(?:generator|generation|renderer|rendering|exporter|converter|pipeline|capability|support|feature|tool|engine|code)\b/i.test(output.slice(production.index + production[0].length));
      return (requestLead.test(lead) || prefacedInstruction) && !capabilityTask &&
        (explicitOutput || !/\b(?:recommendations|advice|risks|explain|how to|about|source attachment)\b/i.test(production[1]));
    });
  if (!requested) return null;
  const count = /\b(one|two|three|four|five|six|\d+)\s*[- ]pages?\b/i.exec(message);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  return count ? { pages: words[count[1].toLowerCase()] ?? Number(count[1]) } : {};
}

export function answeredDocumentRequest(progress: {
  lastUserIntent?: string; objective: { text: string; userMessageId: string } | null;
  answered: Array<{ taskId?: string; userMessageId: string }>;
}, currentUserMessageId: string): { pages?: number } | null {
  return progress.lastUserIntent === 'answer' && progress.objective &&
    progress.answered.some(answer => answer.userMessageId === currentUserMessageId && answer.taskId === progress.objective!.userMessageId)
    ? documentRequest(progress.objective.text) : null;
}

/** Detect a model's false assertion that it cannot create files, rather than
 * treating that explanation as the user's requested document content.
 * Only examine the opening of the answer; actual document copy may discuss
 * file capabilities later without constituting a refusal. */
export function isDocumentCapabilityDenial(value: string): boolean {
  // Models sometimes echo an upstream "[Message timestamp: ...]" annotation
  // before their actual reply. It must not hide a file-capability denial.
  // Strip only explicitly recognized leading metadata, never arbitrary prose.
  let start = value.replace(/[\u2018\u2019]/g, "'").trimStart();
  for (let i = 0; i < 3; i++) {
    const next = start.replace(/^\[(?:message timestamp|timestamp|generated at):[^\]\r\n]{1,100}\]\s*/i, '').trimStart();
    if (next === start) break;
    start = next;
  }
  start = start.slice(0, 900);
  if (!start || /^(?:#{1,3}\s|[-*+]\s|CLARIFICATION_REQUIRED:)/i.test(start)) return false;
  const introduction = start.split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  return /^(?:sorry[\s,.!:—-]*)?(?:i\s+(?:can't|cannot|can not|am unable to|don't have|do not have)|as an? (?:text-based )?(?:ai|language model)\b|unfortunately\b)/i.test(introduction)
    && /\b(?:create|generate|render|produce|download|provide|attach|make|format)\b/i.test(introduction)
    && /\b(?:word|pdf|docx|files?|documents?)\b/i.test(introduction)
    && !/\b(?:content policy|violates? (?:our )?policy|unsafe|illegal|prohibited)\b/i.test(introduction);
}

export const DOCUMENT_DRAFT_GUIDANCE = `DOCUMENT PRODUCTION STAGE: Katie has a shared DOCX/PDF generation, rendering, visual inspection, correction and private download service. You are preparing its content, not delivering the files yourself. NEVER claim that you cannot create or deliver Word/PDF files: Katie's separate document service does that after you write the content. Return ONLY the complete document content in Markdown: headings, paragraphs, bullets and simple tables. No preamble, download links, code fences, claims of inspection or instructions to paste into Word. The service will format this content, check page count, render actual files, inspect and deliver them after content review. Use only supplied facts; never invent credentials, employers, dates, metrics or achievements. If essential facts are missing, return a single question starting CLARIFICATION_REQUIRED: instead of a document. Do not shorten or omit supplied content merely to meet a page limit. Do not include a decorative rule or an artificial page marker.`;

export const DOCUMENT_REVIEW_GUIDANCE = `This is the content-review stage of a document production workflow. Review the draft's factual accuracy, completeness and suitability as document CONTENT. Real DOCX/PDF generation, rendering, visual inspection, page-count validation and secure delivery run after this review. Do not add preambles, download links, formatting instructions or claims about files to the content. Missing files at this intermediate stage are not a content defect. If clarification is essential, begin CLARIFICATION_REQUIRED:.`;
