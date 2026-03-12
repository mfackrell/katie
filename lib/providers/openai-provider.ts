import OpenAI from "openai";
import {
  ChatGenerateParams,
  FileReference,
  LlmProvider,
  ProviderResponse,
  ProviderStreamHandlers
} from "@/lib/providers/types";
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

const BEHAVIORAL_DIRECTIVE =
  "Always respond in a conversational style. Use a direct, clear, and action-oriented voice. Be direct and to the point. Clearly state the purpose or opinion upfront. Use straightforward language. Focus on actionable points and clear reasoning.";

function buildSystemPromptSections(params: ChatGenerateParams): string[] {
  return [
    `IDENTITY:
Your name is ${params.name}. ${BEHAVIORAL_DIRECTIVE}

CORE_PERSONA: ${params.persona}

${MATH_EXECUTION_PROTOCOL}`,
    `SEMANTIC_MEMORY (Summary):
Below is a summary of past interactions and decisions made.

${params.summary}`,
    `EPISODIC_MEMORY (History):
Below is the recent log of this specific conversation.

${buildMemoryContext(params.history)}`
  ];
}

function buildOpenAiFileInputs(attachments: FileReference[] | undefined): Array<{ type: "input_file"; file_id: string }> {
  if (!attachments?.length) {
    return [];
  }

  return attachments
    .map((attachment) => attachment.providerRef?.openaiFileId)
    .filter((fileId): fileId is string => Boolean(fileId))
    .map((fileId) => ({ type: "input_file", file_id: fileId }));
}

function toChatMessages(params: ChatGenerateParams): OpenAI.Chat.ChatCompletionMessageParam[] {
  const attachmentContext = formatAttachmentContext(params.attachments);
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: params.user }];

  if (params.images) {
    params.images.forEach((url) => {
      userContent.push({ type: "image_url", image_url: { url } });
    });
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = buildSystemPromptSections(params).map((content) => ({
    role: "system",
    content
  }));

  if (attachmentContext) {
    messages.push({ role: "system", content: attachmentContext });
  }

  messages.push({ role: "user", content: userContent });

  return messages;
}

function toResponsesInput(params: ChatGenerateParams): OpenAI.Responses.ResponseInput {
  type ResponseInputContentItem =
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "auto" }
    | { type: "input_file"; file_id: string };

  type ResponseInputMessage = {
    role: "system" | "user";
    content: ResponseInputContentItem[];
  };

  const mapContent = (text: string): ResponseInputContentItem[] => [{ type: "input_text", text }];
  const attachmentContext = formatAttachmentContext(params.attachments);

  const messages: ResponseInputMessage[] = buildSystemPromptSections(params).map((content) => ({
    role: "system",
    content: mapContent(content)
  }));

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

  userContent.push(...buildOpenAiFileInputs(params.attachments));
  messages.push({ role: "user", content: userContent });

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


  async generateStream(params: ChatGenerateParams, handlers: ProviderStreamHandlers): Promise<ProviderResponse> {
    const requestedModel = params.modelId ?? this.defaultModel;
    const modelCandidates = this.getModelCandidates(requestedModel);

    console.log(`[OpenAiProvider] Streaming requested. Model candidates: ${modelCandidates.join(", ")}`);

    for (const selectedModel of modelCandidates) {
      const modelLower = selectedModel.toLowerCase();
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

      if (!isChatOnly && !isResponsesApi) {
        console.log(`[OpenAiProvider] Skipping streaming for non-chat model ${selectedModel}.`);
        continue;
      }

      try {
        console.log(`[OpenAiProvider] Starting streaming request with model ${selectedModel}.`);
        const stream = await this.client.chat.completions.create({
          model: selectedModel,
          messages: toChatMessages(params),
          stream: true
        });

        let fullText = "";
        let firstDeltaLogged = false;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (!delta) {
            continue;
          }

          fullText += delta;

          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            console.log(`[OpenAiProvider] First streamed token received for model ${selectedModel}.`);
          }

          await handlers.onTextDelta?.(delta);
        }

        console.log(
          `[OpenAiProvider] Streaming request complete for ${selectedModel}. Output characters: ${fullText.length}.`
        );

        return {
          text: fullText,
          model: selectedModel,
          provider: this.name
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[OpenAiProvider] Streaming API failure for ${selectedModel}: ${detail}`);
      }
    }

    console.log(
      `[OpenAiProvider] Streaming unavailable or failed for all candidates. Falling back to non-streaming generate for ${requestedModel}.`
    );

    return this.generate(params);
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
            prompt: `IDENTITY:\nYour name is ${params.name}. ${BEHAVIORAL_DIRECTIVE}\n\nCORE_PERSONA: ${params.persona}\n\n${MATH_EXECUTION_PROTOCOL}\n\nUser request:\n${params.user}`
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
