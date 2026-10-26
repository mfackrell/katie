import OpenAI from "openai";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import {
  getChatById,
  getIntermediateMemory,
  getRecentMessages,
  setIntermediateMemory,
} from "@/lib/data/persistence-store";
import { SHORT_TERM_MESSAGE_LIMIT } from "@/lib/memory/memory-contract";
import { filterConversationalMessages } from "@/lib/memory/short-term";
import type { Message } from "@/lib/types/chat";

const SUMMARY_MODEL = "gpt-4o-mini";
const SUMMARY_BATCH_MESSAGES = 20; // Ten completed user-assistant exchanges.
const SUMMARY_MAX_TOKENS = 2000;

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

type IntermediateMemoryV2 = {
  version: 2;
  purpose: string;
  summary: string;
  summarizedThroughMessageId: string | null;
  summarizedThroughCreatedAt: string | null;
  sourceMessageCount: number;
};

function formatTranscript(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const timestamp = message.createdAt ? ` (${message.createdAt})` : "";
      return `${index + 1}. ${message.role.toUpperCase()}${timestamp}: ${message.content}`;
    })
    .join("\n");
}

async function summarizeInto(priorSummary: string, messages: Message[]): Promise<string> {
  if (!client || messages.length === 0) {
    return priorSummary;
  }

  const response = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.1,
    max_tokens: SUMMARY_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: [
          "You maintain Katie's INTERMEDIATE MEMORY.",
          "Katie is the assistant. The human speaker is the user. Never call the user Katie, and never attribute Katie's assistant statements, judgments, or recommendations to the user.",
          "Refer to the human as 'the user' unless the user's name is explicitly present in the source transcript.",
          "This layer summarizes conversation that is OLDER than the 30 most recent user-assistant exchanges.",
          "Rewrite the summary as a compact historical context; do not append a chronological diary.",
          "Preserve meaningful developments, unresolved topics, decisions, goals, important context, and changes over time.",
          "Do not preserve exact transcript wording unless the wording itself is important.",
          "Do not duplicate the same point in multiple forms.",
          "Do not treat assistant statements or interpretations as facts the user stated.",
          "Do not include routing state, model names, temporary UI/debug details, or ephemeral travel/status unless historically important.",
          "Keep the complete updated summary concise, ideally 400-700 words and never more than 900 words.",
          "Return only the rewritten intermediate-memory summary.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Prior intermediate summary:\n${priorSummary || "(none)"}`,
          "Older messages newly entering intermediate memory:",
          formatTranscript(messages),
        ].join("\n\n"),
      },
    ],
  });

  const choice = response.choices[0];
  const summary = choice?.message?.content?.trim();
  // Never advance the durable source cursor past incomplete or absent output.
  // The next request must be able to retry these exact source messages.
  if (choice?.finish_reason !== "stop" || !summary) {
    throw new Error("Intermediate memory summary incomplete; source cursor retained");
  }
  return summary;
}

function parseV2(memory: Record<string, unknown>): IntermediateMemoryV2 | null {
  if (memory.version !== 2 || typeof memory.summary !== "string") {
    return null;
  }

  return {
    version: 2,
    purpose:
      typeof memory.purpose === "string"
        ? memory.purpose
        : "Compressed context older than the 30 most recent exchanges.",
    summary: memory.summary,
    summarizedThroughMessageId:
      typeof memory.summarizedThroughMessageId === "string"
        ? memory.summarizedThroughMessageId
        : null,
    summarizedThroughCreatedAt:
      typeof memory.summarizedThroughCreatedAt === "string"
        ? memory.summarizedThroughCreatedAt
        : null,
    sourceMessageCount:
      typeof memory.sourceMessageCount === "number" ? memory.sourceMessageCount : 0,
  };
}

