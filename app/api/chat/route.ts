import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { saveMessage } from "@/lib/data/blob-store";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";
import { LlmProvider, ProviderResponse } from "@/lib/providers/types";

const fileReferenceSchema = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  preview: z.string().min(1).max(2200),
  providerRef: z
    .object({
      openaiFileId: z.string().min(1).optional(),
      googleFileUri: z.string().min(1).optional()
    })
    .optional()
});

const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1),
  images: z.array(z.string()).optional(),
  fileReferences: z.array(fileReferenceSchema).optional(),
  overrideProvider: z.string().min(1).optional(),
  overrideModel: z.string().min(1).optional()
});

type RequestPayload = z.infer<typeof requestSchema>;

function buildGenerationParams({
  name,
  persona,
  summary,
  history,
  message,
  images,
  modelId,
  attachments
}: {
  name: string;
  persona: string;
  summary: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  images?: string[];
  modelId: string;
  attachments?: RequestPayload["fileReferences"];
}) {
  return {
    name,
    persona,
    summary,
    history,
    user: message,
    images,
    modelId,
    attachments
  };
}

async function runGeneration({
  provider,
  params,
  onTextDelta
}: {
  provider: LlmProvider;
  params: ReturnType<typeof buildGenerationParams>;
  onTextDelta: (delta: string) => void;
}): Promise<{ result: ProviderResponse; streamedText: string }> {
  let streamedText = "";

  const result = provider.generateStream
    ? await provider.generateStream(params, {
        onTextDelta(delta) {
          streamedText += delta;
          onTextDelta(delta);
        }
      })
    : await provider.generate(params);

  return { result, streamedText };
}

async function parseIncomingPayload(request: NextRequest): Promise<RequestPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error("Invalid request payload");
  }

  const body = await request.json();
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    console.error("[Chat API] Validation Failed:", parsed.error.format());
    throw new Error("Invalid request payload");
  }

  return parsed.data;
}

