import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { saveMessage, setShortTermMemory } from "@/lib/data/blob-store";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";
import {
  hasDirectWebSearchHint,
  inferRequestIntent,
  inferRequestIntentFromMultimodalInput,
  RequestIntent,
  validateRoutingDecision
} from "@/lib/router/model-intent";
import {
  ACK_CONTEXT_TTL_MS,
  isAcknowledgment,
  isSubstantiveIntent,
  parseIntentSessionState
} from "@/lib/router/intent-context";
import { LlmProvider, ProviderResponse } from "@/lib/providers/types";
import type { SelectionExplainer } from "@/lib/router/master-router";
import { DEFAULT_REASONING_CATEGORIES, ReasoningStateAccumulator } from "@/lib/chat/reasoning-stream";
import { isLikelyProviderRefusal, runWithRefusalFallback, shouldRetryOnProviderRefusal } from "@/lib/router/refusal-detection";
import {
  getAttachmentSupportForProvider,
  isVideoAttachment,
  resolveVideoRoutingPolicy,
  selectGoogleModelForVideoRouting
} from "@/lib/chat/video-routing";

const fileReferenceSchema = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  preview: z.string().min(1).max(2200),
  attachmentKind: z.enum(["image", "video", "text", "file"]).optional(),
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
  overrideModel: z.string().min(1).optional(),
  routingTraceEnabled: z.boolean().optional()
});

type RequestPayload = z.infer<typeof requestSchema>;

