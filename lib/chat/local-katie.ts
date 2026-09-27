import {
  getChatContextState,
  listMemoryRecordsForActor,
  type ActorMemoryRecord,
} from "@/lib/data/persistence-store";
import {
  getKatieOperationalRealityStatement,
  getKatieReasoningExplainerStatement,
} from "@/lib/providers/operational-reality";

export type LocalKatieResponse = {
  text: string;
  reason: "system-prompt" | "memory";
};

const SYSTEM_PROMPT_REQUEST_PATTERNS = [
  /\b(?:exact|current|actual|full|show|give|display|print|reveal|what(?:'s| is))\b[^\n]{0,60}\bsystem prompt\b/i,
  /\bsystem prompt\b[^\n]{0,60}\b(?:this|current)\s+(?:message|chat|actor)\b/i,
  /\bwhat (?:prompt|instructions) (?:are you|is katie) (?:using|running|following)\b/i,
];

const MEMORY_REQUEST_PATTERNS = [
  /\bmemory (?:database|records?|state|contents?)\b/i,
  /\b(?:short[- ]term|intermediate|long[- ]term) memory\b/i,
  /\bwhat do you remember\b/i,
  /\bdo you remember\b/i,
  /\bwhat do you know about\b/i,
  /\bwhat (?:did|have) i (?:tell|told|say|said) you about\b/i,
  /\bwhat do you have (?:stored|saved) about\b/i,
  /\bwhat(?:'s| is) (?:stored|saved) about\b/i,
  /\bwhat(?:'s| is| are) (?:in )?(?:your|katie(?:'s)?) memory\b/i,
  /\b(?:stored|saved) memory\b/i,
];

const MEMORY_STOP_WORDS = new Set([
  "about",
  "anything",
  "are",
  "can",
  "content",
  "contents",
  "database",
  "does",
  "have",
  "from",
  "give",
  "into",
  "katie",
  "know",
  "long",
  "memory",
  "memories",
  "record",
  "records",
  "remember",
  "remembered",
  "saved",
  "short",
  "show",
  "stored",
  "tell",
  "term",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

const MEMORY_SYNONYMS: Record<string, string[]> = {
  job: ["work", "employment", "career"],
  work: ["job", "employment", "career"],
  employment: ["job", "work", "career"],
  career: ["job", "work", "employment"],
  kids: ["children", "child", "family"],
  children: ["kids", "child", "family"],
  child: ["children", "kids", "family"],
  girlfriend: ["relationship", "dating", "partner"],
  boyfriend: ["relationship", "dating", "partner"],
  partner: ["relationship", "dating", "girlfriend", "boyfriend"],
  relationship: ["dating", "partner", "girlfriend", "boyfriend"],
  house: ["home", "property", "real estate"],
  home: ["house", "property", "real estate"],
  condo: ["property", "real estate", "home"],
};

function isSystemPromptRequest(message: string): boolean {
  return SYSTEM_PROMPT_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

function isMemoryRequest(message: string): boolean {
  return MEMORY_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fenced(label: string, value: string): string {
  return [
    `**${label}**`,
    "~~~text",
    value || "(empty)",
    "~~~",
  ].join("\n");
}

function jsonBlock(label: string, value: unknown): string {
  return [
    `**${label}**`,
    "~~~json",
    pretty(value),
    "~~~",
  ].join("\n");
}

function normalizeQueryTerms(message: string): string[] {
  const quoted = Array.from(message.matchAll(/["“]([^"”]{2,})["”]/g))
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean);

  const words = message
    .toLowerCase()
    .split(/[^a-z0-9_'-]+/g)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length >= 3 && !MEMORY_STOP_WORDS.has(word));

  const expanded = new Set<string>([...quoted, ...words]);
  for (const term of [...expanded]) {
    for (const synonym of MEMORY_SYNONYMS[term] ?? []) {
      expanded.add(synonym);
    }
  }

  return [...expanded];
}

type FlatMemoryValue = {
  path: string;
  value: string;
};

function flattenMemoryValue(value: unknown, path = "", rows: FlatMemoryValue[] = []): FlatMemoryValue[] {
  if (value === null || value === undefined) {
    rows.push({ path: path || "(root)", value: String(value) });
    return rows;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ path: path || "(root)", value: "[]" });
      return rows;
    }
    value.forEach((item, index) => flattenMemoryValue(item, `${path}[${index}]`, rows));
    return rows;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      rows.push({ path: path || "(root)", value: "{}" });
      return rows;
    }
    entries.forEach(([key, child]) =>
      flattenMemoryValue(child, path ? `${path}.${key}` : key, rows),
    );
    return rows;
  }

  rows.push({ path: path || "(root)", value: String(value) });
  return rows;
}

function requestedLayers(message: string): Set<ActorMemoryRecord["layer"]> | null {
  const layers = new Set<ActorMemoryRecord["layer"]>();
  if (/\bshort[- ]term\b/i.test(message)) layers.add("short-term");
  if (/\bintermediate\b/i.test(message)) layers.add("intermediate");
  if (/\blong[- ]term\b/i.test(message)) layers.add("long-term");
  return layers.size > 0 ? layers : null;
}

function asksForFullMemoryDump(message: string): boolean {
  return (
    /\b(?:show|display|print|dump|list|give)\b[^\n]{0,50}\b(?:all|entire|full|memory|records?)\b/i.test(message) ||
    /\bwhat(?:'s| is| are) (?:in )?(?:your|katie(?:'s)?) memory\b/i.test(message) ||
    /\bmemory (?:database|records?|contents?)\b/i.test(message)
  );
}

function buildSystemPromptResponse(state: Awaited<ReturnType<typeof getChatContextState>>): string {
  const history = state.recentMessages.slice(-20).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  return [
    "Katie handled this request locally. No external LLM was called.",
    "",
    "The exact actor-level system prompt stored for this chat is:",
    "",
    fenced("actors.system_prompt", state.actor.purpose),
    "",
    "Katie also has the following local context available before any provider is called:",
    "",
    jsonBlock("short_term_memory.content", state.shortTermMemory),
    "",
    jsonBlock("intermediate_memory.content", state.intermediateMemory),
    "",
    jsonBlock("long_term_memory.content", state.longTermMemory),
    "",
    jsonBlock("recent conversation history supplied to the generation layer", history),
    "",
    "When Katie does call an external model, the generation adapter also injects these Katie-wide instructions:",
    "",
    fenced("Katie operational instruction", getKatieOperationalRealityStatement()),
    "",
    fenced("Katie reasoning-explainer instruction", getKatieReasoningExplainerStatement()),
    "",
    "Provider adapters format these pieces differently, so there is not one universal provider wire-format prompt. The stored actor prompt and memory values above are the exact database-backed values for this chat.",
  ].join("\n");
}

function formatMemoryRecord(record: ActorMemoryRecord): string {
  return [
    `### ${record.layer} memory · chat ${record.chatId}`,
    `Updated: ${record.updatedAt}`,
    "",
    "~~~json",
    pretty(record.content),
    "~~~",
  ].join("\n");
}

function buildMemoryResponse(message: string, records: ActorMemoryRecord[], currentChatId: string): string {
  const layers = requestedLayers(message);
  const scoped = records
    .filter((record) => !layers || layers.has(record.layer))
    .sort((a, b) => {
      const currentA = a.chatId === currentChatId ? 1 : 0;
      const currentB = b.chatId === currentChatId ? 1 : 0;
      if (currentA !== currentB) return currentB - currentA;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  if (asksForFullMemoryDump(message)) {
    if (scoped.length === 0) {
      return "I checked the memory database directly. There are no matching memory records for this actor.";
    }

    return [
      `I checked the memory database directly. I found ${scoped.length} matching record${scoped.length === 1 ? "" : "s"}. No external LLM was called.`,
      "",
      ...scoped.map(formatMemoryRecord),
    ].join("\n");
  }

  const terms = normalizeQueryTerms(message);
  if (terms.length === 0) {
    const currentRecords = scoped.filter((record) => record.chatId === currentChatId);
    const recordsToShow = currentRecords.length ? currentRecords : scoped.slice(0, 3);
    return [
      "I checked the memory database directly. Your question did not contain a specific searchable subject, so here are the relevant memory records.",
      "",
      ...recordsToShow.map(formatMemoryRecord),
    ].join("\n");
  }

  const matches = scoped.flatMap((record) =>
    flattenMemoryValue(record.content)
      .map((entry) => {
        const haystack = `${entry.path} ${entry.value}`.toLowerCase();
        const matchedTerms = terms.filter((term) => haystack.includes(term));
        return {
          record,
          entry,
          matchedTerms,
          score: matchedTerms.length,
        };
      })
      .filter((match) => match.score > 0),
  );

  matches.sort((a, b) => {
    if (a.record.chatId === currentChatId && b.record.chatId !== currentChatId) return -1;
    if (a.record.chatId !== currentChatId && b.record.chatId === currentChatId) return 1;
    if (a.score !== b.score) return b.score - a.score;
    return b.record.updatedAt.localeCompare(a.record.updatedAt);
  });

  if (matches.length === 0) {
    return [
      "I checked the memory database directly and did not find a stored memory entry matching that question.",
      "",
      `Search terms: ${terms.join(", ")}`,
      `Records checked: ${scoped.length}`,
      "",
      "No external LLM was called.",
    ].join("\n");
  }

  const topMatches = matches.slice(0, 20);
  const lines = topMatches.map(({ record, entry }) =>
    `- **${record.layer} · chat ${record.chatId} · ${entry.path}:** ${entry.value}`,
  );

  return [
    "I checked the memory database directly. These are the matching stored values:",
    "",
    ...lines,
    "",
    `Matched ${matches.length} stored value${matches.length === 1 ? "" : "s"} across ${scoped.length} memory record${scoped.length === 1 ? "" : "s"}.`,
    "No external LLM was called.",
  ].join("\n");
}

export async function resolveLocalKatieResponse(params: {
  actorId: string;
  chatId: string;
  message: string;
}): Promise<LocalKatieResponse | null> {
  if (isSystemPromptRequest(params.message)) {
    const state = await getChatContextState(params.actorId, params.chatId);
    return {
      reason: "system-prompt",
      text: buildSystemPromptResponse(state),
    };
  }

  if (isMemoryRequest(params.message)) {
    const records = await listMemoryRecordsForActor(params.actorId);
    return {
      reason: "memory",
      text: buildMemoryResponse(params.message, records, params.chatId),
    };
  }

  return null;
}
