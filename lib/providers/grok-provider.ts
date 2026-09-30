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
  citations?: string[];
  output?: Array<{
    type?: string;
    content?: Array<{ text?: string }>;
    action?: {
      sources?: Array<GrokWebSearchSource | string>;
      [key: string]: unknown;
    };
  }>;
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

function extractResearchSources(response: GrokWebSearchResponse): ResearchEvidenceSource[] {
  const byUrl = new Map<string, ResearchEvidenceSource>();

  const addSource = (source: GrokWebSearchSource | string) => {
    const rawUrl =
      typeof source === "string"
        ? source
        : typeof source.url === "string"
          ? source.url
          : typeof source.link === "string"
            ? source.link
            : "";
    const url = rawUrl.trim();
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
      2_000
    );
    byUrl.set(url, {
      url,
      ...(title ? { title } : existing?.title ? { title: existing.title } : {}),
      ...(snippet ? { snippet } : existing?.snippet ? { snippet: existing.snippet } : {})
    });
  };

  (response.citations ?? []).forEach(addSource);
  (response.output ?? []).forEach((item) => {
    if (item.type === "web_search_call") {
      (item.action?.sources ?? []).forEach(addSource);
    }
  });

  return Array.from(byUrl.values()).slice(0, 30);
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
    "grok-imagine": this.defaultModel,
    "grok-imagine-image": this.defaultModel
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
      fetch: globalThis.fetch.bind(globalThis)
    });
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
    return parsed as GrokWebSearchResponse;
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
      throw new Error("Grok provider does not support video attachments in this chat flow.");
    }

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
        const sources = extractResearchSources(response);

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
