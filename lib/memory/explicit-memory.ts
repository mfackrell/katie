import { clearActorLongTermMemory, getLongTermMemory, saveActorMemoryDocument, setLongTermMemory } from "@/lib/data/persistence-store";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { isExplicitMemoryCorrection } from "@/lib/chat/local-katie";
import { extractAndSaveExplicitFacts } from "@/lib/memory/explicit-fact-extractor";

export function isFullActorMemoryClear(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  return /\b(?:remove|delete|clear|erase|wipe|forget|purge)\b/i.test(normalized)
    && /\b(?:all|every|entire|whole|everything)\b/i.test(normalized)
    && /\b(?:long[- ]term memory|memory layer|memory entries|memories|entries.{0,55}long[- ]term memory)\b/i.test(normalized);
}

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
    if (isFullActorMemoryClear(message)) {
      const removed = await clearActorLongTermMemory(actorId);
      return `Cleared and verified this actor's long-term memory: ${removed.entries_removed} entries, ${removed.documents_removed} reference documents, and ${removed.legacy_rows_removed} legacy records removed. Other actors, chat history and short/intermediate memory were not changed.`;
    }
    if (isExplicitMemoryCorrection(message)) {
      // Deletion requests are not preserved as a new source document: doing so
      // would recreate the very information the user asked us to forget.
      if (/\b(?:delete|forget|remove|clear|erase|wipe|purge)\b/i.test(message)) {
        const before = await getLongTermMemory(actorId, chatId);
        await maybeUpdateLongTermMemory(actorId, chatId, message, { required: true });
        const after = await getLongTermMemory(actorId, chatId);
        const original = Array.isArray(before.entries) ? before.entries : [];
        const revised = Array.isArray(after.entries) ? after.entries : [];
        if (!original.some((old) => !revised.some((entry) => JSON.stringify(entry) === JSON.stringify(old)))) {
          throw new Error("Deletion not verified: no prior memory entry was removed");
        }
        return "The memory deletion was applied and verified against stored entries. No new source document was created.";
      }

      // A correction MUST remain authoritative even when an LLM returns
      // no_change or rewrites the old entry without applying the clarification.
      // Store the exact instruction and a structured override synchronously.
      const documentId = await saveActorMemoryDocument(
        actorId, messageId, "Authoritative correction to actor memory", message,
      );
      const current = await getLongTermMemory(actorId, chatId);
      const entries = Array.isArray(current.entries) ? current.entries as Entry[] : [];
      const correctionKey = `correction.${messageId}`;
      const correction: Entry = {
        key: correctionKey,
        category: "fact",
        value: message.trim(),
        source: "user-stated",
        confidence: "high",
        evidenceMessageIds: [messageId],
        lastConfirmedAt: new Date().toISOString(),
      };
      await setLongTermMemory(actorId, chatId, {
        version: 3,
        purpose: typeof current.purpose === "string" ? current.purpose : "Actor-wide durable memory",
        entries: [...entries.filter((entry) => entry.key !== correctionKey), correction],
      });
      // Verify the exact correction, provenance, and document independently.
      const persisted = await getLongTermMemory(actorId, chatId);
      const saved = Array.isArray(persisted.entries)
        ? (persisted.entries as Entry[]).find(entry => entry.key === correctionKey)
        : undefined;
      if (!saved || saved.value !== message.trim() || !saved.evidenceMessageIds?.includes(messageId)) {
        throw new Error("Explicit memory correction did not persist as an authoritative entry");
      }
      console.log("[ExplicitMemory] Authoritative correction verified", {
        actorId, chatId, messageId, documentId, correctionKey,
      });
      return "Your clarification was saved and verified in this actor's long-term memory. The full wording is retained as an authoritative correction that overrides conflicting older facts and reference documents in all existing and new chats for this actor.";
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
