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
    const selectedModel = params.modelId ?? this.defaultModel;
    const isLegacyCompletionModel =
      selectedModel.toLowerCase().includes("codex") || selectedModel.toLowerCase().includes("instruct");

    if (isLegacyCompletionModel) {
      const completion = await this.client.completions.create({
        model: selectedModel,
        prompt: `${params.persona}\n\nCONVERSATION SUMMARY:\n${params.summary}\n\nUser request:\n${params.user}`
      });

      return {
        text: completion.choices[0]?.text ?? "",
        model: selectedModel,
        provider: this.name
      };
    }

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
  }
}
