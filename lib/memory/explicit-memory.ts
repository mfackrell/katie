import { getLongTermMemory, saveActorMemoryDocument, setLongTermMemory } from "@/lib/data/persistence-store";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { isExplicitMemoryCorrection } from "@/lib/chat/local-katie";
import { extractAndSaveExplicitFacts } from "@/lib/memory/explicit-fact-extractor";

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
    // The generic editor may say no_change even when explicitly asked to retain
    // a long source document. Dedicated extraction is mandatory to ATTEMPT and
    // its outcome is reported separately from the already verified document.
    try {
      const result = await extractAndSaveExplicitFacts(actorId, chatId, messageId, message);
      if (result.factsSaved && !result.chunksFailed) {
        return `Saved and verified in this actor's long-term memory. I preserved your complete original document and extracted ${result.factsSaved} source-grounded, structured facts, verified in durable storage. Both are available to all chats for this actor.`;
      }
      if (result.factsSaved) {
        return `Your complete original document was saved and verified in actor-wide long-term memory. I also extracted and verified ${result.factsSaved} structured facts, but ${result.chunksFailed} document section(s) could not be fully processed. Structured extraction is incomplete; the original remains intact.`;
      }
      return "Your complete original document was saved and verified in actor-wide long-term memory, but structured fact extraction did not complete. I am not claiming the document was fully indexed.";
    } catch (extractionError) {
      console.error("[ExplicitMemory] Structured extraction failed after document save", {
        actorId, chatId, error: extractionError,
      });
      return "Your complete original document was saved and verified in actor-wide long-term memory, but structured fact extraction failed. The document remains intact; structured extraction is not confirmed.";
    }
  } catch (error) {
    console.error("[ExplicitMemory] Write failure", { actorId, chatId, error });
    return "I could not verify that the requested long-term memory change was completed. I will not claim it was saved or corrected. Details: " +
      (error instanceof Error ? error.message : String(error));
  }
}
