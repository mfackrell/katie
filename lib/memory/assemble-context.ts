import { getChatContextState } from "@/lib/data/persistence-store";
import type { Message } from "@/lib/types/chat";

interface AssembledContext {
  name: string;
  persona: string;
  summary: string;
  history: Message[];
  shortTermMemory: Record<string, unknown>;
}

export async function assembleContext(actorId: string, chatId: string): Promise<AssembledContext> {
  const { actor, recentMessages, shortTermMemory, intermediateMemory, longTermMemory } = await getChatContextState(
    actorId,
    chatId
  );

  const history = recentMessages.slice(-20);
  const summary =
    (typeof intermediateMemory.summary === "string" && intermediateMemory.summary) ||
    "No summary available yet.";

  const memoryHeader = [
    shortTermMemory,
    intermediateMemory,
    longTermMemory,
  ]
    .map((memory, index) =>
      Object.keys(memory).length
        ? `${index === 0 ? "Short-term" : index === 1 ? "Intermediate" : "Long-term"}: ${JSON.stringify(memory)}`
        : ""
    )
    .filter(Boolean)
    .join("\n");

  return {
    name: process.env.ASSISTANT_NAME || "Katie",
    persona: memoryHeader ? `${actor.purpose}\n\nMemory state:\n${memoryHeader}` : actor.purpose,
    summary,
    history,
    shortTermMemory
  };
}
