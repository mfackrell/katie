/** Cheap routing only. No renderer, storage client or model is loaded by this module. */
export function documentRequest(message: string): { pages?: number } | null {
  if (/^\s*(?:explain\b|how\s+(?:do|does|can|to)\b|what\s+(?:is|are)\b)/i.test(message) ||
      /\b(?:do not|don't|never)\s+(?:create|produce|generate|make|export|save|convert)\b/i.test(message)) return null;
  // Format references used as INPUT must not turn PDF analysis into file production.
  const output = message.replace(/\b(?:attached|uploaded|source|existing|this|that)\s+(?:pdf|docx|word (?:document|file))\b/gi, 'source attachment');
  const production = /\b(?:create|produce|generate|prepare|format|make|deliver|export|save|convert|build|give\s+me)\b([^.!?\n]{0,120})\b(?:docx|word (?:document|file|version|copy)|pdf)\b/i.exec(output);
  const explicitOutput = /\b(?:as|in|into|to)\s+(?:a\s+)?(?:docx|word (?:document|file|version|copy)|pdf)\b/i.test(output);
  if (!production || !explicitOutput && /\b(?:recommendations|advice|risks|explain|how to|about|source attachment)\b/i.test(production[1])) return null;
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
  const start = value.replace(/[\u2018\u2019]/g, "'").trim().slice(0, 600);
  if (!start || /^(?:#{1,3}\s|[-*+]\s|CLARIFICATION_REQUIRED:)/i.test(start)) return false;
  const introduction = start.split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  return /^(?:sorry[\s,.!:—-]*)?(?:i\s+(?:can't|cannot|can not|am unable to|don't have|do not have)|as an? (?:text-based )?(?:ai|language model)\b|unfortunately\b)/i.test(introduction)
    && /\b(?:create|generate|render|produce|download|provide|attach|make|format)\b/i.test(introduction)
    && /\b(?:word|pdf|docx|files?|documents?)\b/i.test(introduction)
    && !/\b(?:content policy|violates? (?:our )?policy|unsafe|illegal|prohibited)\b/i.test(introduction);
}

export const DOCUMENT_DRAFT_GUIDANCE = `DOCUMENT PRODUCTION STAGE: Katie has a shared DOCX/PDF generation, rendering, visual inspection, correction and private download service. You are preparing its content, not delivering the files yourself. NEVER claim that you cannot create or deliver Word/PDF files: Katie's separate document service does that after you write the content. Return ONLY the complete document content in Markdown: headings, paragraphs, bullets and simple tables. No preamble, download links, code fences, claims of inspection or instructions to paste into Word. The service will format this content, check page count, render actual files, inspect and deliver them after content review. Use only supplied facts; never invent credentials, employers, dates, metrics or achievements. If essential facts are missing, return a single question starting CLARIFICATION_REQUIRED: instead of a document. Do not shorten or omit supplied content merely to meet a page limit. Do not include a decorative rule or an artificial page marker.`;

export const DOCUMENT_REVIEW_GUIDANCE = `This is the content-review stage of a document production workflow. Review the draft's factual accuracy, completeness and suitability as document CONTENT. Real DOCX/PDF generation, rendering, visual inspection, page-count validation and secure delivery run after this review. Do not add preambles, download links, formatting instructions or claims about files to the content. Missing files at this intermediate stage are not a content defect. If clarification is essential, begin CLARIFICATION_REQUIRED:.`;
