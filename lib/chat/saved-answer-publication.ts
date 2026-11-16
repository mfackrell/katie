import type { Message } from "@/lib/types/chat";

/**
 * Publish a durable assistant message exactly once. React may replay state
 * updater functions; publication is pure and never updates another state atom.
 */
export function upsertSavedAssistant(messages: Message[], saved: Message): Message[] {
  const index = messages.findIndex(message => message.id === saved.id);
  if (index < 0) return [...messages, saved];
  const previous = messages[index];
  if (
    previous.content === saved.content &&
    previous.model === saved.model &&
    previous.presentation === saved.presentation &&
    (previous.assets === saved.assets || JSON.stringify(previous.assets ?? []) === JSON.stringify(saved.assets ?? []))
  ) return messages;
  const next = [...messages];
  next[index] = { ...previous, ...saved, createdAt: previous.createdAt };
  return next;
}
