import type { Actor, ChatThread } from "@/lib/types/chat";

export function canSubmitChatRequest(actorId: string, chatId: string): boolean {
  return actorId.trim().length > 0 && chatId.trim().length > 0;
}

export function hasResolvedChatSelection(
  actorId: string,
  chatId: string,
  actors: Actor[],
  chats: ChatThread[],
): boolean {
  if (!canSubmitChatRequest(actorId, chatId)) {
    return false;
  }

  const actorExists = actors.some((actor) => actor.id === actorId);
  if (!actorExists) {
    return false;
  }

  return chats.some((chat) => chat.id === chatId && chat.actorId === actorId);
}
