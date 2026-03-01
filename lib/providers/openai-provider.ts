import OpenAI from "openai";
import { LlmProvider, ChatGenerateParams, ProviderResponse } from "@/lib/providers/types";

type ResponseContentItem = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

const MODEL_FALLBACKS: Record<string, string[]> = {
  "gpt-5.3-codex": ["gpt-5.2", "gpt-4o"],
  "gpt-5.3": ["gpt-5.2", "gpt-4o"],
  "gpt-5": ["gpt-5.2", "gpt-4o"]
};

function toStatefulInput(params: ChatGenerateParams): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  return [
    { role: "system", content: params.persona },
    { role: "system", content: `CONVERSATION SUMMARY:\n${params.summary}` },
    ...params.history.map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: params.user }
  ];
}

function extractOutputItems(response: OpenAI.Responses.Response): ResponseContentItem[] {
  const items: ResponseContentItem[] = [];

  for (const outputItem of response.output ?? []) {
    if (!outputItem || !("content" in outputItem) || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (!contentItem || typeof contentItem.type !== "string") {
        continue;
      }

      const normalizedItem: ResponseContentItem = { ...contentItem, type: contentItem.type };

      if ("text" in contentItem && typeof contentItem.text === "string") {
        normalizedItem.text = contentItem.text;
      }

      items.push(normalizedItem);
    }
  }

  return items;
}

function extractText(outputItems: ResponseContentItem[], outputText: string | null | undefined): string {
  if (outputText && outputText.trim()) {
    return outputText;
  }

  return outputItems
    .filter((item) => item.type.includes("text") && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

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

  private getModelCandidates(selectedModel: string): string[] {
    const configuredFallbacks = MODEL_FALLBACKS[selectedModel] ?? [];
    return [selectedModel, ...configuredFallbacks.filter((candidate) => candidate !== selectedModel)];
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const requestedModel = params.modelId ?? this.defaultModel;
    const modelCandidates = this.getModelCandidates(requestedModel);
    let lastError: unknown;

    for (const selectedModel of modelCandidates) {
      const modelLower = selectedModel.toLowerCase();

      // 1. LEGACY ROUTING: For gpt-3.5-turbo-instruct and older Davinci models
      const isLegacy =
        modelLower.includes("instruct") && !modelLower.includes("gpt-4") && !modelLower.includes("gpt-5");

      // 2. CHAT COMPLETIONS ROUTING: Specifically for gpt-4, gpt-3.5, and Search Preview models
      // The 'search-preview' models are NOT supported on the Responses API.
      const isChatOnly =
        modelLower.includes("search-preview") ||
        (modelLower.includes("gpt-4") && !modelLower.includes("gpt-5")) ||
        modelLower.includes("gpt-3.5");

      // 3. RESPONSES API ROUTING: For GPT-5, image, and o-series reasoning models (excluding search preview)
      const isResponsesApi =
        (modelLower.includes("gpt-5") || modelLower.includes("image") || /^o[1-4]/.test(modelLower)) &&
        !modelLower.includes("search-preview");

      try {
        if (isLegacy) {
          const completion = await this.client.completions.create({
            model: selectedModel,
            prompt: `${params.persona}\n\nUser request:\n${params.user}`
          });

          return {
            text: completion.choices[0]?.text ?? "",
            model: selectedModel,
            provider: this.name
          };
        }

        if (isResponsesApi) {
          const response = await this.client.responses.create({
            model: selectedModel,
            input: toStatefulInput(params)
          });

          const contentItems = extractOutputItems(response);
          const text = extractText(contentItems, response.output_text);

          return {
            text,
            model: selectedModel,
            provider: this.name,
            content: contentItems,
            usage: response.usage
              ? {
                  inputTokens: response.usage.input_tokens,
                  outputTokens: response.usage.output_tokens,
                  totalTokens: response.usage.total_tokens
                }
              : undefined
          };
        }

        if (isChatOnly || !isLegacy) {
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
      } catch (error: unknown) {
        lastError = error;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[OpenAiProvider] API failure for ${selectedModel}: ${detail}`);
      }
    }

    throw new Error(`OpenAI request failed for model ${requestedModel}${lastError ? `: ${String(lastError)}` : ""}`);
  }
}
