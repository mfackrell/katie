/**
 * A generic provider inability is different from an explicit safety/policy
 * refusal. Only the former may trigger a second vision provider.
 */
export function isExplicitVisionPolicyRefusal(text: string): boolean {
  return /\b(?:content\s+policy|safety\s+(?:policy|guidelines?|restrictions?)|policy\s+(?:violation|restriction|prohibits?|does\s+not\s+allow)|prohibited\s+content|explicit\s+sexual\s+content|must\s+refuse|not\s+permitted|violates\s+(?:our\s+)?(?:policy|guidelines))\b/i.test(text);
}
export function selectGrokVisionFallback(models: readonly string[]): string | null {
  const eligible = models.filter(model =>
    /^grok-(?:3|4)(?:[.-]|$)/i.test(model) &&
    !/(?:imagine|image-gen|video|embedding)/i.test(model)
  );
  const preferred = eligible.find(model => /^grok-4\.7(?:[.-]|$)/i.test(model));
  return preferred ?? eligible.find(model => /^grok-4(?:[.-]|$)/i.test(model)) ??
    eligible[0] ?? null;
}

/** A refusal-only provider reply is not pixel evidence.
 * Reject only when every sentence is a refusal or canned nonvisual follow-up.
 * A limitation followed by an actual visual observation must be preserved. */
export function isGenericVisionRefusal(text: string): boolean {
  const normalized = text.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1000) return false;

  const refusal = /^(?:(?:i(?:'m| am)\s+sorry|sorry|i\s+apologize)[,;:\s-]*(?:but\s+)?)?(?:i\s+(?:(?:can't|cannot|can not|won't|will not|am unable to)\s+(?:assist|help|comply|provide|describe|analy[sz]e|process|fulfill|fulfil|answer)|must\s+decline)|i(?:'m| am)\s+unable\s+to\s+(?:assist|help|comply|provide|describe|analy[sz]e|process|fulfill|fulfil|answer))\b/i;
  const opening = normalized.match(refusal);
  if (!opening) return false;
  // A contrasting factual clause makes this a mixed answer, not a refusal-only reply.
  if (/\bbut\s+(?:a|an|the|this|that|there|it)\b/i.test(normalized.slice(opening[0].length))) return false;

  // These are grounded visual assertions even if preceded by a limitation.
  // Err toward retaining evidence when the output is mixed or ambiguous.
  const visualAssertion = /\b(?:image|photo|photograph|picture|diagram|chart|screenshot|scene|subject|foreground|background|person|woman|man|animal|object|rectangle|label|heading|text)\s+(?:shows?|depicts?|displays?|features?|contains?|includes?|has|is|are|appears?|looks?|reads?)\b|\bthere\s+(?:is|are)\s+(?:a|an|one|two|several|\d)\b/i;
  if (visualAssertion.test(normalized)) return false;

  const clauses = normalized.split(/(?:[.!?]+\s+|;\s+)+/).map(s => s.trim()).filter(Boolean);
  const cannedFollowUp = /^(?:please\s+(?:try|ask|provide|upload|rephrase)\b|i\s+(?:can|could|would)\s+(?:help|assist|offer|provide)\b|if\s+you(?:'d| would| can)\s+(?:like|prefer)\b)/i;
  return clauses.length > 0 && clauses.every((clause, index) =>
    refusal.test(clause) || (index > 0 && cannedFollowUp.test(clause))
  );
}
