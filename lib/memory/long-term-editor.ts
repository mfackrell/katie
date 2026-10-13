import {
  getLongTermMemory,
  getRecentMessages,
  mergeActorLongTermMemoryEntries,
  setLongTermMemory,
} from "@/lib/data/persistence-store";
import { filterConversationalMessages } from "@/lib/memory/short-term";

const MEMORY_EDITOR_MODEL = "gpt-4o-mini";
const MEMORY_EDITOR_HISTORY_MESSAGES = 60;
const MAX_LONG_TERM_ENTRIES = 160;

type JsonRecord = Record<string, unknown>;

type MemoryEditorClient = {
  chat: {
    completions: {
      create(params: {
        model: string;
        temperature: number;
        response_format: { type: "json_object" };
        messages: Array<{ role: "system" | "user"; content: string }>;
      }): Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
};

type LongTermEntry = {
  key: string;
  category: "fact" | "preference" | "relationship" | "goal" | "decision" | "constraint" | "pattern";
  value: string;
  source: "user-stated" | "assistant-inference";
  confidence: "high" | "medium" | "low";
  evidenceMessageIds?: string[];
  evidenceQuotes?: Array<{ messageId: string; quote: string }>;
  lastConfirmedAt?: string;
};

type LongTermMemoryV3 = {
  version: 3;
  purpose: string;
  entries: LongTermEntry[];
};

type MemoryEditorAction =
  | { action: "no_change" }
  | { action: "replace"; updatedContent: LongTermMemoryV3 };

const LONG_TERM_PURPOSE =
  "Durable memory for important facts, preferences, relationships, goals, decisions, constraints, and recurring patterns that should persist across the conversation.";

const TRANSIENT_VALUE_PATTERN =
  /\b(?:currently|current environment|right now|today|tomorrow|this week|this trip|on vacation|for the next hour)\b/i;

function isLongTermEntry(value: unknown): value is LongTermEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === "string" &&
    entry.key.trim().length > 0 &&
    typeof entry.value === "string" &&
    entry.value.trim().length > 0 &&
    ["fact", "preference", "relationship", "goal", "decision", "constraint", "pattern"].includes(String(entry.category)) &&
    ["user-stated", "assistant-inference"].includes(String(entry.source)) &&
    ["high", "medium", "low"].includes(String(entry.confidence))
  );
}

function currentEntries(value: JsonRecord): LongTermEntry[] {
  if (!Array.isArray(value.entries)) {
    return [];
  }
  return value.entries.filter(isLongTermEntry);
}

