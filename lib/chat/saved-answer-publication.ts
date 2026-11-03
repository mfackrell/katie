import type { Message } from "@/lib/types/chat";

/** Idempotent publication of a server-saved answer.
 * Do not append duplicates when a final-answer event, stream close, and
 * durable request recovery all report the same message.
 */
export function upsertSavedAssistant(messages: Message[], saved: Message): Message[] {
  const index = messages.findIndex(entry => entry.id === saved.id);
  if (index < 0) return [...messages, saved];
  const previous = messages[index];
  if (
    previous.content === saved.content &&
    previous.model === saved.model &&
    previous.presentation === saved.presentation &&
    previous.assets === saved.assets
  ) return messages;
  const updated = [...messages];
  updated[index] = { ...previous, ...saved, createdAt: previous.createdAt };
  return updated;
}
