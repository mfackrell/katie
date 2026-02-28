import { getConversationSummary } from "@/lib/data/blob-store";
import { getActorById, getRecentMessages } from "@/lib/data/blob-store";
import type { Message } from "@/lib/types/chat";

interface AssembledContext {
  persona: string;
  summary: string;
  history: Message[];
}

export async function assembleContext(actorId: string): Promise<AssembledContext> {
  const [actor, summary, recentMessages] = await Promise.all([
    getActorById(actorId),
    getConversationSummary(actorId),
    getRecentMessages(actorId)
  ]);

  if (!actor) {
    throw new Error(`Actor not found: ${actorId}`);
  }

  const history = recentMessages.slice(-20);

  return {
    persona: actor.purpose,
    summary: summary || "No summary available yet.",
    history
  };
}
