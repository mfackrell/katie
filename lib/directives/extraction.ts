export type DirectiveCandidate = {
  directive: string;
  confidence: "high" | "ambiguous";
};

function normalizeDirectiveText(text: string): string {
  return text.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").replace(/\s+/g, " ").trim();
}

const HIGH_CONFIDENCE_PATTERNS: RegExp[] = [
  /^please\s+remember\s+that\s+(.+)/i,
  /^remember\s+that\s+(.+)/i,
  /^important:\s*i\s+want\s+you\s+to\s+(.+)/i,
  /^i\s+want\s+you\s+to\s+remember\s+(.+)/i,
  /^keep\s+in\s+mind\s+that\s+(.+)/i,
  /^from\s+now\s+on,\s*when\s+i\s+ask\s+(.+)/i,
];

const AMBIGUOUS_PATTERNS: RegExp[] = [
  /^always\s+(.+)/i,
  /^from\s+now\s+on\s+(.+)/i,
  /^you\s+should\s+(.+)/i,
];

export function extractDirectiveCandidate(message: string): DirectiveCandidate | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const directive = normalizeDirectiveText(match[1]);
      if (directive) {
        return { directive, confidence: "high" };
      }
    }
  }

  for (const pattern of AMBIGUOUS_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const directive = normalizeDirectiveText(match[1]);
      if (directive) {
        return { directive, confidence: "ambiguous" };
      }
    }
  }

  return null;
}

const DEACTIVATION_PATTERNS: RegExp[] = [
  /don't\s+remember\s+that\s+anymore/i,
  /do\s+not\s+remember\s+that\s+anymore/i,
  /remove\s+that\s+instruction/i,
  /stop\s+doing\s+that/i,
  /forget\s+that\s+preference/i,
];

export function isDirectiveRemovalRequest(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  return DEACTIVATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function normalizeDirectiveForCompare(value: string): string {
  return value.toLowerCase().replace(/[.!?,;:]+$/g, "").replace(/\s+/g, " ").trim();
}
