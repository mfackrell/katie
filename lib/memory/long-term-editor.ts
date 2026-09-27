import {
  getLongTermMemory,
  getRecentMessages,
  setLongTermMemory
} from "@/lib/data/persistence-store";
import { filterConversationalMessages } from "@/lib/memory/short-term";

const MEMORY_EDITOR_MODEL = "gpt-4o-mini";
const MEMORY_EDITOR_HISTORY_WINDOW = 8;
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
  lastConfirmedAt?: string;
};

type LongTermMemoryV2 = {
  version: 2;
  purpose: string;
  entries: LongTermEntry[];
};

type MemoryEditorAction =
  | { action: "no_change" }
  | { action: "replace"; updatedContent: LongTermMemoryV2 };

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

function normalizeUpdatedContent(value: unknown): LongTermMemoryV2 | null {
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

    const entry: LongTermEntry = {
      key: rawEntry.key.trim(),
      category: rawEntry.category,
      value: rawEntry.value.trim(),
      source: rawEntry.source,
      confidence: rawEntry.confidence,
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
    version: 2,
    purpose:
      "Durable memory for important facts, preferences, relationships, goals, decisions, constraints, and recurring patterns that should persist across the conversation.",
    entries,
  };
}

function parseMemoryEditorResult(raw: string): MemoryEditorAction | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.action === "no_change") {
      return { action: "no_change" };
    }

    if (parsed.action !== "replace") {
      return null;
    }

    const updatedContent = normalizeUpdatedContent(parsed.updatedContent);
    if (!updatedContent) {
      return null;
    }

    return {
      action: "replace",
      updatedContent
    };
  } catch {
    return null;
  }
}

function createDefaultClient(): MemoryEditorClient | null {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: OpenAI } = require("openai") as { default: new (params: { apiKey: string }) => MemoryEditorClient };
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {
    return null;
  }
}

const defaultClient = createDefaultClient();

function getMemoryEditorClient(): MemoryEditorClient | null {
  return (globalThis as { __KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__?: MemoryEditorClient | null }).__KATIE_LONG_TERM_MEMORY_OPENAI_CLIENT__ ?? defaultClient;
}

function formatTranscript(messages: Awaited<ReturnType<typeof getRecentMessages>>): string {
  return messages
    .map((message, index) => {
      const timestamp = message.createdAt ? ` (${message.createdAt})` : "";
      return `${index + 1}. ${message.role.toUpperCase()}${timestamp}: ${message.content}`;
    })
    .join("\n");
}

function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function isV2LongTermMemory(value: JsonRecord): boolean {
  return value.version === 2 && Array.isArray(value.entries);
}

const LEGACY_TRANSIENT_PATH = /(?:^|\.)(?:recentMessages|rollingSummary|currentState|recentTravel|nextSteps|cute girls)(?:\.|$)/i;

function legacyCategory(path: string): LongTermEntry["category"] {
  const normalized = path.toLowerCase();
  if (normalized.includes("lindsey") || normalized.includes("relationship")) return "relationship";
  if (normalized.includes("preference")) return "preference";
  if (normalized.includes("goal")) return "goal";
  if (normalized.includes("decision")) return "decision";
  if (normalized.includes("constraint")) return "constraint";
  if (normalized.includes("selfworth") || normalized.includes("psychological") || normalized.includes("represents")) return "pattern";
  return "fact";
}

function migrateLegacyLongTermMemory(value: JsonRecord): LongTermMemoryV2 {
  const entries: LongTermEntry[] = [];
  const seen = new Set<string>();

  const pushEntry = (path: string, rawValue: unknown) => {
    if (!path || LEGACY_TRANSIENT_PATH.test(path)) {
      return;
    }

    const stringValue =
      typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
        ? String(rawValue).trim()
        : "";

    if (!stringValue) {
      return;
    }

    const dedupeKey = `${path.toLowerCase()}|${stringValue.toLowerCase()}`;
    if (seen.has(dedupeKey) || entries.length >= MAX_LONG_TERM_ENTRIES) {
      return;
    }
    seen.add(dedupeKey);

    entries.push({
      key: path.replace(/\[(\d+)\]/g, ".$1"),
      category: legacyCategory(path),
      value: stringValue,
      // Legacy records did not reliably preserve provenance. Mark them as
      // inference until the user explicitly confirms or corrects them.
      source: "assistant-inference",
      confidence: "medium",
    });
  };

  const walk = (node: unknown, path: string) => {
    if (LEGACY_TRANSIENT_PATH.test(path)) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }

    pushEntry(path, node);
  };

  walk(value, "");

  return {
    version: 2,
    purpose:
      "Durable memory for important facts, preferences, relationships, goals, decisions, constraints, and recurring patterns that should persist across the conversation.",
    entries,
  };
}

async function persistLegacyMigration(actorId: string, chatId: string, legacy: JsonRecord): Promise<LongTermMemoryV2> {
  const migrated = migrateLegacyLongTermMemory(legacy);
  await setLongTermMemory(actorId, chatId, migrated);
  console.log("[LongTermMemoryEditor] Legacy migration fallback saved", {
    actorId,
    chatId,
    entryCount: migrated.entries.length,
  });
  return migrated;
}

