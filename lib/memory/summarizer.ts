import OpenAI from "openai";
import { getRecentMessages } from "@/lib/data/blob-store";
import { setConversationSummary } from "@/lib/data/blob-store";

const summarizerModel = "gpt-4o-mini";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export async function maybeUpdateSummary(actorId: string): Promise<void> {
  const recent = await getRecentMessages(actorId, 60);

  if (!client || recent.length < 3 || recent.length % 2 !== 0) {
    return;
  }

  const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");

  const response = await client.chat.completions.create({
    model: summarizerModel,
    messages: [
      {
        role: "system",
        content:
          "Summarize the ongoing conversation as themes, decisions made, open questions, and current blockers. Keep it concise and factual. IMPORTANT: Refer to the assistant ONLY as 'The Assistant' or 'Katie'. Do NOT use brand names like GPT, Grok, or Gemini."
      },
      { role: "user", content: transcript }
    ]
  });

  const summary = response.choices[0]?.message?.content?.trim();
  if (summary) {
    await setConversationSummary(actorId, summary);
  }
}
