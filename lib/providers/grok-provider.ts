import { nativeToolTurn } from "./native-tools";
import { requireAgentResearch } from "@/lib/agents/policy";
import { buildVideoTimingEvidence, buildGrokVideoFrames } from "@/lib/chat/video-evidence";
import OpenAI from "openai";
import {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ResearchEvidenceSource
} from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";
import {
  buildGrokImageContextSource, composeGrokImagePrompt, grokImageCondensationInstructions,
  needsGrokImageContext, GROK_IMAGE_CONTEXT_MODEL
} from "@/lib/providers/grok-image-context";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";
import { MAX_VIDEO_FALLBACK_FRAMES } from "@/lib/uploads/video-fallback-frames";
import { getKatieOperationalRealityStatement, getKatieReasoningExplainerStatement } from "@/lib/providers/operational-reality";

function isWebSearchIntent(requestIntent: string | undefined): boolean {
  return requestIntent === "web-search" || requestIntent === "news-summary";
}

function isImageModel(model: string): boolean {
  return /^grok-(?:imagine-image|2-image)(?:-|$)/i.test(model);
}

function imageContentFromResponse(payload: unknown): Array<{ type: "image"; url: string }> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("xAI Images API returned no image data.");
  }

  const content = ((payload as { data: unknown[] }).data).flatMap((item): Array<{ type: "image"; url: string }> => {
    if (!item || typeof item !== "object") return [];
    const image = item as { b64_json?: unknown; url?: unknown; mime_type?: unknown };
    if (typeof image.b64_json === "string" && image.b64_json.trim()) {
      const base64 = image.b64_json.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return [];
      const mime = typeof image.mime_type === "string" && /^image\/(jpeg|png|webp|gif)$/.test(image.mime_type)
        ? image.mime_type : "image/jpeg";
      return [{ type: "image", url: `data:${mime};base64,${base64}` }];
    }
    if (typeof image.url === "string" && /^https:\/\//i.test(image.url)) {
      return [{ type: "image", url: image.url }];
    }
    return [];
  });

  if (!content.length) throw new Error("xAI Images API returned no usable images.");
  return content;
}

