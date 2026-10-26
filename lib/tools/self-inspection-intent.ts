/**
 * This gate grants entry to privileged repository tooling. Do not concatenate
 * unrelated words across user-supplied transcripts to infer execution intent.
 * Ambiguous pasted conversations fail closed to ordinary chat.
 */
export function isExplicitKatieSelfInspectionRequest(message: string): boolean {
  const text = message.trim();
  // A long multi-paragraph paste can begin with a quoted instruction.
  // Require a separate short instruction rather than executing its content.
  if (text.length > 1200 && /\n\s*\n/.test(text)) return false;
  const command = text.split(/\n\s*\n/)[0].trim();
  if (command.length > 320) return false;
  return /^(?:(?:hey|hi)\s+katie[,!.]?\s*)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:(?:check|inspect|review|read|show|list|verify|debug|fix|examine|look at|access|see|view)\s+)(?:katie(?:'s)?\s+|your(?:\s+own)?\s+|yourself\b|the\s+)?(?:repository|repo|github|source(?:\s+code)?|codebase|architecture|routing|deployment|vercel(?:\s+logs?)?|supabase(?:\s+(?:schema|logs?))?|logs?|implementation|system|code)\b/i.test(command) ||
    /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:see|inspect|examine)\s+yourself[?.!]*$/i.test(command);
}