function extractImageUrl(part: { type?: string; [key: string]: unknown }): string | null {
  if (typeof part.url === "string") {
    return part.url;
  }

  if (typeof part.image_url === "string") {
    return part.image_url;
  }

  if (
    part.image_url &&
    typeof part.image_url === "object" &&
    "url" in part.image_url &&
    typeof (part.image_url as { url?: unknown }).url === "string"
  ) {
    return (part.image_url as { url: string }).url;
  }

  if (typeof part.b64_json === "string") {
    return `data:image/png;base64,${part.b64_json}`;
  }

  if (part.inlineData && typeof part.inlineData === "object") {
    const inlineData = part.inlineData as Record<string, unknown>;
    const data = typeof inlineData.data === "string" ? inlineData.data : null;

    if (!data) {
      return null;
    }

    const mimeType = typeof inlineData.mimeType === "string" ? inlineData.mimeType : "image/png";

    return `data:${mimeType};base64,${data}`;
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const payload = await parseIncomingPayload(request);
    const { actorId, chatId, message, images, fileReferences, overrideProvider, overrideModel } = payload;
    const attachments = fileReferences;
    const encoder = new TextEncoder();

    console.log(`[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}`);

    const providers = getAvailableProviders();
    if (!providers.length) {
      console.error("[Chat API] Error: No AI providers found in environment variables.");
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY, GOOGLE_API_KEY, grok_api_key, and/or CLAUDE_API_KEY." },
        { status: 500 }
      );
    }

    console.log("[Chat API] Assembling context and selecting provider...");
    const { name, persona, summary, history } = await assembleContext(actorId, chatId);
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    let provider = providers[0];
    let modelId = "";

    if (overrideProvider && overrideModel) {
      const manualProvider = providers.find((candidate) => candidate.name === overrideProvider);
      if (!manualProvider) {
        return NextResponse.json({ error: `Unknown override provider: ${overrideProvider}` }, { status: 400 });
      }

      provider = manualProvider;
      modelId = overrideModel;
      console.log(`[Chat API] Override active. Provider: ${provider.name}, Model: ${modelId}`);
    } else {
      const hasImages = Array.isArray(images) && images.length > 0;
      const hasImageAttachments =
        Array.isArray(attachments) && attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
      const hasVisualInput = hasImages || hasImageAttachments;
      const routingContext = `\n  Persona: ${persona}\n  Rolling Summary: ${summary}\n  Recent History: ${JSON.stringify(history.slice(-3))}\n  Has Attached Images: ${hasVisualInput}\n`;
      const routingDecision = await chooseProvider(message, routingContext, providers, { hasImages: hasVisualInput });

      provider = routingDecision.provider;
      modelId = routingDecision.modelId;

      console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);
      console.log(`[Chat API] Routing Model For UI: ${routingDecision.routerModel}`);
      console.log(`[Chat API] Routing Reasoning: ${routingDecision.reasoning}`);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            const metadataChunk = JSON.stringify({
              type: "metadata",
              modelId,
              provider: provider.name
            });
            controller.enqueue(encoder.encode(`${metadataChunk}\n`));

            console.log("[Chat API] Saving user message...");
            await saveMessage(chatId, "user", message);

            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const enqueueDelta = (delta: string) => {
              const deltaChunk = JSON.stringify({ type: "delta", text: delta });
              controller.enqueue(encoder.encode(`${deltaChunk}\n`));
            };

            const createParams = (selectedModelId: string) =>
              buildGenerationParams({
                name,
                persona,
                summary,
                history: historyForProvider,
                message,
                images,
                modelId: selectedModelId,
                attachments
              });

            let result: ProviderResponse;
            let streamedText = "";

            try {
              ({ result, streamedText } = await runGeneration({
                provider,
                params: createParams(modelId),
                onTextDelta: enqueueDelta
              }));
            } catch (generationError: unknown) {
              if (provider.name !== "openai") {
                throw generationError;
              }

              const googleProvider = providers.find((candidate) => candidate.name === "google");
              if (!googleProvider) {
                throw generationError;
              }

              const googleModels = await googleProvider.listModels();
              const googleModelId =
                googleModels.find((candidateModel) => candidateModel.includes("gemini-3.1-pro")) ||
                googleModels[0] ||
                "gemini-3.1-pro";

              console.warn(
                `[Chat API] OpenAI generation failed (${generationError instanceof Error ? generationError.message : String(generationError)}). Falling back to google:${googleModelId}.`
              );

              provider = googleProvider;
              modelId = googleModelId;
              const failoverMetadataChunk = JSON.stringify({
                type: "metadata",
                modelId,
                provider: provider.name
              });
              controller.enqueue(encoder.encode(`${failoverMetadataChunk}\n`));

              ({ result, streamedText } = await runGeneration({
                provider,
                params: createParams(modelId),
                onTextDelta: enqueueDelta
              }));
            }

            if (!result || (!result.text && !(result.content?.length) && !streamedText)) {
              throw new Error(`AI Provider ${provider.name} returned an empty response.`);
            }

            const imageAssets =
              result.content
                ?.map((part) => {
                  const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
                  if (!partType.includes("image")) {
                    return null;
                  }

                  const url = extractImageUrl(part);
                  if (!url) {
                    return null;
                  }

                  return { type: "image", url };
                })
                .filter((asset): asset is { type: "image"; url: string } => Boolean(asset)) ?? [];

            const contentChunk = JSON.stringify({
              type: "content",
              text: result.text || streamedText,
              assets: imageAssets,
              provider: result.provider,
              model: result.model
            });
            controller.enqueue(encoder.encode(`${contentChunk}\n`));

            console.log("[Chat API] Generation successful. Saving assistant response.");
            const assistantText = result.text || streamedText;
            await saveMessage(chatId, "assistant", assistantText, result.model, imageAssets);

            after(async () => {
              try {
                await maybeUpdateSummary(chatId);
              } catch (error: unknown) {
                console.error("[Chat API] Background Summary Update Error:", error);
              }
            });

            controller.close();
          } catch (error: unknown) {
            console.error("[Chat API] Stream Runtime Error:", error);
            controller.error(error);
          }
        })();
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";

    if (errorMessage === "Invalid request payload") {
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
