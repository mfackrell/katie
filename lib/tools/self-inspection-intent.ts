/**
 * Self-inspection is privileged execution, not general conversation understanding.
 * Require explicit source/operations terminology or a direct opening request to inspect Katie.
 * Do not infer tool intent from separate words in a pasted transcript.
 */
export function isExplicitKatieSelfInspectionRequest(message: string): boolean {
  const mentionsKatie = /\b(?:your(?:self| own)?|katie(?:'s)?)\b/i.test(message);
  if (!mentionsKatie) return false;
  const technical = /\b(?:repository|repo|github|source|codebase|architecture|routing|deployment|logs?|implementation|inspect|debug|fix|edit|modify)\b/i.test(message);
  const direct = /^\s*(?:(?:hey|hi)\s+katie[,!.]?\s*)?(?:(?:can|could|would|will)\s+you\s+|(?:please\s+)?)?(?:see|view|inspect|examine|look at|access)\s+(?:yourself|your own (?:system|self|implementation|code)|katie(?:'s)?\s+(?:system|code|implementation))\b/i.test(message);
  return technical || direct;
}