export async function maybeUpdateSummary(chatId: string): Promise<void> {
  try {
    if (!client) {
      return;
    }

    const chat = await getChatById(chatId);
    if (!chat) {
      return;
    }

    const [allMessages, existingRaw] = await Promise.all([
      getRecentMessages(chatId, Number.MAX_SAFE_INTEGER),
      getIntermediateMemory(chat.actorId, chatId),
    ]);

    const conversationalMessages = filterConversationalMessages(allMessages);
    const olderMessages =
      conversationalMessages.length > SHORT_TERM_MESSAGE_LIMIT
        ? conversationalMessages.slice(0, conversationalMessages.length - SHORT_TERM_MESSAGE_LIMIT)
        : [];

    const existing = parseV2(existingRaw);

    if (olderMessages.length === 0) {
      if (!existing || existing.summary || existing.sourceMessageCount !== 0) {
        await setIntermediateMemory(chat.actorId, chatId, {
          version: 2,
          purpose: "Compressed context older than the 30 most recent completed user-assistant exchanges.",
          summary: "",
          summarizedThroughMessageId: null,
          summarizedThroughCreatedAt: null,
          sourceMessageCount: 0,
        });
      }
      return;
    }

    // Each completed batch is independently durable. Retrying an incomplete model
    // response does not skip any source messages or advance the cursor.
    let summary = existing?.summary ?? "";
    let messagesToFold = olderMessages;
    if (existing?.summarizedThroughMessageId) {
      const markerIndex = olderMessages.findIndex(
        (message) => message.id === existing.summarizedThroughMessageId,
      );
      if (markerIndex >= 0) {
        messagesToFold = olderMessages.slice(markerIndex + 1);
      } else {
        // The stored cursor no longer exists in source history. Rebuild safely.
        summary = "";
      }
    }
    if (messagesToFold.length === 0) return;

    // A single request performs at most three batches; subsequent requests
    // continue from the stored cursor without a full-history model call.
    for (let offset = 0; offset < messagesToFold.length && offset < SUMMARY_BATCH_MESSAGES * 3;) {
      let size = Math.min(SUMMARY_BATCH_MESSAGES, messagesToFold.length - offset);
      let candidate: string;
      try {
        candidate = await summarizeInto(summary, messagesToFold.slice(offset, offset + size));
      } catch {
        // One attempt with half as many messages. If that fails, leave the
        // source cursor exactly where it was and retry on the next invocation.
        size = Math.min(10, size);
        console.warn("[Summarizer] Batch incomplete; retrying smaller batch", { chatId, size });
        candidate = await summarizeInto(summary, messagesToFold.slice(offset, offset + size));
      }
      const checkpoint = messagesToFold[offset + size - 1];
      // Atomic database comparison prevents concurrent requests from overwriting
      // newer summaries, including two requests attempting the first checkpoint.
      const expectedCursor = offset === 0
        ? existing?.summarizedThroughMessageId ?? null
        : messagesToFold[offset - 1]?.id ?? null;
      const payload = {
        version: 2,
        purpose: "Compressed context older than the 30 most recent completed user-assistant exchanges.",
        summary: candidate,
        summarizedThroughMessageId: checkpoint.id,
        summarizedThroughCreatedAt: checkpoint.createdAt ?? null,
        sourceMessageCount: olderMessages.findIndex(message => message.id === checkpoint.id) + 1,
      };
      const { data: committed, error: commitError } = await getSupabaseAdminClient()
        .rpc("commit_intermediate_memory_checkpoint", {
          p_actor_id: chat.actorId,
          p_chat_id: chatId,
          p_expected_cursor: expectedCursor,
          p_content: payload,
        });
      if (commitError) throw new Error(`Intermediate memory checkpoint unavailable: ${commitError.message}`);
      if (committed !== true) {
        console.info("[Summarizer] Concurrent checkpoint moved; deferring", { chatId });
        return;
      }
      summary = candidate;
      offset += size;
    }
  } catch (error: unknown) {
    console.error("[Summarizer] Failed to update intermediate memory:", error);
  }
}
