import OpenAI from "openai";
import { LlmProvider, ChatGenerateParams, ProviderResponse } from "@/lib/providers/types";

export class OpenAiProvider implements LlmProvider {
  name = "openai" as const;
  private client: OpenAI;
  private defaultModel = "gpt-4o";

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, fetch: globalThis.fetch.bind(globalThis) });
  }

  async listModels(): Promise<string[]> {
    const models = await this.client.models.list();
    return models.data.map((model) => model.id);
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const completion = await this.client.chat.completions.create({
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