export async function maybeUpdateLongTermMemory(actorId: string, chatId: string, latestUserMessage: string): Promise<void> {
  console.log("[LongTermMemoryEditor] Start", {
    actorId,
    chatId,
    latestUserMessagePreview: truncateForLog(latestUserMessage, 120)
  });

  try {
    const client = getMemoryEditorClient();
    if (!client) {
      console.log("[LongTermMemoryEditor] Skip: OpenAI client unavailable", { actorId, chatId });
      return;
    }

    const [currentLongTermMemory, rawRecentMessages] = await Promise.all([
      getLongTermMemory(actorId, chatId),
      getRecentMessages(chatId, MEMORY_EDITOR_HISTORY_WINDOW + 12),
    ]);
    const recentMessages = filterConversationalMessages(rawRecentMessages).slice(-MEMORY_EDITOR_HISTORY_WINDOW);
    const needsMigration = !isV2LongTermMemory(currentLongTermMemory);

    console.log("[LongTermMemoryEditor] Context Loaded", {
      longTermMemoryState: Object.keys(currentLongTermMemory).length === 0 ? "empty" : "non-empty",
      recentMessageCount: recentMessages.length,
      needsMigration,
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
            "- Persist stable user facts, durable preferences, important relationship context, enduring goals, significant decisions, durable constraints, and recurring patterns.",
            "- Do NOT store raw message transcripts, recentMessages arrays, rolling summaries, routing/session state, temporary currentState fields, or routine travel/location/status updates.",
            "- Do NOT copy intermediate-memory summaries into long-term memory.",
            "- Do NOT store one-off jokes, banter, momentary emotions, temporary plans, or transient recommendations unless the user explicitly asks that they be remembered long-term.",
            "- Preserve exact speaker attribution. Never store an assistant statement as something the user said.",
            "- Use source='user-stated' only when the user explicitly stated or confirmed the information.",
            "- Use source='assistant-inference' for a durable analytical pattern inferred from conversation. Inferences must never be represented as user-stated facts.",
            "- confidence should reflect evidentiary strength: high, medium, or low.",
            "- If the user corrects a memory, revise or remove the older conflicting entry.",
            "- Deduplicate semantically equivalent entries instead of accumulating variants.",
            "- Keep the memory compact. Prefer fewer strong entries over many weak ones.",
            "",
            "The required long-term format is:",
            '{"version":2,"purpose":"...","entries":[{"key":"stable.short.identifier","category":"fact|preference|relationship|goal|decision|constraint|pattern","value":"...","source":"user-stated|assistant-inference","confidence":"high|medium|low","lastConfirmedAt":"ISO timestamp if known"}]}',
            "",
            "Return strict JSON only:",
            '{"action":"no_change"}',
            "or",
            '{"action":"replace","updatedContent":<the complete version-2 long-term memory object>}.',
            "",
            "If existingLongTermMemoryContent is not already version 2, you MUST migrate only its genuinely durable content into the version-2 format and discard legacy transcript/summary/transient pollution.",
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `actorId: ${actorId}`,
            `chatId: ${chatId}`,
            `latestUserMessage: ${latestUserMessage}`,
            `existingLongTermMemoryContent: ${JSON.stringify(currentLongTermMemory)}`,
            `needsVersion2Migration: ${needsMigration}`,
            "recentRoleAttributedMessages:",
            formatTranscript(recentMessages),
            "Output JSON only."
          ].join("\n\n")
        }
      ]
    });

    const rawResult = response.choices?.[0]?.message?.content?.trim();
    console.log("[LongTermMemoryEditor] Model Response Received", {
      rawResponsePreview: truncateForLog(rawResult ?? "", 200)
    });

    if (!rawResult) {
      console.log("[LongTermMemoryEditor] No-op: empty model response", { actorId, chatId });
      if (needsMigration) {
        await persistLegacyMigration(actorId, chatId, currentLongTermMemory);
      }
      return;
    }

    const decision = parseMemoryEditorResult(rawResult);
    if (!decision) {
      console.log("[LongTermMemoryEditor] No-op: invalid model response", { actorId, chatId });
      if (needsMigration) {
        await persistLegacyMigration(actorId, chatId, currentLongTermMemory);
      }
      return;
    }

    if (decision.action === "no_change") {
      if (needsMigration) {
        console.warn("[LongTermMemoryEditor] Migration required but model returned no_change; applying deterministic migration fallback.", {
          actorId,
          chatId,
        });
        await persistLegacyMigration(actorId, chatId, currentLongTermMemory);
      } else {
        console.log("[LongTermMemoryEditor] Decision: no_change", { actorId, chatId });
      }
      return;
    }

    console.log("[LongTermMemoryEditor] Decision: replace", {
      actorId,
      chatId,
      entryCount: decision.updatedContent.entries.length,
    });
    await setLongTermMemory(actorId, chatId, decision.updatedContent);
    console.log("[LongTermMemoryEditor] Save Success", { actorId, chatId });
  } catch (error: unknown) {
    console.error("[LongTermMemoryEditor] Failed", {
      actorId,
      chatId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
