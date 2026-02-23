import { openaiClient } from "@/lib/openai";
import { LlmProvider, ChatGenerateParams, ProviderResponse } from "@/lib/providers/types";

export class OpenAiProvider implements LlmProvider {
  name = "openai" as const;
  private defaultModel = "gpt-4o";

  constructor(apiKey: string) {
    void apiKey;
  }

  async listModels(): Promise<string[]> {
    if (!openaiClient) {
      return [];
    }

    const models = await openaiClient.models.list();
    return models.data.map((model) => model.id);
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    if (!openaiClient) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const completion = await openaiClient.chat.completions.create({
      model: this.defaultModel,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user }
      ]
    });

    return {
      text: completion.choices[0]?.message?.content ?? "",
      model: this.defaultModel,
      provider: this.name
    };
  }
}
