import { isDocumentCapabilityDenial } from './intent';

/** Only an explicitly selected saved assistant message may be exported.
 * Recognizable editorial notes after a divider are not document content.
 * We never synthesize, summarize, reorder, or change the selected source. */
export function savedDocumentContent(message: {role: string; content: string} | null): string {
  if (!message || message.role!=='assistant') throw new Error('Select a saved assistant message for document export.');
  const original=message.content.trim();
  if (!original || original.length>50_000 || isDocumentCapabilityDenial(original) ||
      /^Katie could not complete this request\b/i.test(original))
    throw new Error('The selected message is not a usable document source.');
  const divider=/\r?\n\s*---\s*\r?\n(?=\s*\*\*(?:Changes made|Editorial notes|Reviewer notes|Formatting notes)\s*:)/i;
  const content=original.split(divider,1)[0].trim();
  if (!content) throw new Error('The selected message contains no document content.');
  return content;
}
