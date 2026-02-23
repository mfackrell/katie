import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

interface GoogleModelsResponse {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}

export class GoogleProvider implements LlmProvider {
  name = "google" as const;
  private apiKey: string;
  private defaultModel = "gemini-1.5-pro";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async listModels(): Promise<string[]> {
    const endpoint = `https://generativelanguage.googleapis.com/v1/models?key=${this.apiKey}`;
    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`Gemini listModels failed (${response.status})`);
    }

    const json = (await response.json()) as GoogleModelsResponse;
    const models = json.models
      ?.filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => model.name?.replace("models/", ""))
      .filter((model): model is string => Boolean(model));

    return models ?? [];
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const selectedModel = params.modelId ?? this.defaultModel;
    console.log(`[GoogleProvider] Using model: ${selectedModel}`);

    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${selectedModel}:generateContent?key=${this.apiKey}`;
    const mappedHistory = (params.history ?? []).map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: params.system }]
        },
        contents: [
          ...mappedHistory,
          {
            role: "user",
            parts: [{ text: params.user }]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed for model ${selectedModel} (${response.status})`);
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return {
      text,
      model: selectedModel,
      provider: this.name
    };
  }
}
