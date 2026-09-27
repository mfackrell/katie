import { getChatContextState } from "@/lib/data/persistence-store";
import { MEMORY_ARCHITECTURE_GUIDE, SHORT_TERM_MESSAGE_LIMIT } from "@/lib/memory/memory-contract";
import type { ActorRoutingProfile, Message } from "@/lib/types/chat";
import { createNeutralActorRoutingProfile } from "@/lib/router/actor-routing-profile";

interface AssembledContext {
  name: string;
  persona: string;
  summary: string;
  history: Message[];
  shortTermMemory: Record<string, unknown>;
  actorRoutingProfile: ActorRoutingProfile;
}

export async function assembleContext(actorId: string, chatId: string): Promise<AssembledContext> {
  const { actor, recentMessages, shortTermMemory, intermediateMemory, longTermMemory } = await getChatContextState(
    actorId,
    chatId
  );

  const history = recentMessages.slice(-SHORT_TERM_MESSAGE_LIMIT);
  const summary =
    (typeof intermediateMemory.summary === "string" && intermediateMemory.summary.trim()) ||
    "No older summarized conversation context is available yet.";

  const longTermBlock = Object.keys(longTermMemory).length
    ? `LONG_TERM_MEMORY:\n${JSON.stringify(longTermMemory)}\nEND_LONG_TERM_MEMORY`
    : "LONG_TERM_MEMORY:\nNo durable long-term memory has been stored yet.\nEND_LONG_TERM_MEMORY";

  return {
    name: process.env.ASSISTANT_NAME || "Katie",
    persona: [
      actor.purpose,
      MEMORY_ARCHITECTURE_GUIDE,
      longTermBlock,
    ].join("\n\n"),
    summary,
    history,
    shortTermMemory,
    actorRoutingProfile: actor.routingProfile ?? createNeutralActorRoutingProfile()
  };
}
