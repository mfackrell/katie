import type { RequestIntent } from "@/lib/router/model-intent";

const ACK_PHRASES = [
  "yes",
  "yep",
  "sure",
  "ok",
  "okay",
  "sounds good",
  "great",
  "👍",
  "do that",
  "let's go",
  "go for it",
  "awesome",
  "perfect",
  "good",
  "alright"
];

const ACK_MIN_WORDS = 1;
const ACK_MAX_WORDS = 6;

const NON_SUBSTANTIVE_INTENTS: RequestIntent[] = ["text", "general-text"];
const KNOWN_INTENTS = new Set<RequestIntent>([
  "text",
  "general-text",
  "rewrite",
  "emotional-analysis",
  "news-summary",
  "web-search",
  "technical-debugging",
  "architecture-review",
  "code-generation",
  "assistant-reflection",
  "safety-sensitive-vision",
  "vision-analysis",
  "multimodal-reasoning",
  "image-generation"
]);

export const ACK_CONTEXT_TTL_MS = 15 * 60 * 1000;

export function isAcknowledgment(message: string): boolean {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < ACK_MIN_WORDS || words.length > ACK_MAX_WORDS) {
    return false;
  }

  return ACK_PHRASES.some(
    (phrase) => normalized === phrase || normalized.startsWith(`${phrase} `) || normalized.endsWith(` ${phrase}`)
  );
}

export function isSubstantiveIntent(intent: RequestIntent): boolean {
  return !NON_SUBSTANTIVE_INTENTS.includes(intent);
}

export type IntentSessionState = {
  lastSubstantiveIntent: RequestIntent | null;
  lastIntentTimestamp: number | null;
};

export function parseIntentSessionState(memory: Record<string, unknown>): IntentSessionState {
  const state = memory.intentSession;
  if (!state || typeof state !== "object") {
    return { lastSubstantiveIntent: null, lastIntentTimestamp: null };
  }

  const session = state as { lastSubstantiveIntent?: unknown; lastIntentTimestamp?: unknown };
  const parsedTimestamp =
    typeof session.lastIntentTimestamp === "number" && Number.isFinite(session.lastIntentTimestamp)
      ? session.lastIntentTimestamp
      : null;

  return {
    lastSubstantiveIntent:
      typeof session.lastSubstantiveIntent === "string" && KNOWN_INTENTS.has(session.lastSubstantiveIntent as RequestIntent)
        ? (session.lastSubstantiveIntent as RequestIntent)
        : null,
    lastIntentTimestamp: parsedTimestamp
  };
}
