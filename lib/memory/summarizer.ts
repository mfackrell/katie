import OpenAI from "openai";
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
const REBUILD_CHUNK_SIZE = 40;

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
    max_tokens: 1000,
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

  return response.choices[0]?.message?.content?.trim() || priorSummary;
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

    let summary = existing?.summary ?? "";
    let messagesToFold = olderMessages;
    let rebuilding = !existing;

    if (existing?.summarizedThroughMessageId) {
      const markerIndex = olderMessages.findIndex(
        (message) => message.id === existing.summarizedThroughMessageId,
      );

      if (markerIndex >= 0) {
        messagesToFold = olderMessages.slice(markerIndex + 1);
        rebuilding = false;
      } else {
        summary = "";
        messagesToFold = olderMessages;
        rebuilding = true;
      }
    }

    if (!rebuilding && messagesToFold.length === 0) {
      return;
    }

    if (rebuilding) {
      summary = "";
      for (let index = 0; index < messagesToFold.length; index += REBUILD_CHUNK_SIZE) {
        summary = await summarizeInto(summary, messagesToFold.slice(index, index + REBUILD_CHUNK_SIZE));
      }
    } else {
      summary = await summarizeInto(summary, messagesToFold);
    }

    const lastOlderMessage = olderMessages[olderMessages.length - 1];
    await setIntermediateMemory(chat.actorId, chatId, {
      version: 2,
      purpose: "Compressed context older than the 30 most recent completed user-assistant exchanges.",
      summary,
      summarizedThroughMessageId: lastOlderMessage?.id ?? null,
      summarizedThroughCreatedAt: lastOlderMessage?.createdAt ?? null,
      sourceMessageCount: olderMessages.length,
    });
  } catch (error: unknown) {
    console.error("[Summarizer] Failed to update intermediate memory:", error);
  }
}
