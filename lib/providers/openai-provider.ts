import OpenAI from "openai";
import { LlmProvider, ChatGenerateParams, ProviderResponse } from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";

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

function toChatMessages(params: ChatGenerateParams): OpenAI.Chat.ChatCompletionMessageParam[] {
  const attachmentContext = formatAttachmentContext(params.attachments);
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: params.user }];

  if (params.images) {
    params.images.forEach((url) => {
      userContent.push({ type: "image_url", image_url: { url } });
    });
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}` },
    { role: "system", content: `MEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT` },
    { role: "system", content: buildMemoryContext(params.history) },
  ];

  if (attachmentContext) {
    messages.push({ role: "system", content: attachmentContext });
  }

  messages.push({ role: "user", content: userContent });

  return messages;
}

function toResponsesInput(params: ChatGenerateParams): OpenAI.Responses.ResponseInput {
  type ResponseInputContentItem =
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "auto" };

  type ResponseInputMessage = {
    role: "system" | "user";
    content: ResponseInputContentItem[];
  };

  const mapContent = (text: string): ResponseInputContentItem[] => [{ type: "input_text", text }];
  const memoryContext = buildMemoryContext(params.history);
  const attachmentContext = formatAttachmentContext(params.attachments);

  const messages: ResponseInputMessage[] = [
    { role: "system", content: mapContent(`${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}`) },
    { role: "system", content: mapContent(`MEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT`) },
    { role: "system", content: mapContent(memoryContext) }
  ];

  if (attachmentContext) {
    messages.push({ role: "system", content: mapContent(attachmentContext) });
  }

  const userContent: ResponseInputContentItem[] = [{ type: "input_text", text: params.user }];
  if (params.images) {
    params.images.forEach((url) => {
      userContent.push({
        type: "input_image",
        image_url: url,
        detail: "auto"
      });
    });
  }

  messages.push({ role: "user", content: userContent });

  // Cast via unknown to satisfy generate() while preserving the required runtime payload.
  return messages as unknown as OpenAI.Responses.ResponseInput;
}

function extractOutputItems(response: OpenAI.Responses.Response): ResponseContentItem[] {
  const items: ResponseContentItem[] = [];

  for (const outputItem of response.output ?? []) {
    if (!outputItem) {
      continue;
    }

    if (
      outputItem.type === "image_generation_call" &&
      "result" in outputItem &&
      typeof outputItem.result === "string"
    ) {
      items.push({ type: outputItem.type, b64_json: outputItem.result });
    }

    if (!("content" in outputItem) || !Array.isArray(outputItem.content)) {
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

function isImageGenerationModel(modelLower: string): boolean {
  return modelLower.includes("image") || modelLower.includes("nano-banana");
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

      const isLegacy =
        modelLower.includes("instruct") && !modelLower.includes("gpt-4") && !modelLower.includes("gpt-5");

      const isChatOnly =
        modelLower.includes("search-preview") ||
        (modelLower.includes("gpt-4") && !modelLower.includes("gpt-5")) ||
        modelLower.includes("gpt-3.5");

      const isResponsesApi =
        (modelLower.includes("gpt-5") ||
          modelLower.includes("image") ||
          modelLower.includes("nano-banana") ||
          /^o[1-4]/.test(modelLower)) &&
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
          const wantsImageOutput = isImageGenerationModel(modelLower);
          const response = await this.client.responses.create({
            model: selectedModel,
            input: toResponsesInput(params),
            ...(wantsImageOutput
              ? {
                  modalities: ["text", "image"],
                  image: { size: "1024x1024" }
                }
              : {})
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
            messages: toChatMessages(params)
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
