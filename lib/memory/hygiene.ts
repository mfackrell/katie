import {
  getActorById,
  getLongTermMemory,
  getMessages,
  getRecentMessages,
  setActorSystemPrompt,
  mergeActorLongTermMemoryEntries,
} from "@/lib/data/persistence-store";
import { filterConversationalMessages } from "@/lib/memory/short-term";
import type { Message } from "@/lib/types/chat";

type LongTermEntry = {
  key: string;
  category: "fact" | "preference" | "relationship" | "goal" | "decision" | "constraint" | "pattern";
  value: string;
  source: "user-stated" | "assistant-inference";
  confidence: "high" | "medium" | "low";
  evidenceMessageIds?: string[];
  lastConfirmedAt?: string;
};

const EMBEDDED_MEMORY_SECTION =
  /\nContext About [^\n]+ \(Persist This\)[\s\S]*?\nUse this context when analyzing ongoing thoughts or behaviors\.\n?/gi;

function cleanActorPrompt(prompt: string): string {
  return prompt
    .replace(EMBEDDED_MEMORY_SECTION, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function asEntries(memory: Record<string, unknown>): LongTermEntry[] {
  if (!Array.isArray(memory.entries)) {
    return [];
  }

  return memory.entries
    .filter((entry): entry is LongTermEntry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }

      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.key === "string" &&
        typeof candidate.value === "string" &&
        ["fact", "preference", "relationship", "goal", "decision", "constraint", "pattern"].includes(
          String(candidate.category),
        ) &&
        ["user-stated", "assistant-inference"].includes(String(candidate.source)) &&
        ["high", "medium", "low"].includes(String(candidate.confidence))
      );
    })
    .map((entry) => ({
      key: entry.key,
      category: entry.category,
      value: entry.value,
      source: entry.source,
      confidence: entry.confidence,
      ...(Array.isArray(entry.evidenceMessageIds)
        ? { evidenceMessageIds: entry.evidenceMessageIds.filter((id): id is string => typeof id === "string") }
        : {}),
      ...(typeof entry.lastConfirmedAt === "string" ? { lastConfirmedAt: entry.lastConfirmedAt } : {}),
    }));
}

function upsertEntry(entries: LongTermEntry[], entry: LongTermEntry): void {
  const index = entries.findIndex((candidate) => candidate.key === entry.key);
  if (index >= 0) {
    entries[index] = entry;
    return;
  }
  entries.push(entry);
}

function latestMatchingUserMessage(messages: Message[], pattern: RegExp): Message | null {
  const users = messages.filter((message) => message.role === "user");
  for (let index = users.length - 1; index >= 0; index -= 1) {
    if (pattern.test(users[index].content)) {
      return users[index];
    }
  }
  return null;
}

function addExplicitInteractionPreferences(entries: LongTermEntry[], messages: Message[]): void {
  const empathy = latestMatchingUserMessage(
    messages,
    /(?:important|remember|need|want|preference|from now on|going forward)[^\n]{0,120}\bempath(?:y|etic)\b|\bempath(?:y|etic)\b[^\n]{0,120}(?:important|remember|need|want)/i,
  );
  if (empathy) {
    upsertEntry(entries, {
      key: "interaction.empathy",
      category: "preference",
      value:
        "The user wants Katie to lead with empathy and acknowledge what is underneath before becoming corrective or analytical.",
      source: "user-stated",
      confidence: "high",
      evidenceMessageIds: [empathy.id],
      lastConfirmedAt: empathy.createdAt,
    });
  }

  const humor = latestMatchingUserMessage(
    messages,
    /(?:important|remember|need|want|preference|from now on|going forward)[^\n]{0,140}\b(?:humou?r|jokes?|funny)\b|\b(?:humou?r|jokes?|funny)\b[^\n]{0,140}(?:important|remember|need|want)/i,
  );
  if (humor) {
    upsertEntry(entries, {
      key: "interaction.humor",
      category: "preference",
      value:
        "The user wants Katie to recognize humor, including crude jokes, without automatically treating every joke as a boundary test or overanalyzing it.",
      source: "user-stated",
      confidence: "high",
      evidenceMessageIds: [humor.id],
      lastConfirmedAt: humor.createdAt,
    });
  }

  const directness = latestMatchingUserMessage(
    messages,
    /(?:important|remember|need|want|prefer|preference)[^\n]{0,120}\b(?:direct|blunt|concise|plainly)\b|\b(?:direct|blunt|concise|plainly)\b[^\n]{0,120}(?:important|remember|need|want|prefer)/i,
  );
  if (directness) {
    upsertEntry(entries, {
      key: "interaction.directness",
      category: "preference",
      value: "The user prefers direct, plain communication rather than padded or evasive responses.",
      source: "user-stated",
      confidence: "high",
      evidenceMessageIds: [directness.id],
      lastConfirmedAt: directness.createdAt,
    });
  }
}

export async function maintainMemoryArchitecture(actorId: string, chatId: string): Promise<void> {
  const [actor, currentLongTerm, recentRaw] = await Promise.all([
    getActorById(actorId),
    getLongTermMemory(actorId, chatId),
    getRecentMessages(chatId, 100),
  ]);

  if (!actor) {
    return;
  }

  const cleanedPrompt = cleanActorPrompt(actor.purpose);
  if (cleanedPrompt !== actor.purpose.trim()) {
    await setActorSystemPrompt(actorId, cleanedPrompt);
    console.log("[MemoryHygiene] Removed embedded user-memory facts from actor prompt", {
      actorId,
      chatId,
    });
  }

  const isV3 = currentLongTerm.version === 3 && Array.isArray(currentLongTerm.entries);
  const sourceMessages = isV3
    ? filterConversationalMessages(recentRaw)
    : filterConversationalMessages(await getMessages(chatId));

  // Hygiene can contribute deterministic interaction preferences, but must
  // never replace a stale actor-wide memory snapshot or discard other entries.
  const suggestions: LongTermEntry[] = [];
  addExplicitInteractionPreferences(suggestions, sourceMessages);
  const existingByKey = new Map(asEntries(currentLongTerm).map(entry => [entry.key, entry]));
  const changes = suggestions.filter(entry => {
    const previous = existingByKey.get(entry.key);
    return !previous || previous.value !== entry.value ||
      JSON.stringify(previous.evidenceMessageIds) !== JSON.stringify(entry.evidenceMessageIds);
  });
  if (changes.length) {
    await mergeActorLongTermMemoryEntries(actorId, changes);
    console.log("[MemoryHygiene] Interaction preferences merged", {
      actorId, chatId, entryCount: changes.length,
    });
  }
}
