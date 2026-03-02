import { GoogleGenAI, ThinkingLevel as GoogleThinkingLevel } from "@google/genai";
import { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";

type ThinkingLevelInput = "minimal" | "low" | "medium" | "high";

type GoogleInputPart =
  | { text: string }
  | { fileData: { fileUri: string; mimeType: string } };

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

function parseThinkingLevel(modelId: string): {
  normalizedModel: string;
  thinkingLevelInput?: ThinkingLevelInput;
} {
  const match = modelId
    .trim()
    .match(/^(.+?)(?:[#:]thinking=(minimal|low|medium|high)|[#:]?(minimal|low|medium|high))$/i);

  if (!match) {
    return { normalizedModel: normalizeGoogleModelId(modelId) };
  }

  const thinkingLevelInput = (match[2] ?? match[3])?.toLowerCase() as ThinkingLevelInput | undefined;
  return {
    normalizedModel: normalizeGoogleModelId(match[1]),
    thinkingLevelInput
  };
}

function toGoogleThinkingLevel(thinkingLevelInput: ThinkingLevelInput): GoogleThinkingLevel {
  switch (thinkingLevelInput) {
    case "minimal":
      return GoogleThinkingLevel.MINIMAL;
    case "low":
      return GoogleThinkingLevel.LOW;
    case "medium":
      return GoogleThinkingLevel.MEDIUM;
    case "high":
      return GoogleThinkingLevel.HIGH;
  }
}

function isGemini3Model(modelId: string): boolean {
  return /^gemini-3(\.|-)/.test(modelId);
}

function isImageGenerationModel(modelId: string): boolean {
  const lowerModel = modelId.toLowerCase();
  return lowerModel.includes("image") || lowerModel.includes("banana");
}

function buildGoogleFileParts(params: ChatGenerateParams): GoogleInputPart[] {
  if (!params.attachments?.length) {
    return [];
  }

  return params.attachments
    .filter((attachment): attachment is typeof attachment & { providerRef: { googleFileUri: string } } =>
      Boolean(attachment.providerRef?.googleFileUri)
    )
    .map((attachment) => ({
      fileData: {
        fileUri: attachment.providerRef.googleFileUri,
        mimeType: attachment.mimeType
      }
    }));
}

export class GoogleProvider implements LlmProvider {
  name = "google" as const;
  private client: GoogleGenAI;
  private defaultModel = "gemini-3.1-pro";

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async listModels(): Promise<string[]> {
    try {
      const listResponse = await this.client.models.list();
      const modelIds: string[] = [];

      for await (const model of listResponse) {
        if (model.supportedActions?.includes("generateContent") && model.name) {
          modelIds.push(model.name.replace("models/", ""));
        }
      }

      return modelIds;
    } catch (error) {
      console.error("[GoogleProvider] Failed to list models:", error);
      return [];
    }
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const parsedModel = parseThinkingLevel(params.modelId ?? this.defaultModel);
    const selectedModel = parsedModel.normalizedModel;

    const parts: GoogleInputPart[] = [{ text: params.user }, ...buildGoogleFileParts(params)];
    const contents: Array<{ role: "user"; parts: GoogleInputPart[] }> = [
      {
        role: "user",
        parts
      }
    ];

    const thinkingLevelInput =
      parsedModel.thinkingLevelInput ?? (isGemini3Model(selectedModel) ? "medium" : undefined);
    const isImageTask = isImageGenerationModel(selectedModel);
    const memoryContext = buildMemoryContext(params.history);
    const attachmentContext = formatAttachmentContext(params.attachments);
    const baseSystemInstruction = `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}\n\nMEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT\n\n${memoryContext}`;
    const systemInstructionBase = isImageTask
      ? `${baseSystemInstruction}\n\nIMPORTANT: You have direct image generation capabilities. If the user asks for a photo, design asset, or image, generate it directly as an image modality response.`
      : baseSystemInstruction;
    const systemInstruction = attachmentContext
      ? `${systemInstructionBase}\n\n${attachmentContext}`
      : systemInstructionBase;

    try {
      const result = await this.client.models.generateContent({
        model: selectedModel,
        contents,
        config: {
          systemInstruction,
          responseModalities: isImageTask ? ["TEXT", "IMAGE"] : ["TEXT"],
          ...(thinkingLevelInput
            ? { thinkingConfig: { thinkingLevel: toGoogleThinkingLevel(thinkingLevelInput) } }
            : {})
        }
      });

      const responseParts = result.candidates?.[0]?.content?.parts ?? [];
      let text = "";
      const content: Array<{ type: string; url: string }> = [];

      for (const part of responseParts) {
        if (part.text) {
          text += part.text;
        } else if (part.inlineData) {
          const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          content.push({ type: "image", url: dataUrl });
        }
      }

      return {
        text: text || (content.length > 0 ? "[Image Generated]" : ""),
        model: selectedModel,
        provider: this.name,
        content: content.length > 0 ? content : undefined
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[GoogleProvider] Gemini error body for model ${selectedModel}: ${detail}`);
      throw new Error(`Gemini request failed for model ${selectedModel}`);
    }
  }
}