type ResponseTextSource = {
  output_text?: string | null;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

type GrokResponseInputMessage = {
  role: "system" | "user";
  content: GrokResponseInputContentPart[];
};

type GrokResponseInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

type GrokChatUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type GrokWebSearchSource = {
  url?: string;
  link?: string;
  title?: string;
  snippet?: string;
  text?: string;
  [key: string]: unknown;
};

type GrokWebSearchResponse = {
  output_text?: string | null;
  citations?: unknown[];
  output?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function extractResponseText(response: ResponseTextSource): string {
  if (response.output_text?.trim()) {
    return response.output_text;
  }

  return (response.output ?? [])
    .flatMap((item) => ("content" in item && Array.isArray(item.content) ? item.content : []))
    .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
}

function clipEvidenceText(value: string | undefined, maxChars = 2_000): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`;
}

function addResearchSource(
  byUrl: Map<string, ResearchEvidenceSource>,
  source: GrokWebSearchSource | string,
): void {
  const rawUrl =
    typeof source === "string"
      ? source
      : typeof source.url === "string"
        ? source.url
        : typeof source.link === "string"
          ? source.link
          : "";
  const url = rawUrl.trim().replace(/[),.;]+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    return;
  }

  const existing = byUrl.get(url);
  if (typeof source === "string") {
    if (!existing) {
      byUrl.set(url, { url });
    }
    return;
  }

  const title = clipEvidenceText(source.title, 500);
  const snippet = clipEvidenceText(
    typeof source.snippet === "string" ? source.snippet : source.text,
    2_000,
  );
  byUrl.set(url, {
    url,
    ...(title ? { title } : existing?.title ? { title: existing.title } : {}),
    ...(snippet ? { snippet } : existing?.snippet ? { snippet: existing.snippet } : {}),
  });
}

function collectResearchSourcesFromUnknown(
  value: unknown,
  byUrl: Map<string, ResearchEvidenceSource>,
  depth = 0,
): void {
  if (depth > 8 || value == null) {
    return;
  }

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value.trim())) {
      addResearchSource(byUrl, value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectResearchSourcesFromUnknown(item, byUrl, depth + 1));
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const sourceLike: GrokWebSearchSource = {};
  if (typeof record.url === "string") sourceLike.url = record.url;
  if (typeof record.link === "string") sourceLike.link = record.link;
  if (typeof record.title === "string") sourceLike.title = record.title;
  if (typeof record.snippet === "string") sourceLike.snippet = record.snippet;
  if (typeof record.text === "string") sourceLike.text = record.text;
  if (sourceLike.url || sourceLike.link) {
    addResearchSource(byUrl, sourceLike);
  }

  Object.values(record).forEach((nested) =>
    collectResearchSourcesFromUnknown(nested, byUrl, depth + 1),
  );
}

function extractUrlsFromResearchText(
  text: string,
  byUrl: Map<string, ResearchEvidenceSource>,
): void {
  const matches = text.match(/https?:\/\/[^\s<>"'\]]+/gi) ?? [];
  matches.forEach((url) => addResearchSource(byUrl, url));
}

export function extractResearchSources(
  response: GrokWebSearchResponse,
  responseText = "",
): ResearchEvidenceSource[] {
  const byUrl = new Map<string, ResearchEvidenceSource>();
  collectResearchSourcesFromUnknown(response, byUrl);

  if (byUrl.size === 0 && responseText) {
    extractUrlsFromResearchText(responseText, byUrl);
  }

  return Array.from(byUrl.values()).slice(0, 30);
}

function describeWebSearchResponseShape(response: GrokWebSearchResponse): {
  topLevelKeys: string[];
  outputItemTypes: string[];
  outputItemKeys: string[];
  actionKeys: string[];
  citationCount: number;
} {
  const output = Array.isArray(response.output) ? response.output : [];
  const outputItemTypes = Array.from(
    new Set(
      output
        .map((item) => (typeof item.type === "string" ? item.type : "unknown"))
        .filter(Boolean),
    ),
  );
  const outputItemKeys = Array.from(
    new Set(output.flatMap((item) => Object.keys(item))),
  );
  const actionKeys = Array.from(
    new Set(
      output.flatMap((item) => {
        const action = item.action;
        return action && typeof action === "object" && !Array.isArray(action)
          ? Object.keys(action as Record<string, unknown>)
          : [];
      }),
    ),
  );

  return {
    topLevelKeys: Object.keys(response),
    outputItemTypes,
    outputItemKeys,
    actionKeys,
    citationCount: Array.isArray(response.citations) ? response.citations.length : 0,
  };
}

function buildChatUserContent(params: ChatGenerateParams): string | GrokChatUserContentPart[] {
  if (!params.images?.length) {
    return params.user;
  }

  return [
    { type: "text", text: params.user },
    ...params.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))
  ];
}

function buildResponsesUserContent(params: ChatGenerateParams): GrokResponseInputContentPart[] {
  const content: GrokResponseInputContentPart[] = [{ type: "input_text", text: params.user }];

  if (params.images?.length) {
    params.images.forEach((url) => {
      content.push({
        type: "input_image",
        image_url: url,
        detail: "auto"
      });
    });
  }

  return content;
}

function hasVideoAttachments(params: ChatGenerateParams): boolean {
  return Boolean(
    params.attachments?.some(
      (attachment) =>
        attachment.attachmentKind === "video" || attachment.mimeType.startsWith("video/"),
    ),
  );
}

export class GrokProvider implements LlmProvider {
  generateToolTurn(params: import("@/lib/tools/types").ToolTurnParams) { return nativeToolTurn("grok", this.apiKey, params); }
  name = "grok" as const;
  private client: OpenAI;
  private apiKey: string;
  private defaultModel = "grok-2-1212";
  private aliasToModel: Record<string, string> = {
    "grok-imagine": "grok-imagine-image"
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
      fetch: globalThis.fetch.bind(globalThis)
    });
  }

  private async imagePromptWithContext(params: ChatGenerateParams): Promise<{
    prompt: string; mode: "direct" | "condensed"; sourceHistoryTurns: number; truncated: boolean;
  }> {
    if (!needsGrokImageContext(params)) {
      return { prompt: params.user, mode: "direct", sourceHistoryTurns: 0, truncated: false };
    }
    // The Imagine API accepts a single bounded prompt, not system messages.
    // First give Grok's TEXT model the same persona, STM, ITM and LTM that Gemini gets.
    // It extracts relevant scene facts rather than discarding older conversation context.
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(35_000),
      body: JSON.stringify({
        model: GROK_IMAGE_CONTEXT_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: grokImageCondensationInstructions(params.user) }] },
          { role: "user", content: [{ type: "input_text", text: buildGrokImageContextSource(params) }] },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Image context condensation failed (${response.status}); refusing to silently generate without established character history.`);
    }
    const parsed: unknown = await response.json();
    const text = parsed && typeof parsed === "object" ? extractResponseText(parsed as ResponseTextSource).trim() : "";
    if (!text) throw new Error("Grok returned no usable image context from conversational memory.");
    const composed = composeGrokImagePrompt(params.user, text === "NONE" ? "" : text);
    if (composed.backgroundTruncated) {
      console.warn("[GrokProvider] image background context exceeded provider prompt budget", {
        sourceHistoryTurns: params.history.length,
        maxChars: 1024,
      });
    }
    return { prompt: composed.prompt, mode: "condensed", sourceHistoryTurns: params.history.length, truncated: composed.backgroundTruncated };
  }

  private async generateImage(params: ChatGenerateParams, model: string): Promise<ProviderResponse> {
    if (!params.user.trim()) throw new Error("Grok image generation requires a prompt.");
    const images = params.images ?? [];
    if (images.length > 5) throw new Error("Grok image editing supports up to five source images.");
    const outgoing = await this.imagePromptWithContext(params);
    const endpoint = images.length ? "edits" : "generations";
    const imageInputs = images.map((url) => ({ type: "image_url", url }));
    console.info("[GrokProvider] image request", { model, endpoint: `/images/${endpoint}`, sourceImageCount: images.length });

    // The provider system audit supports direct inspection of the literal final image
    // prompt. No base64 reference images or credentials are recorded in this audit.
    await params.onProviderSystemPrepared?.({
      provider: "grok", model, endpoint: `images/${endpoint}`, systemMessages: [],
      imagePrompt: outgoing.prompt,
      contextSynthesis: {
        mode: outgoing.mode, sourceHistoryTurns: outgoing.sourceHistoryTurns,
        sourceSummaryChars: params.summary.length, sourcePersonaChars: params.persona.length,
        truncated: outgoing.truncated,
      },
    });

    // xAI image edits require JSON; OpenAI images.edit() sends incompatible multipart data.
    const response = await fetch(`https://api.x.ai/v1/images/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        prompt: outgoing.prompt,
        n: 1,
        response_format: "b64_json",
        ...(imageInputs.length === 1 ? { image: imageInputs[0] } : imageInputs.length ? { images: imageInputs } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`xAI Images API failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`);
    }
    const content = imageContentFromResponse(await response.json());
    console.info("[GrokProvider] image response", { model, endpoint: `/images/${endpoint}`, imageCount: content.length });
    return { text: "[Image Generated]", model, provider: this.name, content };
  }

  private buildWebSearchInput(params: ChatGenerateParams, attachmentContext: string | null): GrokResponseInputMessage[] {
    return [
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
      {
        role: "system",
        content: [{ type: "input_text", text: `${getKatieOperationalRealityStatement()}

${getKatieReasoningExplainerStatement()}` }]
      },
      ...(attachmentContext
        ? [
            {
              role: "system" as const,
              content: [{ type: "input_text" as const, text: attachmentContext }]
            }
          ]
        : []),
      { role: "user", content: buildResponsesUserContent(params) }
    ];
  }

  private async createWebSearchResponse(model: string, input: GrokResponseInputMessage[]): Promise<GrokWebSearchResponse> {
    requireAgentResearch();
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        input,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"]
      })
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `xAI Responses API failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${bodyText ? `: ${bodyText}` : ""}`
      );
    }

    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") {
      throw new Error("xAI Responses API returned a non-object JSON payload.");
    }
    const typed = parsed as GrokWebSearchResponse;
    console.info("[GrokProvider] web response shape", describeWebSearchResponseShape(typed));
    return typed;
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      const normalizedIds = models.data
        .map((model) => model.id)
        .filter((modelId): modelId is string => typeof modelId === "string" && modelId.length > 0)
        .map((modelId) => {
          const slashParts = modelId.split("/");
          return slashParts[slashParts.length - 1] ?? modelId;
        });
      return Array.from(new Set(normalizedIds));
    } catch (error) {
      console.error("[GrokProvider] Failed to list models:", error);
      return [];
    }
  }

  async generate(params: ChatGenerateParams, videoOrdinal = 1): Promise<ProviderResponse> {
    if (hasVideoAttachments(params)) {
      const videos = (params.attachments ?? []).filter(a => a.attachmentKind === "video" || a.mimeType.startsWith("video/"));
      const missing = videos.find(video => !video.videoFrames?.length);
      if (missing) throw new Error(`Grok cannot inspect ${missing.fileName} because no video frames were captured.`);
      const frames = buildGrokVideoFrames(videos, MAX_VIDEO_FALLBACK_FRAMES, params.images?.length ?? 0, videoOrdinal);
      const labels = frames.labels;
      params = {
        ...params,
        user: `${params.user}\n${buildVideoTimingEvidence(videos, videoOrdinal)}\n\nGROK VIDEO EVIDENCE (internal): Attached images are sampled still frames from the original video, not the native video file. Frame labels for internal reference only: ${labels}. The images are grouped by source and chronological within each source; compare the FINAL images against the first ones before deciding whether the scene remains unchanged. Describe the subjects and their actually visible actions and interactions, including any brief scene or content switch at the end. Ignore incidental video player chrome, watermarks or clocks, but DO report an actual change to a different clip, app screen or setting; such a transition is not just playback metadata. Do not include these evidence-handling instructions in your answer. Only use timestamps supported by measured evidence when relevant. Do not infer unobserved motion, sounds, speech, or events between frames. Mention limitations only when necessary to answer the question accurately.`,
        images: [...(params.images ?? []), ...frames.images],
      };
      console.info("[GrokProvider] fallback frame inspection", {
        frameCount: frames.images.length,
        videoCount: videos.length,
        model: params.modelId ?? "default"
      });
    }

    const requestedModel = params.modelId ?? this.defaultModel;
    const aliasedModel = this.aliasToModel[requestedModel] ?? requestedModel;

    // Preserve the routed image model. Never silently downgrade it to a text model.
    if (isImageModel(aliasedModel)) {
      try {
        return await this.generateImage(params, aliasedModel);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[GrokProvider] Image API failure for ${aliasedModel}: ${detail}`);
        throw new Error(`Grok image request failed for model ${aliasedModel}: ${detail}`);
      }
    }
    if (params.requestIntent === "image-generation") {
      throw new Error(`Grok image generation requires an image model; received '${aliasedModel}'.`);
    }

    const availableModels = await this.listModels();
    const selectedModel = availableModels.length === 0 || availableModels.includes(aliasedModel)
      ? aliasedModel
      : this.defaultModel;

    if (params.boundedFrameObservations && selectedModel !== aliasedModel) throw new Error("Configured frame observation model is unavailable.");
    if (selectedModel !== requestedModel) {
      console.warn(
        `[GrokProvider] Requested model '${requestedModel}' is not available. Falling back to '${selectedModel}'.`
      );
    }

    try {
      const attachmentContext = formatAttachmentContext(params.attachments, { userMessage: params.user });
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}` },
        { role: "system", content: `MEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT` },
        { role: "system", content: buildMemoryContext(params.history) },
        { role: "system", content: `${getKatieOperationalRealityStatement()}