function buildGenerationParams({
  name,
  persona,
  summary,
  history,
  message,
  requestIntent,
  images,
  modelId,
  attachments
}: {
  name: string;
  persona: string;
  summary: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  requestIntent?: RequestIntent;
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
    requestIntent,
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
    const { actorId, chatId, message, images, fileReferences, overrideProvider, overrideModel, routingTraceEnabled } = payload;
    const attachments = fileReferences;
    const hasVideoInput = Array.isArray(attachments) && attachments.some(isVideoAttachment);
    const encoder = new TextEncoder();
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

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
    const { name, persona, summary, history, shortTermMemory } = await assembleContext(actorId, chatId);
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    let provider = providers[0];
    let modelId = "";
    let fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];
    let selectionExplainer: SelectionExplainer | undefined;
    let resolvedRequestIntent: RequestIntent | undefined;
    const videoRoutingPolicy = resolveVideoRoutingPolicy(hasVideoInput, overrideProvider);

    if (hasVideoInput) {
      console.log("[Video Routing] detected video attachment(s); forcing provider=google");
    }

    if (videoRoutingPolicy.mode === "reject-override") {
      console.warn(`[Video Routing] rejected override provider=${videoRoutingPolicy.provider} for video input`);
      return NextResponse.json(
        { error: "Video attachments are only supported through the Google/Gemini provider in this chat flow." },
        { status: 400 }
      );
    }

    if (overrideProvider && overrideModel) {
      const manualProvider = providers.find((candidate) => candidate.name === overrideProvider);
      if (!manualProvider) {
        return NextResponse.json({ error: `Unknown override provider: ${overrideProvider}` }, { status: 400 });
      }

      const hasImages = Array.isArray(images) && images.length > 0;
      const hasImageAttachments =
        Array.isArray(attachments) && attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
      const hasVisualInput = hasImages || hasImageAttachments;
      const overrideIntent = await inferRequestIntent(message, { hasImages: hasVisualInput, hasVideoInput });
      const validatedOverride = validateRoutingDecision(
        { providerName: manualProvider.name, modelId: overrideModel },
        [{ provider: manualProvider, models: await manualProvider.listModels() }],
        overrideIntent
      );
      if (validatedOverride.changed) {
        return NextResponse.json(
          {
            error: `Override ${manualProvider.name}:${overrideModel} is incompatible with intent=${overrideIntent} or capabilities.`
          },
          { status: 400 }
        );
      }

      provider = manualProvider;
      modelId = overrideModel;
      console.log(`[Chat API] Override active. Provider: ${provider.name}, Model: ${modelId}`);
    } else if (videoRoutingPolicy.mode === "force-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return NextResponse.json(
          { error: "Video attachments require the Google/Gemini provider, but it is not configured." },
          { status: 400 }
        );
      }

      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider);
      fallbackChain = [];
      console.log(`[Video Routing] detected video attachment(s); forcing provider=google model=${modelId}`);
    } else if (videoRoutingPolicy.mode === "manual-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return NextResponse.json(
          { error: "Video attachments require the Google/Gemini provider, but it is not configured." },
          { status: 400 }
        );
      }

      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider, overrideModel);
      fallbackChain = [];
      console.log(`[Video Routing] override accepted; provider=google model=${modelId}`);
    } else {
      const hasImages = Array.isArray(images) && images.length > 0;
      const hasImageAttachments =
        Array.isArray(attachments) && attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
      const hasVisualInput = hasImages || hasImageAttachments;
      const explicitIntent: RequestIntent | undefined = hasDirectWebSearchHint(message) ? "web-search" : undefined;
      const now = Date.now();
      const intentSession = parseIntentSessionState(shortTermMemory);
      const isAckMessage = isAcknowledgment(message);
      let requestIntent: RequestIntent;

      if (explicitIntent) {
        requestIntent = explicitIntent;
      } else if (
        isAckMessage &&
        intentSession.lastSubstantiveIntent &&
        intentSession.lastIntentTimestamp &&
        now - intentSession.lastIntentTimestamp < ACK_CONTEXT_TTL_MS
      ) {
        requestIntent = intentSession.lastSubstantiveIntent;
        console.log(
          `[Intent Reuse] Reusing ${requestIntent} from ${new Date(intentSession.lastIntentTimestamp).toISOString()} for ack message "${message}".`
        );
      } else {
        const multimodalIntent =
          hasVisualInput && Array.isArray(images) && images.length > 0
            ? await inferRequestIntentFromMultimodalInput(message, images)
            : null;

        requestIntent =
          multimodalIntent ??
          (await inferRequestIntent(message, {
            hasImages: hasVisualInput,
            hasVideoInput
          }));

        if (isSubstantiveIntent(requestIntent) && !isAckMessage) {
          await setShortTermMemory(actorId, chatId, {
            ...shortTermMemory,
            intentSession: {
              lastSubstantiveIntent: requestIntent,
              lastIntentTimestamp: now
            }
          });
          console.log(`[Intent Update] Stored substantive intent ${requestIntent} at ${new Date(now).toISOString()}.`);
        }
      }

      resolvedRequestIntent = explicitIntent ?? requestIntent;

      const routingContext = `\n  Persona: ${persona}\n  Rolling Summary: ${summary}\n  Recent History: ${JSON.stringify(history.slice(-3))}\n  Has Attached Images: ${hasVisualInput}\n`;
      const routingDecision = await chooseProvider(message, routingContext, providers, {
        hasImages: hasVisualInput,
        hasVideoInput,
        requestIntent: resolvedRequestIntent,
        routingTraceEnabled,
        routingRequestId: request.headers.get("x-request-id") ?? undefined
      });

      provider = routingDecision.provider;
      modelId = routingDecision.modelId;
      fallbackChain = routingDecision.fallbackChain;
      selectionExplainer = routingDecision.explainer;

      console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);
      console.log(`[Chat API] Routing Model For UI: ${routingDecision.routerModel}`);
      console.log(`[Chat API] Routing Reasoning: ${routingDecision.reasoning}`);
    }

    const selectedProviderSupport = getAttachmentSupportForProvider(provider.name, attachments);
    if (!selectedProviderSupport.supported && !overrideProvider) {
      const compatibleFallback = fallbackChain.find((candidate) => {
        const support = getAttachmentSupportForProvider(candidate.provider.name, attachments);
        return support.supported;
      });

      if (compatibleFallback) {
        provider = compatibleFallback.provider;
        modelId = compatibleFallback.modelId;
      }
    }

    const finalProviderSupport = getAttachmentSupportForProvider(provider.name, attachments);
    if (!finalProviderSupport.supported) {
      return NextResponse.json(
        { error: finalProviderSupport.reason },
        { status: 400 }
      );
    }

    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const requestStartedAtMs = Date.now();
          let firstReasoningUpdateAtMs: number | null = null;
          let reasoningUpdateCount = 0;
          const reasoningState = new ReasoningStateAccumulator(requestId, [...DEFAULT_REASONING_CATEGORIES]);
          let lastSnapshotEmitAt = Date.now();
          const emitChunk = (chunk: Record<string, unknown>) => {
            if (streamCancelled) {
              return;
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          };

          try {
            emitChunk({
              type: "metadata",
              modelId,
              provider: provider.name,
              explainer: selectionExplainer
            });

            const startEvent = reasoningState.start();
            emitChunk(startEvent);
            console.log("[Chat API] reasoning_start emitted", { requestId, categories: startEvent.categories });

            console.log("[Chat API] Saving user message...");
            await saveMessage(chatId, {
              id: crypto.randomUUID(),
              role: "user",
              content: message,
            });

            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const enqueueDelta = (delta: string) => {
              if (streamCancelled) {
                throw new Error("stream cancelled");
              }
              emitChunk({ type: "delta", text: delta });
              const reasoningUpdate = reasoningState.addDelta(delta);
              if (reasoningUpdate) {
                reasoningUpdateCount += 1;
                if (firstReasoningUpdateAtMs === null) {
                  firstReasoningUpdateAtMs = Date.now();
                }
                emitChunk(reasoningUpdate);

                if (Date.now() - lastSnapshotEmitAt > 900 || reasoningUpdateCount % 6 === 0) {
                  emitChunk(reasoningState.snapshot());
                  lastSnapshotEmitAt = Date.now();
                }
              }
            };

            const createParams = (selectedModelId: string) =>
              buildGenerationParams({
                name,
                persona,
                summary,
                history: historyForProvider,
                message,
                requestIntent: resolvedRequestIntent,
                images,
                modelId: selectedModelId,
                attachments
              });

            let result: ProviderResponse | null = null;
            let streamedText = "";
            const attempts = [{ provider, modelId }, ...fallbackChain];
            const retryOnProviderRefusal = shouldRetryOnProviderRefusal();
            const generationAttempt = await runWithRefusalFallback({
              attempts,
              shouldRetryRefusal: retryOnProviderRefusal,
              runAttempt: async (candidate, attemptIndex) => {
                provider = candidate.provider;
                modelId = candidate.modelId;

                if (attemptIndex > 0) {
                  emitChunk({
                    type: "metadata",
                    modelId,
                    provider: provider.name
                  });
                }

                const generation = await runGeneration({
                  provider,
                  params: createParams(modelId),
                  onTextDelta: enqueueDelta
                });

                streamedText = generation.streamedText;
                return {
                  ...generation.result,
                  text: generation.result.text || generation.streamedText
                };
              },
              detectRefusal: (generationResult, candidate) => isLikelyProviderRefusal(generationResult, candidate.provider.name),
              onRefusalFallback: ({ attempt, nextAttempt }) => {
                console.warn("[Chat API] Provider refusal detected. Attempting fallback candidate.", {
                  requestId,
                  provider: attempt.provider.name,
                  modelId: attempt.modelId,
                  nextProvider: nextAttempt.provider.name,
                  nextModelId: nextAttempt.modelId
                });
              },
              onError: ({ attempt, error }) => {
                console.warn(
                  `[Chat API] Generation failed for ${attempt.provider.name}:${attempt.modelId} (${error instanceof Error ? error.message : String(error)}).`
                );
              }
            });
            result = generationAttempt.result;
            provider = generationAttempt.attempt.provider;
            modelId = generationAttempt.attempt.modelId;

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

            emitChunk({
              type: "content",
              text: result.text || streamedText,
              assets: imageAssets,
              provider: result.provider,
              model: result.model
            });

            const finalAnswerEvent = reasoningState.finalize(result.text || streamedText);
            emitChunk(reasoningState.snapshot());
            emitChunk(finalAnswerEvent);

            console.log("[Chat API] Generation successful. Saving assistant response.");
            const assistantText = result.text || streamedText;
            await saveMessage(chatId, {
              id: crypto.randomUUID(),
              role: "assistant",
              model: result.model,
              content: assistantText,
              assets: imageAssets,
            });

            after(async () => {
              try {
                await maybeUpdateSummary(chatId);
              } catch (error: unknown) {
                console.error("[Chat API] Background Summary Update Error:", error);
              }
            });
            console.log("[Chat API] reasoning stream metrics", {
              requestId,
              reasoningUpdateCount,
              timeToFirstReasoningUpdateMs: firstReasoningUpdateAtMs === null ? null : firstReasoningUpdateAtMs - requestStartedAtMs,
              timeToFinalAnswerMs: Date.now() - requestStartedAtMs
            });

            controller.close();
          } catch (error: unknown) {
            console.error("[Chat API] Stream Runtime Error:", error);
            const message = error instanceof Error ? error.message : "Unknown stream error";
            emitChunk(reasoningState.error(message, true));
            console.error("[Chat API] reasoning stream error", { requestId, message });
            controller.error(error);
          }
        })();
      },
      cancel() {
        streamCancelled = true;
        console.log("[Chat API] stream cancelled by client", { requestId });
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

    if (errorMessage.includes("not found")) {
      return NextResponse.json({ error: errorMessage }, { status: 404 });
    }

    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
