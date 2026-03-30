import OpenAI from "openai";
import { getConversationSummary, getRecentMessages, setConversationSummary as saveConversationSummary } from "@/lib/data/persistence-store";

const SUMMARY_INTERVAL = 5;
const SUMMARY_MESSAGE_WINDOW = 20;
const SUMMARY_MODEL = "gpt-4o-mini";

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function formatTranscript(messages: Awaited<ReturnType<typeof getRecentMessages>>): string {
  return messages
    .map((message, index) => {
      const timestamp = message.createdAt ? ` (${message.createdAt})` : "";
      return `${index + 1}. ${message.role}${timestamp}: ${message.content}`;
    })
    .join("\n");
}

export async function maybeUpdateSummary(chatId: string): Promise<void> {
  try {
    if (!client) {
      return;
    }

    const allMessages = await getRecentMessages(chatId, Number.MAX_SAFE_INTEGER);
    const messageCount = allMessages.length;

    if (!messageCount || messageCount % SUMMARY_INTERVAL !== 0) {
      return;
    }

    const [existingSummary, recentMessages] = await Promise.all([
      getConversationSummary(chatId),
      Promise.resolve(allMessages.slice(-SUMMARY_MESSAGE_WINDOW))
    ]);

    if (!recentMessages.length) {
      return;
    }

    const response = await client.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You maintain a rolling conversation summary for a memory system. Produce exactly one paragraph that merges the prior summary with the newest conversation details. Preserve durable facts, decisions, goals, constraints, unresolved questions, and newly introduced context. Do not use bullet points. If there is no prior summary, create one from the recent messages only."
        },
        {
          role: "user",
          content: [
            `Chat ID: ${chatId}`,
            `Existing summary: ${existingSummary || "None yet."}`,
            "Recent messages to fold in:",
            formatTranscript(recentMessages),
            "Return only the updated rolling summary as a single paragraph."
          ].join("\n\n")
        }
      ]
    });

    const updatedSummary = response.choices[0]?.message?.content?.trim();

    if (!updatedSummary) {
      return;
    }

    await saveConversationSummary(chatId, updatedSummary);
  } catch (error: unknown) {
    console.error("[Summarizer] Failed to update rolling summary:", error);
  }
}
