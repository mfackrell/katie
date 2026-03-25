export function canSubmitChatRequest(actorId: string, chatId: string): boolean {
  return actorId.trim().length > 0 && chatId.trim().length > 0;
}
