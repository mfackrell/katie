import OpenAI from "openai";
import { LlmProvider } from "@/lib/providers/types";

function keywordOverride(prompt: string): "openai" | "google" | null {
  const lowered = prompt.toLowerCase();
  if (lowered.includes("use gpt") || lowered.includes("use openai")) {
    return "openai";
  }

  if (lowered.includes("use gemini") || lowered.includes("use google")) {
    return "google";
  }

  return null;
}

export async function chooseProvider(prompt: string, providers: LlmProvider[]): Promise<LlmProvider> {
  const override = keywordOverride(prompt);
  if (override) {
    const match = providers.find((provider) => provider.name === override);
    if (match) {
      return match;
    }
  }

  if (providers.length === 1) {
    return providers[0];
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const options = providers.map((provider) => provider.name).join(", ");

      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a routing model. Return only one provider name from the allowed options. Prefer google for long-form synthesis and openai for coding/logic."
          },
          {
            role: "user",
            content: `Prompt: ${prompt}\nAllowed providers: ${options}`
          }
        ]
      });

      const choice = completion.choices[0]?.message?.content?.trim().toLowerCase();
      const selected = providers.find((provider) => provider.name === choice);
      if (selected) {
        return selected;
      }
    } catch (error) {
      console.warn("Provider router model failed; falling back to heuristics.", error);
    }
  }

  if (prompt.length > 600) {
    return providers.find((provider) => provider.name === "google") ?? providers[0];
  }

  return providers.find((provider) => provider.name === "openai") ?? providers[0];
}
