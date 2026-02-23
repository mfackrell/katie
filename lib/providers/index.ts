import { GoogleProvider } from "@/lib/providers/google-provider";
import { OpenAiProvider } from "@/lib/providers/openai-provider";
import { LlmProvider } from "@/lib/providers/types";

export function getAvailableProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push(new OpenAiProvider(process.env.OPENAI_API_KEY));
  }

  if (process.env.GOOGLE_API_KEY) {
    providers.push(new GoogleProvider(process.env.GOOGLE_API_KEY));
  }

  return providers;
}
