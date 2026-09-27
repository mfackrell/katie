import {
  getRecentMessages,
  setShortTermMemory,
} from "@/lib/data/persistence-store";
import { SHORT_TERM_MESSAGE_LIMIT } from "@/lib/memory/memory-contract";
import type { Message } from "@/lib/types/chat";

type ShortTermExchange = {
  user: {
    id: string;
    createdAt: string;
    content: string;
  };
  assistant: {
    id: string;
    createdAt: string;
    content: string;
    model?: string;
  };
};

function toExchange(user: Message, assistant: Message): ShortTermExchange {
  return {
    user: {
      id: user.id,
      createdAt: user.createdAt,
      content: user.content,
    },
    assistant: {
      id: assistant.id,
      createdAt: assistant.createdAt,
      content: assistant.content,
      ...(assistant.model ? { model: assistant.model } : {}),
    },
  };
}

export function filterConversationalMessages(messages: Message[]): Message[] {
  const filtered: Message[] = [];
  let pendingUser: Message | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }

    if (message.role === "assistant" && pendingUser) {
      if (message.model !== "katie-local") {
        filtered.push(pendingUser, message);
      }
      pendingUser = null;
    }
  }

  return filtered;
}

export function buildRecentExchanges(messages: Message[]): ShortTermExchange[] {
  const exchanges: ShortTermExchange[] = [];
  let pendingUser: Message | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }

    if (message.role === "assistant" && pendingUser) {
      // Local prompt/memory inspection responses are operational diagnostics.
      // Keep them in the chat transcript, but do not recursively feed a full
      // memory dump back into Katie's conversational memory.
      if (message.model !== "katie-local") {
        exchanges.push(toExchange(pendingUser, message));
      }
      pendingUser = null;
    }
  }

  return exchanges.slice(-30);
}

export async function refreshShortTermMemory(actorId: string, chatId: string): Promise<void> {
  const recentMessages = await getRecentMessages(chatId, SHORT_TERM_MESSAGE_LIMIT + 4);
  const exchanges = buildRecentExchanges(recentMessages);

  await setShortTermMemory(actorId, chatId, {
    version: 2,
    purpose: "The 30 most recent completed conversational user-assistant exchanges, stored verbatim. Local prompt/memory diagnostic dumps are excluded to prevent recursive context injection.",
    exchangeCount: exchanges.length,
    exchanges,
  });
}
