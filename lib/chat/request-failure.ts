import type { Message } from "@/lib/types/chat";

export function chatFailureContent(message: string): string {
  return `Katie could not complete this request.\n\n${message}\n\nYour message is saved. Please retry.`;
}

// Persist before signaling the client; disconnected browsers recover the same message.
export async function finishChatFailure(input: {
  requestId: string;
  chatId: string;
  message: string;
  save: (message: Message) => Promise<unknown>;
  markFailed: (messageId?: string) => Promise<void>;
  emit: (messageId?: string) => void;
  close: () => void;
}): Promise<void> {
  let savedId: string | undefined;
  try {
    await input.save({ id: input.requestId, chatId: input.chatId, role: "assistant",
      content: chatFailureContent(input.message), createdAt: new Date().toISOString() });
    savedId = input.requestId;
  } catch (error) {
    console.error("[Chat API] Failed to persist error message", { requestId: input.requestId, error });
  }
  try { await input.markFailed(savedId); }
  catch (error) { console.error("[Chat API] Failed to persist request failure", { requestId: input.requestId, error }); }
  // controller.error() would discard queued chunks, including the error event.
  input.emit(savedId);
  input.close();
}
