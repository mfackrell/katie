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
import { getKatieOperationalRealityStatement, getKatieReasoningExplainerStatement } from "@/lib/providers/operational-reality";

type ResponseContentItem = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type OpenAiEndpoint = "legacy-completions" | "chat-completions" | "responses";

type ModelClassification = {
  endpoint: OpenAiEndpoint;
  stream: boolean;
  isImageGenerationModel: boolean;
};

type StreamEventWithResponse = {
  type: string;
  response?: OpenAI.Responses.Response;
  data?: OpenAI.Responses.Response;
  delta?: string;
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

${buildMemoryContext(params.history)}`,
    `${getKatieOperationalRealityStatement()}

${getKatieReasoningExplainerStatement()}`
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

function hasVideoAttachments(attachments: FileReference[] | undefined): boolean {
  return Boolean(
    attachments?.some(
      (attachment) =>
        attachment.attachmentKind === "video" || attachment.mimeType.startsWith("video/"),
    ),
  );
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

function classifyModel(modelId: string): ModelClassification {
  const modelLower = modelId.toLowerCase();
  const imageGenerationModel = isImageGenerationModel(modelLower);
  const isLegacy =
    modelLower.includes("instruct") && !modelLower.includes("gpt-4") && !modelLower.includes("gpt-5");

  if (isLegacy) {
    return {
      endpoint: "legacy-completions",
      stream: false,
      isImageGenerationModel: false
    };
  }

  const isResponsesApi =
    (modelLower.includes("gpt-5") || imageGenerationModel || /^o[1-4]/.test(modelLower)) &&
    !modelLower.includes("search-preview");

  if (isResponsesApi) {
    return {
      endpoint: "responses",
      stream: !imageGenerationModel,
      isImageGenerationModel: imageGenerationModel
    };
  }

  return {
    endpoint: "chat-completions",
    stream: true,
    isImageGenerationModel: false
  };
}

function toProviderResponse(
  response: Pick<ProviderResponse, "text" | "content" | "usage">,
  model: string,
  provider: OpenAiProvider["name"]
): ProviderResponse {
  return {
    text: response.text,
    model,
    provider,
    content: response.content,
    usage: response.usage
  };
}

function getCompletedResponseFromEvent(event: unknown): OpenAI.Responses.Response | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }

  const candidate = event as StreamEventWithResponse;
  return candidate.response ?? candidate.data;
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

  private logRequest(
    message: string,
    details: {
      model: string;
      endpoint: OpenAiEndpoint;
      requestedStreaming: boolean;
      actualStreaming: boolean;
      requestedModel?: string;
    }
  ): void {
    console.info(`[OpenAiProvider] ${message}`, details);
  }

  private getModelCandidates(selectedModel: string): string[] {
    return [selectedModel];
  }

  private async generateViaLegacyCompletions(
    selectedModel: string,
    params: ChatGenerateParams
  ): Promise<ProviderResponse> {
    const completion = await this.client.completions.create({
      model: selectedModel,
      prompt: `IDENTITY:\nYour name is ${params.name}. ${BEHAVIORAL_DIRECTIVE}\n\nCORE_PERSONA: ${params.persona}\n\n${MATH_EXECUTION_PROTOCOL}\n\nUser request:\n${params.user}`
    });

    return toProviderResponse({ text: completion.choices[0]?.text ?? "" }, selectedModel, this.name);
  }

  private async generateViaChatCompletions(
    selectedModel: string,
    params: ChatGenerateParams
  ): Promise<ProviderResponse> {
    const completion = await this.client.chat.completions.create({
      model: selectedModel,
      messages: toChatMessages(params)
    });

    return toProviderResponse({ text: completion.choices[0]?.message?.content ?? "" }, selectedModel, this.name);
  }

  private async generateViaResponses(
    selectedModel: string,
    params: ChatGenerateParams,
    classification: ModelClassification
  ): Promise<ProviderResponse> {
    const response = await this.client.responses.create({
      model: selectedModel,
      input: toResponsesInput(params),
      ...(classification.isImageGenerationModel
        ? {
            modalities: ["text", "image"],
            image: { size: "1024x1024" }
          }
        : {})
    });

    const contentItems = extractOutputItems(response);
    const text = extractText(contentItems, response.output_text);

    return toProviderResponse(
      {
        text,
        content: contentItems,
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens
            }
          : undefined
      },
      selectedModel,
      this.name
    );
  }

  private async generateStreamViaChatCompletions(
    selectedModel: string,
    params: ChatGenerateParams,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse> {
    const stream = await this.client.chat.completions.create({
      model: selectedModel,
      messages: toChatMessages(params),
      stream: true
    });

    let fullText = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) {
        continue;
      }

      fullText += delta;
      await handlers.onTextDelta?.(delta);
    }

    return toProviderResponse({ text: fullText }, selectedModel, this.name);
  }

  private async generateStreamViaResponses(
    selectedModel: string,
    params: ChatGenerateParams,
    classification: ModelClassification,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse> {
    const stream = await this.client.responses.create({
      model: selectedModel,
      input: toResponsesInput(params),
      stream: true,
      ...(classification.isImageGenerationModel
        ? {
            modalities: ["text", "image"],
            image: { size: "1024x1024" }
          }
        : {})
    });

    let streamedText = "";
    let completedResponse: OpenAI.Responses.Response | undefined;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) {
          continue;
        }

        streamedText += delta;
        await handlers.onTextDelta?.(delta);
        continue;
      }

      if (event.type === "response.completed") {
        completedResponse = getCompletedResponseFromEvent(event);
      }
    }

    if (!completedResponse) {
      // The SDK exposes Responses streaming as raw SSE events. We can reliably build text from
      // `response.output_text.delta`, but `content` and `usage` are only returned if the final
      // `response.completed` event includes the full response object.
      return toProviderResponse({ text: streamedText }, selectedModel, this.name);
    }

    const contentItems = extractOutputItems(completedResponse);
    const text = extractText(contentItems, completedResponse.output_text) || streamedText;

    return toProviderResponse(
      {
        text,
        content: contentItems,
        usage: completedResponse.usage
          ? {
              inputTokens: completedResponse.usage.input_tokens,
              outputTokens: completedResponse.usage.output_tokens,
              totalTokens: completedResponse.usage.total_tokens
            }
          : undefined
      },
      selectedModel,
      this.name
    );
  }

  private async generateForModel(
    selectedModel: string,
    params: ChatGenerateParams,
    classification: ModelClassification
  ): Promise<ProviderResponse> {
    switch (classification.endpoint) {
      case "legacy-completions":
        return this.generateViaLegacyCompletions(selectedModel, params);
      case "responses":
        return this.generateViaResponses(selectedModel, params, classification);
      case "chat-completions":
      default:
        return this.generateViaChatCompletions(selectedModel, params);
    }
  }

  private async generateStreamForModel(
    selectedModel: string,
    params: ChatGenerateParams,
    classification: ModelClassification,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse> {
    if (hasVideoAttachments(params.attachments) && classification.endpoint !== "responses") {
      throw new Error(
        `OpenAI model ${selectedModel} does not support video attachments in this flow. Use a Responses API-capable model.`,
      );
    }

    if (!classification.stream) {
      this.logRequest("Streaming fallback to non-streaming endpoint", {
        model: selectedModel,
        endpoint: classification.endpoint,
        requestedStreaming: true,
        actualStreaming: false
      });
      return this.generateForModel(selectedModel, params, classification);
    }

    switch (classification.endpoint) {
      case "responses":
        return this.generateStreamViaResponses(selectedModel, params, classification, handlers);
      case "chat-completions":
        return this.generateStreamViaChatCompletions(selectedModel, params, handlers);
      case "legacy-completions":
      default:
        this.logRequest("Streaming fallback to non-streaming endpoint", {
          model: selectedModel,
          endpoint: classification.endpoint,
          requestedStreaming: true,
          actualStreaming: false
        });
        return this.generateForModel(selectedModel, params, classification);
    }
  }

  async generateStream(params: ChatGenerateParams, handlers: ProviderStreamHandlers): Promise<ProviderResponse> {
    const requestedModel = params.modelId ?? this.defaultModel;
    const modelCandidates = this.getModelCandidates(requestedModel);
    let lastError: unknown;

    for (const [index, selectedModel] of modelCandidates.entries()) {
      const classification = classifyModel(selectedModel);

      if (index > 0) {
        this.logRequest("Trying fallback model candidate", {
          requestedModel,
          model: selectedModel,
          endpoint: classification.endpoint,
          requestedStreaming: true,
          actualStreaming: classification.stream
        });
      }

      this.logRequest("Dispatching request", {
        model: selectedModel,
        endpoint: classification.endpoint,
        requestedStreaming: true,
        actualStreaming: classification.stream
      });

      try {
        return await this.generateStreamForModel(selectedModel, params, classification, handlers);
      } catch (error: unknown) {
        lastError = error;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[OpenAiProvider] Streaming API failure for ${selectedModel} via ${classification.endpoint}: ${detail}`);
      }
    }

    throw new Error(`OpenAI streaming request failed for model ${requestedModel}${lastError ? `: ${String(lastError)}` : ""}`);
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const requestedModel = params.modelId ?? this.defaultModel;
    const modelCandidates = this.getModelCandidates(requestedModel);
    let lastError: unknown;

    for (const [index, selectedModel] of modelCandidates.entries()) {
      const classification = classifyModel(selectedModel);
      if (hasVideoAttachments(params.attachments) && classification.endpoint !== "responses") {
        throw new Error(
          `OpenAI model ${selectedModel} does not support video attachments in this flow. Use a Responses API-capable model.`,
        );
      }

      if (index > 0) {
        this.logRequest("Trying fallback model candidate", {
          requestedModel,
          model: selectedModel,
          endpoint: classification.endpoint,
          requestedStreaming: false,
          actualStreaming: false
        });
      }

      this.logRequest("Dispatching request", {
        model: selectedModel,
        endpoint: classification.endpoint,
        requestedStreaming: false,
        actualStreaming: false
      });

      try {
        return await this.generateForModel(selectedModel, params, classification);
      } catch (error: unknown) {
        lastError = error;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[OpenAiProvider] API failure for ${selectedModel} via ${classification.endpoint}: ${detail}`);
      }
    }

    throw new Error(`OpenAI request failed for model ${requestedModel}${lastError ? `: ${String(lastError)}` : ""}`);
  }
}
