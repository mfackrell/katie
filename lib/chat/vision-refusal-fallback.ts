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

/** Generic refusals are not descriptions of image pixels, even when HTTP succeeds. */
export function isGenericVisionRefusal(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return /^(?:(?:i(?:'m| am)\s+sorry[,;:]?\s*)?(?:but\s+)?(?:i\s+(?:can't|cannot|can not|won't|will not)\s+(?:assist|help|comply|provide|describe|analyze|analyse|process|fulfill|fulfil)\b|(?:sorry[,;:]?\s*)?(?:i\s+)?(?:can't|cannot|can not)\s+help\b)|(?:i\s+must\s+decline\b)|(?:i\s+cannot\s+assist\b))[\s\S]{0,240}$/i.test(normalized);
}
