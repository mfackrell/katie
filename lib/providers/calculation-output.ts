import type { RequestIntent } from "@/lib/router/model-intent";

const CALCULATION_LIKE_REQUEST =
  /\b(calculate|calculation|arithmetic|compound interest|interest|growth rate|percentage|percent|ratio|margin|ebitda|debt|amortization|payment|distance|driving distance|travel time|drive time|miles?|hours?|minutes?|convert|conversion|estimate|estimated)\b/i;

const EXPLICIT_CODE_REQUEST =
  /\b(show|include|give|write|provide|display)\b[\s\S]{0,50}\b(code|python|javascript|typescript|script|implementation)\b|\b(code|python|javascript|typescript|script)\b[\s\S]{0,50}\b(show|include|give|write|provide|display)\b/i;

const CODE_INTENTS = new Set<RequestIntent>([
  "code-generation",
  "technical-debugging",
  "code-review",
  "architecture-review",
]);

export function shouldSuppressCalculationScaffolding(
  userMessage: string,
  requestIntent?: RequestIntent | null,
): boolean {
  if (EXPLICIT_CODE_REQUEST.test(userMessage)) {
    return false;
  }

  if (requestIntent && CODE_INTENTS.has(requestIntent)) {
    return false;
  }

  return CALCULATION_LIKE_REQUEST.test(userMessage);
}

export function sanitizeCalculationResponse(text: string): string {
  if (!text) {
    return text;
  }

  let cleaned = text;

  cleaned = cleaned.replace(
    /(?:^|\n)\s*#{1,6}\s*(?:calculation details|verification source)\s*\n\s*```(?:python|py|javascript|js|typescript|ts)?\s*\n[\s\S]*?```\s*/gi,
    "\n",
  );

  cleaned = cleaned.replace(
    /```(?:python|py|javascript|js|typescript|ts)\s*\n[\s\S]*?```/gi,
    "",
  );

  cleaned = cleaned.replace(
    /^\s*(?:\*{1,2})?(?:tool output summary|verification source|calculation details)(?:\*{1,2})?:?\s*$/gim,
    "",
  );

  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return cleaned;
}
