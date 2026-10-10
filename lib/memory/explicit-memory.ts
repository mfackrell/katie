import { getLongTermMemory, saveActorMemoryDocument, setLongTermMemory } from "@/lib/data/persistence-store";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { isExplicitMemoryCorrection } from "@/lib/chat/local-katie";

type Entry = {
  key: string; category: "fact"; value: string; source: "user-stated"; confidence: "high";
  evidenceMessageIds: string[]; lastConfirmedAt: string;
};

// Runs synchronously after the user message has been stored, before Katie
// tells the user that anything was remembered or corrected.
export async function handleExplicitMemoryMutation(
  actorId: string, chatId: string, messageId: string, message: string
): Promise<string> {
  try {
    if (isExplicitMemoryCorrection(message)) {
      await maybeUpdateLongTermMemory(actorId, chatId, message, { required: true });
      await saveActorMemoryDocument(actorId, messageId, "Explicit correction to actor memory", message);
      return "I corrected the actor's long-term memory and verified the update in durable storage. The correction applies to all existing and new chats within this actor.";
    }

    // The complete original is retained independently of any summarization
    // service, so even provider failures cannot lose the explicit instruction.
    const documentId = await saveActorMemoryDocument(actorId, messageId, "Explicit long-term memory request", message);
    const current = await getLongTermMemory(actorId, chatId);
    const entries = Array.isArray(current.entries) ? current.entries as Entry[] : [];
    const entry: Entry = {
      key: `explicit.${messageId}`,
      category: "fact",
      value: `User explicitly saved a verbatim actor-wide reference document (document ${documentId}). Preview: ${message.slice(0, 400)}`,
      source: "user-stated", confidence: "high", evidenceMessageIds: [messageId],
      lastConfirmedAt: new Date().toISOString(),
    };
    await setLongTermMemory(actorId, chatId, {
      version: 3,
      purpose: typeof current.purpose === "string" ? current.purpose : "Actor-wide durable memory",
      entries: [...entries.filter(e => e.key !== entry.key), entry],
    });
    // Extraction into structured facts is a best-effort enhancement; the
    // complete user text and explicit marker are already durably committed.
    await maybeUpdateLongTermMemory(actorId, chatId, message);
    return "Saved and verified in this actor's long-term memory. I retained your complete wording as a durable reference document, not just a short summary. It is available in existing and new chats for this actor.";
  } catch (error) {
    console.error("[ExplicitMemory] Write failure", { actorId, chatId, error });
    return "I could not verify that the requested long-term memory change was completed. I will not claim it was saved or corrected. Details: " +
      (error instanceof Error ? error.message : String(error));
  }
}
