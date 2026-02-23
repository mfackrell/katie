import { getRecentMessages } from "@/lib/data/blob-store";
import { setConversationSummary } from "@/lib/data/blob-store";
import { openaiClient } from "@/lib/openai";

const summarizerModel = "gpt-4o-mini";

export async function maybeUpdateSummary(chatId: string): Promise<void> {
  const recent = await getRecentMessages(chatId, 60);

  if (!openaiClient || recent.length < 10 || recent.length % 5 !== 0) {
    return;
  }

  const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");

  const response = await openaiClient.chat.completions.create({
    model: summarizerModel,
    messages: [
      {
        role: "system",
        content:
          "Summarize the ongoing conversation as themes, decisions made, open questions, and current blockers. Keep it concise and factual."
      },
      { role: "user", content: transcript }
    ]
  });

  const summary = response.choices[0]?.message?.content?.trim();
  if (summary) {
    await setConversationSummary(chatId, summary);
  }
}
