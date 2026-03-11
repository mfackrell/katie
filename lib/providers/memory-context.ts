import { ChatGenerateParams } from "@/lib/providers/types";

export function flattenHistory(history: ChatGenerateParams["history"]): string {
  return history
    .map((message) => `${message.role === "assistant" ? "ASSISTANT" : "USER"}: ${message.content}`)
    .join("\n");
}

export function buildMemoryContext(history: ChatGenerateParams["history"]): string {
  return `[EPISODIC_MEMORY_LOG]\n${flattenHistory(history)}\n[/EPISODIC_MEMORY_LOG]`;
}
