import OpenAI from "openai";
import { createActivityAccountingFetch } from "@/lib/standalone-accounting/activity";
import { isStandaloneAccountingError } from "@/lib/standalone-accounting/context";
import { getRecentMessages } from "@/lib/data/persistence-store";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";

// The relevance screen never receives actor LTM. It is cheap, high-recall,
// and distinct from the expensive, independently verified memory editor.
const SCREEN_MODEL = "gpt-4o-mini";
const SCREEN_CONTEXT_MESSAGES = 4;
const SCREEN_MESSAGE_CHARS = 4500;
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      fetch: createActivityAccountingFetch("openai", "memory-relevance"),
    })
  : null;

function boundedText(value: string): string {
  if (value.length <= SCREEN_MESSAGE_CHARS) return value;
  const half = Math.floor(SCREEN_MESSAGE_CHARS / 2);
  return value.slice(0, half) + "\n[...middle omitted for relevance screening...]\n" + value.slice(-half);
}

/**
 * Fail open on ambiguous/model failures so user facts are never silently lost.
 * Provider spending approvals still fail closed via the accounting boundary.
 */
export async function isLongTermMemoryCandidate(chatId: string, latestUserMessage: string): Promise<boolean> {
  if (!latestUserMessage.trim()) return false;
  if (!client) {
    console.warn("[LTM Relevance] Screening unavailable; preserving learning via editor");
    return true;
  }
  try {
    const recent = await getRecentMessages(chatId, SCREEN_CONTEXT_MESSAGES + 2);
    const context = recent
      .filter(message => message.role === "user" || message.role === "assistant")
      .slice(-SCREEN_CONTEXT_MESSAGES)
      .map(message => message.role.toUpperCase() + ": " + boundedText(message.content))
      .join("\n\n");
    const response = await client.chat.completions.create({
      model: SCREEN_MODEL, temperature: 0, max_tokens: 90,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: [
          "You are a low-cost, high-recall RELEVANCE SCREEN for Katie's actor-wide long-term memory.",
          "Examine the latest HUMAN user message and limited recent conversation for context.",
          "Return {\"relevant\":true} if the latest message might add, amend, or correct any durable user fact, important personal or professional history, lasting interaction preference, repeated feedback, relationship, goal, constraint, significant decision or generalizable lesson.",
          "A short reply may refine an earlier USER statement. For uncertain substantive information choose true.",
          "Return {\"relevant\":false} for greetings, incidental banter, fantasy/roleplay, quotations not endorsed by the user, purely transient events, and one-off task instructions that do not establish enduring facts or preferences.",
          "Assistant guesses and quoted third-party claims are not facts about the user. Do not save or edit anything; return only a JSON object containing the relevant boolean.",
        ].join("\n") },
        { role: "user", content: "LATEST HUMAN MESSAGE:\n" + boundedText(latestUserMessage) +
          "\n\nRECENT CONTEXT (not independent evidence):\n" + context },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "";
    const decision: unknown = JSON.parse(raw);
    if (!decision || typeof decision !== "object" || !("relevant" in decision) ||
        typeof decision.relevant !== "boolean") throw new Error("Invalid memory relevance decision");
    return decision.relevant;
  } catch (error) {
    if (isStandaloneAccountingError(error)) throw error;
    console.error("[LTM Relevance] Screening failure; preserving learning", {
      chatId, error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export async function maybeUpdateRelevantLongTermMemory(
  actorId: string, chatId: string, latestUserMessage: string
): Promise<void> {
  const relevant = await isLongTermMemoryCandidate(chatId, latestUserMessage);
  console.info("[LTM Relevance] Screen result", { actorId, chatId, relevant });
  if (relevant) await maybeUpdateLongTermMemory(actorId, chatId, latestUserMessage);
}
