import { recentReactionContext } from "@/lib/chat/message-reactions";
import { loadTaskHandoffKnowledgeContext } from "@/lib/agents/task-handoff-knowledge";
import { currentAgentTask } from "@/lib/agents/policy";
import { getDeliverableStandardInstruction } from "@/lib/chat/deliverable-standard";
import { getChatContextState, listActorMemoryDocuments } from "@/lib/data/persistence-store";
import { MEMORY_ARCHITECTURE_GUIDE, SHORT_TERM_MESSAGE_LIMIT } from "@/lib/memory/memory-contract";
import { filterConversationalMessages, messagesFromShortTermMemory } from "@/lib/memory/short-term";
import type { ActorRoutingProfile, Message } from "@/lib/types/chat";
import { createNeutralActorRoutingProfile } from "@/lib/router/actor-routing-profile";

interface AssembledContext {
  name: string;
  persona: string;
  summary: string;
  history: Message[];
  shortTermMemory: Record<string, unknown>;
  actorRoutingProfile: ActorRoutingProfile;
  reviewMode: import("@/lib/collaboration/review-mode").ReviewMode;
}

export async function assembleContext(actorId: string, chatId: string): Promise<AssembledContext> {
  const { actor, recentMessages, shortTermMemory, intermediateMemory, longTermMemory } = await getChatContextState(
    actorId,
    chatId
  );

  const managedTask = currentAgentTask();
  const handoffKnowledge = managedTask ? await loadTaskHandoffKnowledgeContext(managedTask) : "";
  const referenceDocuments = await listActorMemoryDocuments(actorId, 20);
  const reactionContext = await recentReactionContext(actorId, chatId);
  let documentCharacters = 0;
  const referenceText = referenceDocuments
    .filter((doc) => {
      if (documentCharacters + doc.content.length > 100_000) return false;
      documentCharacters += doc.content.length;
      return true;
    })
    .map((doc) => `DOCUMENT ${doc.id} (${doc.title}; ${doc.createdAt}):\n${doc.content}`)
    .join("\n\n");
  const history =
    messagesFromShortTermMemory(shortTermMemory, chatId) ??
    filterConversationalMessages(recentMessages).slice(-SHORT_TERM_MESSAGE_LIMIT);
  const summary =
    (typeof intermediateMemory.summary === "string" && intermediateMemory.summary.trim()) ||
    "No older summarized conversation context is available yet.";

  // Authoritative corrections are an explicit memory overlay, not merely an
  // old conversation transcript or another low-priority reference document.
  // Give them their own high-priority block on EVERY chat in this actor.
  const authoritativeCorrections = Array.isArray(longTermMemory.entries)
    ? (longTermMemory.entries as Array<{key?: string;value?: string;lastConfirmedAt?: string}>)
        .filter(entry => entry.key?.startsWith("correction.") && typeof entry.value === "string")
        .sort((a, b) => (b.lastConfirmedAt ?? "").localeCompare(a.lastConfirmedAt ?? ""))
    : [];
  const correctionsBlock = [
    "AUTHORITATIVE ACTOR MEMORY CORRECTIONS (most recent first):",
    "These user-stated corrections OVERRIDE any conflicting earlier extracted facts,",
    "reference documents, and generalizations. Never revive a superseded detail.",
    ...authoritativeCorrections.map(entry => `CORRECTION ${entry.key}: ${entry.value}`),
    "END_AUTHORITATIVE_ACTOR_MEMORY_CORRECTIONS",
  ].join("\n");

  const longTermBlock = Object.keys(longTermMemory).length
    ? `LONG_TERM_MEMORY:\n${JSON.stringify(longTermMemory)}\nEND_LONG_TERM_MEMORY`
    : "LONG_TERM_MEMORY:\nNo durable long-term memory has been stored yet.\nEND_LONG_TERM_MEMORY";

  return {
    reviewMode: currentAgentTask()?.snapshot.reviewMode ?? actor.reviewMode ?? "adaptive",
    name: process.env.ASSISTANT_NAME || "Katie",
    persona: [
      currentAgentTask()?.snapshot.instructions ?? actor.purpose,
      getDeliverableStandardInstruction(),
      MEMORY_ARCHITECTURE_GUIDE,
      correctionsBlock,
      longTermBlock,
      handoffKnowledge,
      reactionContext,
      "ACTOR MEMORY REFERENCE DOCUMENTS: These are verbatim user-requested long-term records and archived historical records. The current structured long-term facts and the most recent explicit user corrections take precedence when records conflict.",
      referenceText || "(No reference documents)",
      "END_ACTOR_MEMORY_REFERENCE_DOCUMENTS",
    ].join("\n\n"),
    summary,
    history,
    shortTermMemory,
    actorRoutingProfile: actor.routingProfile ?? createNeutralActorRoutingProfile()
  };
}
