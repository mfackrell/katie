import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

interface GoogleModelMetadata {
  name?: string;
  supportedGenerationMethods?: string[];
}


function normalizeGoogleModelId(modelId: string): string {
  return modelId.trim().replace(/^models\//, "");
}

export class GoogleProvider implements LlmProvider {
  name = "google" as const;
  private apiKey: string;
  private genAI: {
    getGenerativeModel: (params: { model: string; systemInstruction: string }) => {
      generateContent: (request: {
        contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
      }) => Promise<{ response?: { text?: () => string } }>;
    };
    listModels?: () => Promise<{ models?: GoogleModelMetadata[] } | GoogleModelMetadata[]>;
  };
  private defaultModel = "gemini-2.5-pro";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(this.apiKey) as unknown as GoogleProvider["genAI"];
  }

  async listModels(): Promise<string[]> {
    if (!this.genAI.listModels) {
      return [];
    }

    const listResponse = await this.genAI.listModels();
    const models = Array.isArray(listResponse) ? listResponse : listResponse.models ?? [];

    return models
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => model.name?.replace("models/", ""))
      .filter((model): model is string => Boolean(model));
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const selectedModel = normalizeGoogleModelId(params.modelId ?? this.defaultModel);
    console.log(`[GoogleProvider] Using model: ${selectedModel}`);

    const model = this.genAI.getGenerativeModel({
      model: selectedModel,
      systemInstruction: params.system
    });

    const historyContents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> =
      params.history.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      }));

    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [
      ...historyContents,
      {
        role: "user",
        parts: [{ text: params.user }]
      }
    ];

    try {
      const result = await model.generateContent({ contents });
      const text = result.response?.text?.() ?? "";

      return {
        text,
        model: selectedModel,
        provider: this.name
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[GoogleProvider] Gemini error body for model ${selectedModel}: ${detail}`);
      throw new Error(`Gemini request failed for model ${selectedModel}`);
    }
  }
}
