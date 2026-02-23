import { getConversationSummary } from "@/lib/data/blob-store";
import { getActorById, getRecentMessages } from "@/lib/data/blob-store";

interface AssembledContext {
  systemPrompt: string;
  history: { role: "user" | "assistant"; content: string }[];
}

export async function assembleContext(actorId: string, chatId: string): Promise<AssembledContext> {
  const [actor, summary, recentMessages] = await Promise.all([
    getActorById(actorId),
    getConversationSummary(chatId),
    getRecentMessages(chatId)
  ]);

  if (!actor) {
    throw new Error(`Actor not found: ${actorId}`);
  }

  const systemPrompt = [
    `LAYER 1 - PERMANENT MEMORY (ACTOR PERSONA):\n${actor.purpose}`,
    `LAYER 2 - INTERMEDIARY MEMORY (CONVERSATION SUMMARY):\n${summary || "No summary available yet."}`
  ].join("\n\n");

  const history = recentMessages.map((message) => ({
    role: message.role,
    content: message.content
  }));

  return {
    systemPrompt,
    history
  };
}
