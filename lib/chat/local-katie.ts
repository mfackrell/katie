import {
  getChatContextState,
  listMemoryRecordsForActor,
  type ActorMemoryRecord,
} from "@/lib/data/persistence-store";
import {
  getKatieOperationalRealityStatement,
  getKatieReasoningExplainerStatement,
} from "@/lib/providers/operational-reality";
import { MEMORY_ARCHITECTURE_GUIDE, SHORT_TERM_MESSAGE_LIMIT } from "@/lib/memory/memory-contract";
import { filterConversationalMessages, messagesFromShortTermMemory, refreshShortTermMemory } from "@/lib/memory/short-term";
import { latestProviderSystemAudit, type StoredProviderSystemAudit } from "@/lib/chat/provider-system-audit";

export type LocalKatieResponse = {
  text: string;
  reason: "system-prompt" | "memory" | "memory-update";
};

const SYSTEM_PROMPT_REQUEST_PATTERNS = [
  // A stored system message and a system prompt are synonyms for this command.
  /\b(?:exact|current|actual|full|show|give|display|print|reveal|what(?:'s| is))\b[^\n]{0,75}\bsystem\s+(?:prompt|message|instructions?)\b/i,
  /\bsystem\s+(?:prompt|message|instructions?)\b[^\n]{0,60}\b(?:this|current|latest|previous|last)\s+(?:message|chat|actor|request|turn)\b/i,
  /\bwhat\s+(?:prompt|instructions|system\s+(?:prompt|message))\s+(?:are you|is katie)\s+(?:using|running|following|sending)\b/i,
  /\b(?:show|display|print|give|list|reveal|what(?:'s| is| are))\b[^\n]{0,80}\b(?:sent|sending|send|provided|passing)\b[^\n]{0,60}\b(?:the\s+)?(?:system\s+)?(?:message|prompt|instructions?|llm|model|provider|grok|gemini|claude|gpt)\b/i,
  /\b(?:show|display|print|give)\b[^\n]{0,65}\b(?:exact|full|actual)\b[^\n]{0,60}\b(?:outgoing|provider|model)\s+(?:prompt|payload|system\s+messages?)\b/i,
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

export function isSystemPromptRequest(message: string): boolean {
  return SYSTEM_PROMPT_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

export function isExplicitMemoryCorrection(message: string): boolean {
  return /\b(?:correct|change|update|revise|fix|replace|remove|delete|forget|wrong|incorrect|not true|inaccurate)\b[^\n]{0,140}\b(?:memory|remembered|stored|saved)\b|\b(?:memory|remembered|stored|saved)\b[^\n]{0,140}\b(?:correct|change|update|revise|fix|replace|remove|delete|forget|wrong|incorrect|inaccurate)\b/i.test(message);
}

export function isExplicitMemoryMutation(message: string): boolean {
  return isExplicitMemoryCorrection(message) ||
    /\b(?:remember|memorize|retain|store|save|commit|add|put|incorporate|write)\b[^\n]{0,100}\b(?:long[- ]term memory|memory|for (?:later|future)|permanently)\b|\b(?:long[- ]term memory|memory)\b[^\n]{0,90}\b(?:remember|memorize|retain|store|save|commit|add|put|incorporate|write)\b/i.test(message);
}

function isMemoryRequest(message: string): boolean {
  const subjectIsMemory = MEMORY_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
  // Mentioning "long-term memory" is not automatically an instruction to
  // dump it. Only route actual inspection questions through the local reader.
  const asksToInspect = /\b(?:show|display|print|dump|list|give|reveal|inspect|check|view|what|which|where|how much|do you remember|did you remember|what do you know)\b/i.test(message) ||
    /\b(?:is|are|have|has)\b[^\n]{0,65}\b(?:in (?:your|the) memory|stored|saved)\b/i.test(message);
  return subjectIsMemory && asksToInspect;
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

function buildSystemPromptResponse(
  state: Awaited<ReturnType<typeof getChatContextState>>,
  latest: { requestId: string; snapshot: StoredProviderSystemAudit } | null,
): string {
  const canonicalHistory =
    messagesFromShortTermMemory(state.shortTermMemory, state.recentMessages[0]?.chatId ?? "local-inspection") ??
    filterConversationalMessages(state.recentMessages).slice(-SHORT_TERM_MESSAGE_LIMIT);

  const history = canonicalHistory.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  return [
    "Katie handled this request locally. No external LLM was called.",
    "",
    "The actor-level system prompt stored for this chat is below. This is a stored configuration value, NOT necessarily the entire provider request:",
    "",
    fenced("actors.system_prompt", state.actor.purpose),
    "",
    "Katie's memory architecture is:",
    "",
    fenced("memory architecture", MEMORY_ARCHITECTURE_GUIDE),
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
    "Provider adapters format these pieces differently, so there is no single universal wire-format prompt.",
    "",
    ...(latest ? [
      "**Actual last prepared generation-provider system messages (captured at the adapter immediately before its API call):**",
      `Provider: ${latest.snapshot.provider} · Model: ${latest.snapshot.model} · Endpoint: ${latest.snapshot.endpoint}`,
      `Captured: ${latest.snapshot.capturedAt} · Request: ${latest.requestId}`,
      latest.snapshot.truncated
        ? "WARNING: System text exceeded the inspection storage limit; the captured sections below are truncated."
        : "System-role text below is verbatim. It does not include user-role messages, multimodal file bytes, routing LLM prompts, or API credentials.",
      ...latest.snapshot.systemMessages.flatMap((content, index) => [
        "",
        fenced(`Actual provider system message ${index + 1}`, content),
      ]),
    ] : [
      "**Last outbound provider system-message snapshot:** Not recorded yet for this chat. Earlier calls preceded this audit feature. The stored actor prompt above is not a substitute for the actual provider payload.",
    ]),
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
      const currentA = a.chatId === currentChatId || a.chatId === "actor-wide" ? 1 : 0;
      const currentB = b.chatId === currentChatId || b.chatId === "actor-wide" ? 1 : 0;
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
    const currentRecords = scoped.filter((record) => record.chatId === currentChatId || record.chatId === "actor-wide");
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
  // Write intent must win over inspection, even when the request says "long-term memory".
  if (isExplicitMemoryMutation(params.message)) {
    return { reason: "memory-update", text: "" };
  }

  if (isSystemPromptRequest(params.message)) {
    await refreshShortTermMemory(params.actorId, params.chatId);
    const state = await getChatContextState(params.actorId, params.chatId);
    return {
      reason: "system-prompt",
      text: buildSystemPromptResponse(state, await latestProviderSystemAudit(params.actorId, params.chatId)),
    };
  }

  if (isMemoryRequest(params.message)) {
    await refreshShortTermMemory(params.actorId, params.chatId);
    const records = await listMemoryRecordsForActor(params.actorId);
    return {
      reason: "memory",
      text: buildMemoryResponse(params.message, records, params.chatId),
    };
  }

  return null;
}
