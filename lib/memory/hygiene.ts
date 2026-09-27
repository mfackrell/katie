import {
  getActorById,
  getLongTermMemory,
  getMessages,
  getRecentMessages,
  setActorSystemPrompt,
  setLongTermMemory,
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

type LongTermMemoryV3 = {
  version: 3;
  purpose: string;
  entries: LongTermEntry[];
};

const LONG_TERM_PURPOSE =
  "Durable memory for important facts, preferences, relationships, goals, decisions, constraints, and recurring patterns that should persist across the conversation.";

const EMBEDDED_MEMORY_SECTION =
  /\nContext About [^\n]+ \(Persist This\)[\s\S]*?\nUse this context when analyzing ongoing thoughts or behaviors\.\n?/gi;

const TRANSIENT_VALUE_PATTERN =
  /\b(?:currently|current environment|right now|today|tomorrow|this week|this trip|on vacation|recent travel|going back to|for the next hour)\b/i;

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

function isTransientLongTermEntry(entry: LongTermEntry): boolean {
  if (entry.category === "preference" || entry.category === "relationship" || entry.category === "goal") {
    return false;
  }

  return TRANSIENT_VALUE_PATTERN.test(entry.value);
}

function evidenceIdsForUserMessages(messages: Message[]): Set<string> {
  return new Set(messages.filter((message) => message.role === "user").map((message) => message.id));
}

function normalizeProvenance(entries: LongTermEntry[], userMessageIds: Set<string>): LongTermEntry[] {
  return entries
    .filter((entry) => !isTransientLongTermEntry(entry))
    .map((entry) => {
      if (entry.source !== "user-stated") {
        return entry;
      }

      const validEvidence = (entry.evidenceMessageIds ?? []).filter((id) => userMessageIds.has(id));
      if (validEvidence.length > 0) {
        return {
          ...entry,
          evidenceMessageIds: validEvidence,
        };
      }

      return {
        ...entry,
        source: "assistant-inference" as const,
        confidence: entry.confidence === "low" ? "low" as const : "medium" as const,
        evidenceMessageIds: undefined,
      };
    });
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

function stableSort(entries: LongTermEntry[]): LongTermEntry[] {
  return [...entries].sort((a, b) => a.key.localeCompare(b.key));
}

function serialize(memory: LongTermMemoryV3): string {
  return JSON.stringify(memory);
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

  const userMessageIds = evidenceIdsForUserMessages(sourceMessages);
  const entries = normalizeProvenance(asEntries(currentLongTerm), userMessageIds);
  addExplicitInteractionPreferences(entries, sourceMessages);

  const nextMemory: LongTermMemoryV3 = {
    version: 3,
    purpose: LONG_TERM_PURPOSE,
    entries: stableSort(entries),
  };

  if (serialize(nextMemory) !== serialize(currentLongTerm as LongTermMemoryV3)) {
    await setLongTermMemory(actorId, chatId, nextMemory);
    console.log("[MemoryHygiene] Long-term memory normalized", {
      actorId,
      chatId,
      entryCount: nextMemory.entries.length,
      upgradedFromVersion: currentLongTerm.version ?? null,
    });
  }
}