${getKatieReasoningExplainerStatement()}` }
      ];

      if (attachmentContext) {
        messages.push({ role: "system", content: attachmentContext });
      }

      const outgoingUserContent = buildChatUserContent(params);
      messages.push({ role: "user", content: outgoingUserContent });
      // Count the actual structured image parts sent to xAI, not merely frames
      // recovered on the server. Never emit JPEG payloads or image URLs in logs.
      const submittedImageCount = Array.isArray(outgoingUserContent)
        ? outgoingUserContent.filter(part => part.type === "image_url").length : 0;
      if ((params.images?.length ?? 0) !== submittedImageCount) {
        throw new Error("Grok image evidence was lost while building the outgoing request.");
      }

      if (isWebSearchIntent(params.requestIntent)) {
        const input = this.buildWebSearchInput(params, attachmentContext);
        await params.onProviderSystemPrepared?.({
          provider: "grok", model: selectedModel, endpoint: "/v1/responses",
          systemMessages: input.filter(entry => entry.role === "system")
            .map(entry => entry.content.map(part => part.type === "input_text" ? part.text : "").join("")),
        });
        const response = await this.createWebSearchResponse(selectedModel, input);

        const text = extractResponseText(response);
        const sources = extractResearchSources(response, text);

        console.log("[GrokProvider] web research evidence captured", {
          model: selectedModel,
          sourceCount: sources.length,
          responseChars: text.length
        });

        return {
          text,
          model: selectedModel,
          provider: this.name,
          researchEvidence: {
            kind: "web",
            retrievedBy: {
              provider: this.name,
              modelId: selectedModel
            },
            query: params.user,
            summary: text,
            sources,
            retrievedAt: new Date().toISOString()
          }
        };
      }

      if (submittedImageCount) {
        console.info("[GrokProvider] images included in outgoing xAI request", {
          model: selectedModel, imageCount: submittedImageCount,
          videoFrameCount: (params.attachments ?? []).reduce(
            (count, file) => count + (file.videoFrames?.length ?? 0), 0
          ),
          endpoint: "/chat/completions",
        });
      }
      await params.onProviderSystemPrepared?.({
        provider: "grok", model: selectedModel, endpoint: "/v1/chat/completions",
        systemMessages: messages.filter(entry => entry.role === "system")
          .map(entry => typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)),
      });
      const completion = await this.client.chat.completions.create({
        model: selectedModel,
        messages,
        ...(params.boundedFrameObservations ? { max_tokens: 6000 } : {}),
      }, params.boundedFrameObservations ? { maxRetries: 0, timeout: 180_000 } : undefined);
      if (submittedImageCount) {
        console.info("[GrokProvider] xAI acknowledged multimodal request", {
          model: selectedModel, imageCount: submittedImageCount,
          responseReceived: true,
        });
      }

      return {
        text: completion.choices[0]?.message?.content ?? "",
        ...(params.boundedFrameObservations ? { truncated: completion.choices[0]?.finish_reason === "length" } : {}),
        model: selectedModel,
        provider: this.name
      };
    } catch (error: unknown) {
      if (params.boundedFrameObservations) {
        console.warn("[GrokProvider] bounded frame observation failed", { model: selectedModel });
        throw new Error("Structured frame observation outcome unavailable; no automatic retry.");
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[GrokProvider] API failure for ${selectedModel}: ${detail}`);
      throw new Error(`Grok request failed for model ${selectedModel}: ${detail}`);
    }
  }
}
