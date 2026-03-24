import type { ChatThread } from "@/lib/types/chat";

export function resolveStarterChat(
  chatsForActor: ChatThread[],
  options: { createStarterChat?: boolean },
): ChatThread | null {
  if (!options.createStarterChat) {
    return null;
  }

  return chatsForActor[0] ?? null;
}