function normalizeUpdatedContent(
  value: unknown,
  allowedEvidenceIds: Set<string>,
): LongTermMemoryV3 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries)) {
    return null;
  }

  const seen = new Set<string>();
  const entries: LongTermEntry[] = [];

  for (const rawEntry of record.entries) {
    if (!isLongTermEntry(rawEntry)) {
      continue;
    }

    if (
      rawEntry.category !== "preference" &&
      rawEntry.category !== "relationship" &&
      rawEntry.category !== "goal" &&
      !rawEntry.key.startsWith("explicit.") &&
      !rawEntry.key.startsWith("reference.") &&
      !rawEntry.key.startsWith("correction.") &&
      TRANSIENT_VALUE_PATTERN.test(rawEntry.value)
    ) {
      continue;
    }

    const validEvidence = Array.isArray(rawEntry.evidenceMessageIds)
      ? rawEntry.evidenceMessageIds.filter(
          (id): id is string => typeof id === "string" && allowedEvidenceIds.has(id),
        )
      : [];

    const requestedUserStated = rawEntry.source === "user-stated";
    const hasUserEvidence = validEvidence.length > 0;

    const entry: LongTermEntry = {
      key: rawEntry.key.trim(),
      category: rawEntry.category,
      value: rawEntry.value.trim(),
      source: requestedUserStated && hasUserEvidence ? "user-stated" : "assistant-inference",
      confidence:
        requestedUserStated && !hasUserEvidence && rawEntry.confidence === "high"
          ? "medium"
          : rawEntry.confidence,
      ...(hasUserEvidence ? { evidenceMessageIds: validEvidence } : {}),
      ...(Array.isArray(rawEntry.evidenceQuotes) ? { evidenceQuotes: rawEntry.evidenceQuotes } : {}),
      ...(typeof rawEntry.lastConfirmedAt === "string" && rawEntry.lastConfirmedAt.trim()
        ? { lastConfirmedAt: rawEntry.lastConfirmedAt.trim() }
        : {}),
    };

    const dedupeKey = `${entry.category}|${entry.key.toLowerCase()}|${entry.value.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    entries.push(entry);

    if (entries.length >= MAX_LONG_TERM_ENTRIES) {
      break;
    }
  }

  return {
    version: 3,
    purpose: LONG_TERM_PURPOSE,
    entries,
  };
}

function parseMemoryEditorResult(
  raw: string,
  allowedEvidenceIds: Set<string>,
): MemoryEditorAction | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.action === "no_change") {
      return { action: "no_change" };
    }

    if (parsed.action !== "replace") {
      return null;
    }

    const updatedContent = normalizeUpdatedContent(parsed.updatedContent, allowedEvidenceIds);
    if (!updatedContent) {
      return null;
    }

    return {
      action: "replace",
      updatedContent,
    };
  } catch {
    return null;
  }
}

/**
 * Ordinary automatic learning only emits source-verified per-key updates.
 * A valid ID without an excerpt of that actual user's text is not provenance.
 */
function verifiedAutomaticPatches(
  proposed: LongTermEntry[],
  current: LongTermEntry[],
  recentMessages: Awaited<ReturnType<typeof getRecentMessages>>,
): LongTermEntry[] {
  const oldByKey = new Map(current.map(entry => [entry.key, entry]));
  const userById = new Map(recentMessages.filter(m => m.role === "user").map(m => [m.id, m]));
  const patches: LongTermEntry[] = [];
  for (const entry of proposed) {
    const old = oldByKey.get(entry.key);
    if (old?.value === entry.value && old.category === entry.category) continue;
    if (/^(?:reference|explicit|correction)\./.test(entry.key)) continue;

    const claimed = entry.evidenceQuotes;
    if (!claimed?.length || !entry.evidenceMessageIds?.length) continue;
    if (claimed.some(item =>
      !item || typeof item.messageId !== "string" || typeof item.quote !== "string" ||
      item.quote.trim().length < 20 || !userById.get(item.messageId)?.content.includes(item.quote.trim())
    )) continue;
    const evidenceIds = [...new Set(claimed.map(item => item.messageId))];
    if (evidenceIds.length !== entry.evidenceMessageIds.length ||
        evidenceIds.some(id => !entry.evidenceMessageIds?.includes(id))) continue;

    const directPreference = entry.category === "preference" &&
      claimed.some(item => /\b(?:I (?:prefer|want|need)|my preference|please (?:always|never)|from now on)\b/i.test(item.quote));
    const source = entry.category === "pattern" || !directPreference
      ? "assistant-inference" : entry.source;
    patches.push({
      ...entry,
      source,
      confidence: source === "assistant-inference" && entry.confidence === "high"
        ? "medium" : entry.confidence,
      evidenceMessageIds: evidenceIds,
      evidenceQuotes: claimed.map(item => ({ messageId: item.messageId, quote: item.quote.trim() })),
      lastConfirmedAt: userById.get(evidenceIds[0])?.createdAt ?? entry.lastConfirmedAt,
    });
  }
  return patches;
}

function createDefaultClient(): MemoryEditorClient | null {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: OpenAI } = require("openai") as {
      default: new (params: { apiKey: string }) => MemoryEditorClient;
    };
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {
    return null;
  }
}

const defaultClient = createDefaultClient();

function getMemoryEditorClient(): MemoryEditorClient | null {
  return (
    (globalThis as { __KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__?: MemoryEditorClient | null })
      .__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ ?? defaultClient
  );
}

function formatTranscript(messages: Awaited<ReturnType<typeof getRecentMessages>>): string {
  return messages
    .map((message, index) => {
      const timestamp = message.createdAt ? ` (${message.createdAt})` : "";
      return `${index + 1}. ${message.role.toUpperCase()} [messageId=${message.id}]${timestamp}: ${message.content}`;
    })
    .join("\n");
}

function truncateForLog(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function existingEvidenceIds(memory: JsonRecord): Set<string> {
  const ids = new Set<string>();
  for (const entry of currentEntries(memory)) {
    for (const id of entry.evidenceMessageIds ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

export async function maybeUpdateLongTermMemory(
  actorId: string,
  chatId: string,
  latestUserMessage: string,
  options: { required?: boolean } = {},
): Promise<void> {
  console.log("[LongTermMemoryEditor] Start", {
    actorId,
    chatId,
    latestUserMessagePreview: truncateForLog(latestUserMessage, 120),
  });

  try {
    const client = getMemoryEditorClient();
    if (!client) {
      if (options.required) throw new Error("Memory correction unavailable: editor provider not configured");
      console.log("[LongTermMemoryEditor] Skip: OpenAI client unavailable", { actorId, chatId });
      return;
    }

    const [currentLongTermMemory, rawRecentMessages] = await Promise.all([
      getLongTermMemory(actorId, chatId),
      getRecentMessages(chatId, MEMORY_EDITOR_HISTORY_MESSAGES + 40),
    ]);

    const completedMessages = filterConversationalMessages(rawRecentMessages);
    // A synchronous explicit save/correction runs after the USER message is
    // stored but before Katie responds. Include this unpaired user turn so
    // edits are grounded in the exact user instruction and its message id.
    const latestRaw = rawRecentMessages[rawRecentMessages.length - 1];
    const pendingUser = latestRaw?.role === "user" && latestRaw.content === latestUserMessage &&
      !completedMessages.some(m => m.id === latestRaw.id) ? latestRaw : null;
    const recentMessages = [
      ...completedMessages.slice(-(MEMORY_EDITOR_HISTORY_MESSAGES - (pendingUser ? 1 : 0))),
      ...(pendingUser ? [pendingUser] : []),
    ];
    const recentUserIds = new Set(
      recentMessages.filter((message) => message.role === "user").map((message) => message.id),
    );
    const allowedEvidenceIds = existingEvidenceIds(currentLongTermMemory);
    recentUserIds.forEach((id) => allowedEvidenceIds.add(id));

    console.log("[LongTermMemoryEditor] Context Loaded", {
      longTermMemoryState:
        Object.keys(currentLongTermMemory).length === 0 ? "empty" : "non-empty",
      recentMessageCount: recentMessages.length,
      longTermVersion: currentLongTermMemory.version ?? null,
    });

    const response = await client.chat.completions.create({
      model: MEMORY_EDITOR_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are Katie's LONG-TERM MEMORY editor.",
            "Long-term memory contains only durable information important enough to remain useful across the full conversation.",
            "Allowed categories: fact, preference, relationship, goal, decision, constraint, pattern.",
            "",
            "Storage rules:",
            "- Persist stable user facts, durable interaction preferences, important relationship context, enduring goals, significant decisions, durable constraints, and recurring patterns.",
            "- Explicit user requests to remember a communication preference are high-priority durable memories.",
            "- Learn from user interactions, not only explicit requests to remember information. When the user corrects, challenges, explains, or refines Katie's work, consider whether the feedback reveals an enduring preference, expectation, or generalizable principle useful for future interactions.",
            "- Distinguish task-specific corrections from broadly applicable lessons. When feedback has lasting relevance, preserve the underlying lesson rather than memorizing the wording of an individual correction.",
            "- Pay particular attention to repeated feedback, explicit explanations of why an approach was ineffective, and corrections that reveal how the user evaluates quality.",
            "- Store durable lessons using the existing preference or pattern categories, appropriate evidenceMessageIds and confidence. A lesson inferred from multiple user messages may cite those messages; never attribute an assistant's interpretation to the user as a direct statement.",
            "- In ordinary automatic updates, return only NEW or CHANGED memories, not a complete memory snapshot. The database preserves omitted existing memories.",
            "- Every new or changed automatic memory requires evidenceQuotes: [{messageId,quote}], containing an exact meaningful excerpt of at least 20 characters from the cited USER message in recentRoleAttributedMessages. The evidenceMessageIds must be those same message IDs. Unrelated job postings and valid but irrelevant message IDs are not evidence.",
            "- Generalized lessons inferred from feedback are assistant-inference with calibrated confidence, not user-stated facts. Reserve user-stated for directly expressed preferences.",
            "- Do not turn isolated feedback, quoted third-party criticism, or tentative interpretations into permanent user preferences. A one-off writing edit is usually task-local; use no_change when there is no durable lesson.",
            "- Allow learned preferences to evolve when the user provides new information or changes their expectations. Respect explicit corrections and preserve otherwise distinct existing memories.",
            "- Do NOT store raw transcripts, rolling summaries, routing/session state, temporary status, routine travel, momentary emotions, one-off jokes, or short-lived circumstances.",
            "- Time-sensitive facts belong in long-term memory only if they remain historically important and are phrased with dated/contextual wording rather than as permanently current truth.",
            "- Preserve exact speaker attribution. Never store an assistant statement as something the user said.",
            "- source='user-stated' REQUIRES at least one evidenceMessageIds value from a USER message shown in recentRoleAttributedMessages, or an evidenceMessageIds value already present on that existing memory entry.",
            "- If you cannot cite a valid USER message id, use source='assistant-inference'.",
            "- Assistant inferences are reasoning context, not facts the user endorsed.",
            "- If the user corrects a memory, revise or remove the conflicting older entry.",
            "- Deduplicate semantically equivalent entries instead of accumulating variants.",
            "- Preserve all existing distinct entries unless the user explicitly corrects or removes them.",
            "- When the latest request explicitly asks to save or correct memory, update it rather than returning no_change.",
            "- Never discard a verbatim reference-document entry simply for being long.",
            "",
            "Required format:",
            '{"version":3,"purpose":"...","entries":[{"key":"stable.short.identifier","category":"fact|preference|relationship|goal|decision|constraint|pattern","value":"...","source":"user-stated|assistant-inference","confidence":"high|medium|low","evidenceMessageIds":["USER_MESSAGE_ID"],"evidenceQuotes":[{"messageId":"USER_MESSAGE_ID","quote":"exact supporting user excerpt"}],"lastConfirmedAt":"ISO timestamp if known"}]}',
            "",
            "Return strict JSON only:",
            '{"action":"no_change"}',
            "or",
            '{"action":"replace","updatedContent":<the complete version-3 long-term memory object>}.',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `actorId: ${actorId}`,
            `chatId: ${chatId}`,
            `latestUserMessage: ${latestUserMessage}`,
            `existingLongTermMemoryContent: ${JSON.stringify(currentLongTermMemory)}`,
            "recentRoleAttributedMessages:",
            formatTranscript(recentMessages),
            "Output JSON only.",
          ].join("\n\n"),
        },
      ],
    });

    const rawResult = response.choices?.[0]?.message?.content?.trim();
    console.log("[LongTermMemoryEditor] Model Response Received", {
      rawResponsePreview: truncateForLog(rawResult ?? "", 200),
    });

    if (!rawResult) {
      if (options.required) throw new Error("Memory editor returned no content");
      return;
    }

    const decision = parseMemoryEditorResult(rawResult, allowedEvidenceIds);
    if (!decision) {
      if (options.required) throw new Error("Memory editor returned invalid update");
      console.log("[LongTermMemoryEditor] No-op: invalid model response", { actorId, chatId });
      return;
    }

    if (decision.action === "no_change") {
      if (options.required) throw new Error("Memory editor declined the requested correction");
      console.log("[LongTermMemoryEditor] Decision: no_change", { actorId, chatId });
      return;
    }

    console.log("[LongTermMemoryEditor] Decision: replace", {
      actorId,
      chatId,
      entryCount: decision.updatedContent.entries.length,
    });
    if (options.required) {
      // Explicit edits preserve the existing correction/deletion pathway.
      if (JSON.stringify(decision.updatedContent) === JSON.stringify(currentLongTermMemory)) {
        throw new Error("Memory correction produced no actual change");
      }
      await setLongTermMemory(actorId, chatId, decision.updatedContent);
    } else {
      const changes = verifiedAutomaticPatches(
        decision.updatedContent.entries, currentEntries(currentLongTermMemory), recentMessages,
      );
      if (!changes.length) {
        console.log("[LongTermMemoryEditor] No-op: no source-verified durable changes", { actorId, chatId });
        return;
      }
      await mergeActorLongTermMemoryEntries(actorId, changes);
    }
    console.log("[LongTermMemoryEditor] Save Success", { actorId, chatId });
  } catch (error: unknown) {
    if (options.required) throw error;
    console.error("[LongTermMemoryEditor] Failed", {
      actorId,
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
