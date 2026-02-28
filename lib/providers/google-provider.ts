import { GoogleGenAI } from "@google/genai";
import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

interface GoogleModelMetadata {
  name?: string;
  supportedGenerationMethods?: string[];
}

type ThinkingLevel = "minimal" | "low" | "medium" | "high";

const GOOGLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-pro": "gemini-3.1-pro",
  "gemini-3-pro": "gemini-3.1-pro",
  "gemini-flash": "gemini-3.1-flash",
  "gemini-3-flash": "gemini-3.1-flash"
};

function normalizeGoogleModelId(modelId: string): string {
  const normalized = modelId.trim().replace(/^models\//, "");
  return GOOGLE_MODEL_ALIASES[normalized] ?? normalized;
}

function parseThinkingLevel(modelId: string): { normalizedModel: string; thinkingLevel?: ThinkingLevel } {
  const match = modelId
    .trim()
    .match(/^(.+?)(?:[#:]thinking=(minimal|low|medium|high)|[#:]?(minimal|low|medium|high))$/i);

  if (!match) {
    return { normalizedModel: normalizeGoogleModelId(modelId) };
  }

  const thinkingLevel = (match[2] ?? match[3])?.toLowerCase() as ThinkingLevel | undefined;
  return {
    normalizedModel: normalizeGoogleModelId(match[1]),
    thinkingLevel
  };
}

function isGemini3Model(modelId: string): boolean {
  return /^gemini-3(\.|-)/.test(modelId);
}

export class GoogleProvider implements LlmProvider {
  name = "google" as const;
  private client: GoogleGenAI;
  private defaultModel = "gemini-3.1-pro";

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async listModels(): Promise<string[]> {
    const listResponse = await this.client.models.list();

    const models = Array.isArray(listResponse)
      ? listResponse
      : "page" in listResponse
        ? ((listResponse.page as { models?: GoogleModelMetadata[] })?.models ?? [])
        : ((listResponse as { models?: GoogleModelMetadata[] }).models ?? []);

    return models
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => model.name?.replace("models/", ""))
      .filter((model): model is string => Boolean(model));
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const parsedModel = parseThinkingLevel(params.modelId ?? this.defaultModel);
    const selectedModel = parsedModel.normalizedModel;

    const historyContents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> =
      params.history.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      }));

    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [
      {
        role: "user",
        parts: [{ text: `CONVERSATION SUMMARY:\n${params.summary}` }]
      },
      ...historyContents,
      {
        role: "user",
        parts: [{ text: params.user }]
      }
    ];

    const thinkingLevel =
      parsedModel.thinkingLevel ?? (isGemini3Model(selectedModel) ? ("medium" as ThinkingLevel) : undefined);

    try {
      const result = await this.client.models.generateContent({
        model: selectedModel,
        contents,
        config: {
          systemInstruction: params.persona,
          ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {})
        }
      });

      const text = result.text ?? "";

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
