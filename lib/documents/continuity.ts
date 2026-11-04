/**
 * Explicit, same-document continuity. This is a user-source ledger, not model
 * memory: assistant text, unrelated turns and generic "again" are insufficient.
 */
export type DocumentContract = {
  identity: string;
  pages?: number;
  sourceUserMessageId: string;
  sourceMessageId?: string;
  provenance: 'current-user' | 'inherited-user';
};
const identityTerms = [
  ['resume', /\b(?:resume|résumé|cv|curriculum vitae)\b/i],
  ['financial-report', /\b(?:financial|quarterly|operating)\s+report\b/i],
  ['agreement', /\b(?:agreement|contract|statement of work)\b/i],
  ['proposal', /\bproposal\b/i],
  ['letter', /\bletter\b/i],
] as const;
export function documentIdentity(message: string): string | null {
  return identityTerms.find(([, pattern])=>pattern.test(message))?.[0] ?? null;
}
export function resolveDurableDocumentRequest(
  message: string, request: {pages?:number}|null,
  previous: DocumentContract | undefined,
  sourceMessageId?: string | null,
): {request:{pages?:number}|null; contract: DocumentContract | undefined} {
  if (!request) return {request,contract:previous};
  const identity = documentIdentity(message);
  const sameSelectedSource = Boolean(previous?.sourceMessageId && sourceMessageId &&
    previous.sourceMessageId === sourceMessageId);
  const explicitNew = /\b(?:new|different|unrelated)\s+(?:document|report|resume|résumé|contract|agreement|proposal)\b/i.test(message);
  const continuation = /\b(?:again|same|retry|redo|re-?export|re-?generate|re-?create|revise|revision|update|final|reissue)\b/i.test(message);
  const same = !explicitNew && Boolean(previous &&
    (sameSelectedSource || (identity && identity===previous.identity && continuation)));
  // A different explicit saved source cannot borrow the previous document's cap.
  const changedSource = Boolean(sourceMessageId && previous?.sourceMessageId && sourceMessageId!==previous.sourceMessageId);
  const pages = request.pages ?? (same && !changedSource ? previous?.pages : undefined);
  if (request.pages!==undefined && (!Number.isInteger(request.pages) || request.pages<1 || request.pages>8))
    throw Error('Invalid explicit document page constraint.');
  const contract = identity || (same && previous) || sourceMessageId
    ? {
        identity: identity ?? previous?.identity ?? 'selected-document',
        ...(pages!==undefined?{pages}:{}),
        sourceUserMessageId: same && request.pages===undefined
          ? previous!.sourceUserMessageId : '', // route replaces with actual current user ID
        ...(sourceMessageId?{sourceMessageId}:same&&previous?.sourceMessageId?{sourceMessageId:previous.sourceMessageId}:{}),
        provenance: same && request.pages===undefined ? 'inherited-user' as const : 'current-user' as const,
      }
    : undefined;
  return {request:{...request,...(pages===undefined?{}:{pages})},contract};
}
