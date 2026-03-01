import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

type ClaudeMessageResponse = {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
};

const MODEL_MAPPING: Record<string, string> = {
  "claude-4.6-opus": "claude-3-opus-20240229",
  "claude-4.5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-4.5-haiku": "claude-3-5-haiku-20241022"
};

export class ClaudeProvider implements LlmProvider {
  name = "anthropic" as const;
  private defaultModel = "claude-4.5-sonnet";

  constructor(private apiKey: string) {}

  async listModels(): Promise<string[]> {
    return ["claude-4.6-opus", "claude-4.5-sonnet", "claude-4.5-haiku"];
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const selectedModel = params.modelId ?? this.defaultModel;
    const actualModelId = MODEL_MAPPING[selectedModel] ?? selectedModel;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: actualModelId,
        max_tokens: 4096,
        system: `${params.persona}\n\nCONVERSATION SUMMARY:\n${params.summary}`,
        messages: [
          ...params.history.map((entry) => ({
            role: entry.role,
            content: entry.content
          })),
          { role: "user", content: params.user }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error(
        `[ClaudeProvider] API failure for ${selectedModel} (resolved to ${actualModelId}): ${detail}`
      );
      throw new Error(
        `Claude request failed for model ${selectedModel} (resolved to ${actualModelId}): ${detail}`
      );
    }

    const body = (await response.json()) as ClaudeMessageResponse;
    const text = (body.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();

    return {
      text,
      provider: this.name,
      model: selectedModel,
      content: body.content,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
        totalTokens:
          typeof body.usage?.input_tokens === "number" && typeof body.usage?.output_tokens === "number"
            ? body.usage.input_tokens + body.usage.output_tokens
            : undefined
      }
    };
  }
}
