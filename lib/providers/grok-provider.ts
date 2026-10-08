import OpenAI from "openai";
import {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ResearchEvidenceSource
} from "@/lib/providers/types";
import { buildMemoryContext } from "@/lib/providers/memory-context";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";
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

  private async generateImage(params: ChatGenerateParams, model: string): Promise<ProviderResponse> {
    if (!params.user.trim()) throw new Error("Grok image generation requires a prompt.");
    const images = params.images ?? [];
    if (images.length > 5) throw new Error("Grok image editing supports up to five source images.");
    const endpoint = images.length ? "edits" : "generations";
    const imageInputs = images.map((url) => ({ type: "image_url", url }));
    console.info("[GrokProvider] image request", { model, endpoint: `/images/${endpoint}`, sourceImageCount: images.length });

    // xAI image edits require JSON; OpenAI images.edit() sends incompatible multipart data.
    const response = await fetch(`https://api.x.ai/v1/images/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        prompt: params.user,
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

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    if (hasVideoAttachments(params)) {
      const videos = (params.attachments ?? []).filter(a => a.attachmentKind === "video" || a.mimeType.startsWith("video/"));
      const missing = videos.find(video => !video.videoFrames?.length);
      if (missing) throw new Error(`Grok cannot inspect ${missing.fileName} because no video frames were captured.`);
      const visualFrames = videos.flatMap(video => video.videoFrames ?? []).slice(0, 8);
      // Be explicit about sampled visual evidence: Grok does not receive or hear the MP4.
      const labels = videos.map(video =>
        `${video.fileName}: ${(video.videoFrames ?? []).map(frame => `${frame.timestampSeconds}s`).join(", ")}`
      ).join("; ");
      params = {
        ...params,
        user: `${params.user}\n\nGROK VIDEO FALLBACK (vision-only): Attached images are time-sampled still frames, NOT native video. Frame time labels: ${labels}. Inspect only visible evidence in those frames; do not infer unseen motion, sounds, speech, or events between frames. If audio or fine temporal detail is needed, state that this fallback cannot assess it.`,
        images: [...(params.images ?? []), ...visualFrames.map(frame => frame.dataUrl)],
      };
      console.info("[GrokProvider] fallback frame inspection", {
        frameCount: visualFrames.length,
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

      messages.push({ role: "user", content: buildChatUserContent(params) });

      if (isWebSearchIntent(params.requestIntent)) {
        const input = this.buildWebSearchInput(params, attachmentContext);
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
