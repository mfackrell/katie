import {
  getConversationSummary,
  getLongTermMemory,
  getRecentMessages,
  setLongTermMemory
} from "@/lib/data/persistence-store";

const MEMORY_EDITOR_MODEL = "gpt-4o-mini";
const MEMORY_EDITOR_HISTORY_WINDOW = 12;

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

type MemoryEditorAction =
  | { action: "no_change" }
  | { action: "replace"; updatedContent: JsonRecord };

function parseMemoryEditorResult(raw: string): MemoryEditorAction | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.action === "no_change") {
      return { action: "no_change" };
    }

    if (parsed.action !== "replace") {
      return null;
    }

    const updatedContent = parsed.updatedContent;
    if (!updatedContent || typeof updatedContent !== "object" || Array.isArray(updatedContent)) {
      return null;
    }

    return {
      action: "replace",
      updatedContent: updatedContent as JsonRecord
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
      return `${index + 1}. ${message.role}${timestamp}: ${message.content}`;
    })
    .join("\n");
}

export async function maybeUpdateLongTermMemory(actorId: string, chatId: string, latestUserMessage: string): Promise<void> {
  try {
    const client = getMemoryEditorClient();
    if (!client) {
      return;
    }

    const [currentLongTermMemory, recentMessages, existingSummary] = await Promise.all([
      getLongTermMemory(actorId, chatId),
      getRecentMessages(chatId, MEMORY_EDITOR_HISTORY_WINDOW),
      getConversationSummary(chatId)
    ]);

    const response = await client.chat.completions.create({
      model: MEMORY_EDITOR_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a long-term memory editor for one actor+chat memory record. Decide whether the latest user message requires a durable update to the existing long_term_memory.content object. Preserve existing memory unless there is clear reason to revise or remove it. Prefer no_change for temporary, trivial, or low-value details unless the user clearly requests retention. Understand natural language requests to remember or forget details. Return strictly valid JSON with either {\"action\":\"no_change\"} or {\"action\":\"replace\",\"updatedContent\":<full revised long_term_memory.content object>}. updatedContent must be the complete revised object to store, preserving the existing shape whenever possible."
        },
        {
          role: "user",
          content: [
            `actorId: ${actorId}`,
            `chatId: ${chatId}`,
            `latestUserMessage: ${latestUserMessage}`,
            `existingLongTermMemoryContent: ${JSON.stringify(currentLongTermMemory)}`,
            `rollingSummary: ${existingSummary || ""}`,
            "recentMessages:",
            formatTranscript(recentMessages),
            "Output JSON only."
          ].join("\n\n")
        }
      ]
    });

    const rawResult = response.choices?.[0]?.message?.content?.trim();
    if (!rawResult) {
      return;
    }

    const decision = parseMemoryEditorResult(rawResult);
    if (!decision || decision.action === "no_change") {
      return;
    }

    await setLongTermMemory(actorId, chatId, decision.updatedContent);
  } catch (error: unknown) {
    console.error("[LongTermMemoryEditor] Failed to evaluate long-term memory update:", error);
  }
}
