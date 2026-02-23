import { getConversationSummary } from "@/lib/data/blob-store";
import { getActorById, getRecentMessages } from "@/lib/data/blob-store";

export async function assembleContext(actorId: string, chatId: string): Promise<string> {
  const [actor, summary, recentMessages] = await Promise.all([
    getActorById(actorId),
    getConversationSummary(chatId),
    getRecentMessages(chatId)
  ]);

  if (!actor) {
    throw new Error(`Actor not found: ${actorId}`);
  }

  const ephemeral = recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  return [
    `LAYER 1 - PERMANENT MEMORY (ACTOR PERSONA):\n${actor.purpose}`,
    `LAYER 2 - INTERMEDIARY MEMORY (CONVERSATION SUMMARY):\n${summary || "No summary available yet."}`,
    `LAYER 3 - EPHEMERAL MEMORY (RECENT RAW MESSAGES):\n${ephemeral || "No recent messages found."}`
  ].join("\n\n");
}
