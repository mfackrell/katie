import OpenAI from "openai";
import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";

function isWebSearchIntent(requestIntent: string | undefined): boolean {
  return requestIntent === "web-search" || requestIntent === "news-summary";
}

function extractResponseText(response: OpenAI.Responses.Response): string {
  if (response.output_text?.trim()) {
    return response.output_text;
  }

  return (response.output ?? [])
    .flatMap((item) => ("content" in item && Array.isArray(item.content) ? item.content : []))
    .filter((part): part is { text: string } => "text" in part && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export class GrokProvider implements LlmProvider {
  name = "grok" as const;
  private client: OpenAI;
  private defaultModel = "grok-2-1212";
  private aliasToModel: Record<string, string> = {
    "grok-imagine": this.defaultModel,
    "grok-imagine-image": this.defaultModel
  };

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
    const requestedModel = params.modelId ?? this.defaultModel;
    const aliasedModel = this.aliasToModel[requestedModel] ?? requestedModel;

    const availableModels = await this.listModels();
    const selectedModel = availableModels.length === 0 || availableModels.includes(aliasedModel)
      ? aliasedModel
      : this.defaultModel;

    if (selectedModel !== requestedModel) {
      console.warn(
        `[GrokProvider] Requested model '${requestedModel}' is not available. Falling back to '${selectedModel}'.`
      );
    }

    try {
      const attachmentContext = formatAttachmentContext(params.attachments);
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}` },
        { role: "system", content: `MEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT` },
        { role: "system", content: buildMemoryContext(params.history) }
      ];

      if (attachmentContext) {
        messages.push({ role: "system", content: attachmentContext });
        messages.push({
          role: "system",
          content: "IMPORTANT: Attachment previews are truncated excerpts, not full files."
        });
      }

      messages.push({ role: "user", content: params.user });

      if (isWebSearchIntent(params.requestIntent)) {
        const input: OpenAI.Responses.ResponseInput = [
          {
            role: "system",
            content: [{ type: "input_text", text: `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}` }]
          },
          {
            role: "system",
            content: [{ type: "input_text", text: `MEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT` }]
          },
          {
            role: "system",
            content: [{ type: "input_text", text: buildMemoryContext(params.history) }]
          },
          ...(attachmentContext
            ? [
                {
                  role: "system" as const,
                  content: [{ type: "input_text" as const, text: attachmentContext }]
                },
                {
                  role: "system" as const,
                  content: [
                    {
                      type: "input_text" as const,
                      text: "IMPORTANT: Attachment previews are truncated excerpts, not full files."
                    }
                  ]
                }
              ]
            : []),
          { role: "user", content: [{ type: "input_text", text: params.user }] }
        ];

        const response = await this.client.responses.create({
          model: selectedModel,
          input,
          tools: [{ type: "web_search" }]
        });

        return {
          text: extractResponseText(response),
          model: selectedModel,
          provider: this.name
        };
      }

      const completion = await this.client.chat.completions.create({
        model: selectedModel,
        messages
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
