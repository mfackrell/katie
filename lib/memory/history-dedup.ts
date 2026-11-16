import type { Message } from "@/lib/types/chat";

/**
 * Keep the final occurrence of each persisted message ID, preserving the
 * original chronological order of those final occurrences. This lets the
 * authoritative STM copy win when a pending-history read overlaps STM.
 *
 * Do not deduplicate by text: different turns may legitimately be identical.
 * The guard applies to every provider, even if upstream retrieval regresses.
 */
export function uniqueMessagesById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const reversed: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    reversed.push(message);
  }
  return reversed.reverse();
}
