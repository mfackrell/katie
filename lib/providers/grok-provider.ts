import OpenAI from "openai";
import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

export class GrokProvider implements LlmProvider {
  name = "grok" as const;
  private client: OpenAI;
  private defaultModel = "grok-2-1212";

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
      fetch: globalThis.fetch.bind(globalThis)
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map((model) => model.id);
    } catch (error) {
      console.error("[GrokProvider] Failed to list models:", error);
      return [];
    }
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const selectedModel = params.modelId ?? this.defaultModel;

    try {
      const completion = await this.client.chat.completions.create({
        model: selectedModel,
        messages: [
          { role: "system", content: params.persona },
          { role: "user", content: `CONVERSATION SUMMARY:\n${params.summary}` },
          ...params.history,
          { role: "user", content: params.user }
        ]
      });

      return {
        text: completion.choices[0]?.message?.content ?? "",
        model: selectedModel,
        provider: this.name
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[GrokProvider] API failure for ${selectedModel}: ${detail}`);
      throw new Error(`Grok request failed for model ${selectedModel}: ${detail}`);
    }
  }
}
