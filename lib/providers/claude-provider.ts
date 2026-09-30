import {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
  ProviderStreamHandlers
} from "@/lib/providers/types";
import { MATH_EXECUTION_PROTOCOL } from "@/lib/providers/math-execution-protocol";
import { formatAttachmentContext } from "@/lib/providers/attachment-context";
import {
  getKatieOperationalRealityStatement,
  getKatieReasoningExplainerStatement
} from "@/lib/providers/operational-reality";

type ClaudeContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
};

type ClaudeMessageResponse = {
  content?: ClaudeContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: ClaudeUsage;
};

type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

type ClaudePassResult = {
  text: string;
  content: ClaudeContentBlock[];
  stopReason?: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

type ClaudeStreamEvent = {
  type?: string;
  message?: ClaudeMessageResponse;
  content_block?: ClaudeContentBlock;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  usage?: ClaudeUsage;
  error?: {
    type?: string;
    message?: string;
  };
};

const CLAUDE_MAX_OUTPUT_TOKENS = 16_384;
const CLAUDE_MAX_CONTINUATIONS = 3;
const CLAUDE_TRUNCATION_NOTICE =
  "\n\n[Response reached the maximum output length and could not be fully completed.]";
const CLAUDE_CONTINUATION_INSTRUCTION =
  "Continue exactly where the previous assistant output stopped. Do not repeat, summarize, restart, or introduce the continuation. Preserve the existing structure and finish the original request.";

function extractClaudeText(content: ClaudeContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function addTokenCount(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== "number") {
    return current;
  }
  return (current ?? 0) + next;
}

function appendContinuation(base: string, continuation: string): string {
  if (!continuation) {
    return base;
  }
  if (!base) {
    return continuation;
  }

  const maxOverlap = Math.min(800, base.length, continuation.length);
  for (let overlap = maxOverlap; overlap >= 24; overlap -= 1) {
    if (base.slice(-overlap) === continuation.slice(0, overlap)) {
      return base + continuation.slice(overlap);
    }
  }

  return base + continuation;
}

function buildContinuationMessages(baseMessages: ClaudeMessage[], accumulatedText: string): ClaudeMessage[] {
  const priorAssistantOutput = accumulatedText.trimEnd();
  return [
    ...baseMessages,
    {
      role: "assistant",
      content: priorAssistantOutput
    },
    {
      role: "user",
      content: CLAUDE_CONTINUATION_INSTRUCTION
    }
  ];
}

function toProviderResponse(params: {
  text: string;
  model: string;
  provider: "anthropic";
  stopReason?: string;
  continuationCount: number;
  inputTokens?: number;
  outputTokens?: number;
  truncated: boolean;
}): ProviderResponse {
  return {
    text: params.text,
    provider: params.provider,
    model: params.model,
    finishReason: params.stopReason,
    truncated: params.truncated,
    continuationCount: params.continuationCount,
    content: params.text ? [{ type: "text", text: params.text }] : undefined,
    usage: {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens:
        typeof params.inputTokens === "number" && typeof params.outputTokens === "number"
          ? params.inputTokens + params.outputTokens
          : undefined
    }
  };
}

export class ClaudeProvider implements LlmProvider {
  name = "anthropic" as const;
  private defaultModel = "claude-4.5-sonnet";

  constructor(private apiKey: string) {}

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        }
      });

      if (!response.ok) {
        const detail = await response.text();
        console.error(`[ClaudeProvider] Failed to list models: ${detail}`);
        return [];
      }

      const data = (await response.json()) as { data: Array<{ id: string }> };
      return data.data.map((model) => model.id);
    } catch (error) {
      console.error("[ClaudeProvider] Network error listing models:", error);
      return [];
    }
  }

  private buildRequestContext(params: ChatGenerateParams): {
    selectedModel: string;
    system: string;
    messages: ClaudeMessage[];
  } {
    const hasVideoAttachments = Boolean(
      params.attachments?.some(
        (attachment) =>
          attachment.attachmentKind === "video" || attachment.mimeType.startsWith("video/"),
      ),
    );
    if (hasVideoAttachments) {
      throw new Error("Anthropic provider does not support video attachments in this chat flow.");
    }

    const selectedModel = params.modelId ?? this.defaultModel;
    const attachmentContext = formatAttachmentContext(params.attachments, {
      userMessage: params.user
    });
    const systemPrompt = `${MATH_EXECUTION_PROTOCOL}\n\nCORE_PERSONA: ${params.persona}\n\nMEMORY_CONTEXT:\n${params.summary}\nEND_MEMORY_CONTEXT\n\n${getKatieOperationalRealityStatement()}\n\n${getKatieReasoningExplainerStatement()}`;
    const system = attachmentContext ? `${systemPrompt}\n\n${attachmentContext}` : systemPrompt;
    const messages: ClaudeMessage[] = [
      ...params.history.map((entry) => ({
        role: entry.role,
        content: entry.content
      })),
      {
        role: "user",
        content: params.images?.length
          ? [
              ...params.images.map((image): ClaudeContentBlock => {
                const data = image.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]+)$/);
                if (data) {
                  return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
                }
                if (/^https?:\/\//i.test(image)) {
                  return { type: "image", source: { type: "url", url: image } };
                }
                throw new Error("Unsupported Claude image input; use JPEG, PNG, GIF or WebP base64 data or an HTTP(S) URL.");
              }),
              { type: "text", text: params.user },
            ]
          : params.user,
      }
    ];

    return { selectedModel, system, messages };
  }

  private async postMessage(params: {
    model: string;
    system: string;
    messages: ClaudeMessage[];
    stream: boolean;
  }): Promise<Response> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
        system: params.system,
        messages: params.messages,
        ...(params.stream ? { stream: true } : {})
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error(`[ClaudeProvider] API failure for ${params.model}: ${detail}`);
      throw new Error(`Claude request failed for model ${params.model}: ${detail}`);
    }

    return response;
  }

  private async generatePass(params: {
    model: string;
    system: string;
    messages: ClaudeMessage[];
  }): Promise<ClaudePassResult> {
    const response = await this.postMessage({ ...params, stream: false });
    const body = (await response.json()) as ClaudeMessageResponse;
    const content = body.content ?? [];

    return {
      text: extractClaudeText(content),
      content,
      stopReason: body.stop_reason ?? undefined,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens
      }
    };
  }

  private async generateStreamPass(
    params: {
      model: string;
      system: string;
      messages: ClaudeMessage[];
    },
    handlers: ProviderStreamHandlers
  ): Promise<ClaudePassResult> {
    const response = await this.postMessage({ ...params, stream: true });
    if (!response.body) {
      throw new Error(`Claude streaming request for model ${params.model} returned no response body.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const processEvent = async (rawEvent: string): Promise<void> => {
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();

      if (!data || data === "[DONE]") {
        return;
      }

      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(data) as ClaudeStreamEvent;
      } catch {
        console.warn("[ClaudeProvider] Ignoring malformed Anthropic SSE event.");
        return;
      }

      if (event.type === "error") {
        const detail = event.error?.message ?? event.error?.type ?? "Unknown Anthropic stream error";
        throw new Error(`Claude streaming request failed: ${detail}`);
      }

      if (event.type === "message_start") {
        inputTokens = addTokenCount(inputTokens, event.message?.usage?.input_tokens);
        if (typeof event.message?.usage?.output_tokens === "number") {
          outputTokens = Math.max(outputTokens ?? 0, event.message.usage.output_tokens);
        }
        return;
      }

      if (event.type === "content_block_start") {
        const initialText =
          event.content_block?.type === "text" && typeof event.content_block.text === "string"
            ? event.content_block.text
            : "";
        if (initialText) {
          text += initialText;
          await handlers.onTextDelta?.(initialText);
        }
        return;
      }

      if (event.type === "content_block_delta") {
        const deltaText =
          event.delta?.type === "text_delta" && typeof event.delta.text === "string"
            ? event.delta.text
            : "";
        if (deltaText) {
          text += deltaText;
          await handlers.onTextDelta?.(deltaText);
        }
        return;
      }

      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
        if (typeof event.usage?.output_tokens === "number") {
          outputTokens = Math.max(outputTokens ?? 0, event.usage.output_tokens);
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      }

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        await processEvent(rawEvent);
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) {
        buffer += decoder.decode();
        break;
      }
    }

    const remainder = buffer.trim();
    if (remainder) {
      await processEvent(remainder);
    }

    return {
      text,
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      usage: {
        inputTokens,
        outputTokens
      }
    };
  }

  async generate(params: ChatGenerateParams): Promise<ProviderResponse> {
    const { selectedModel, system, messages } = this.buildRequestContext(params);

    let accumulatedText = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    let continuationCount = 0;

    for (let passIndex = 0; passIndex <= CLAUDE_MAX_CONTINUATIONS; passIndex += 1) {
      const continuationPass = passIndex > 0;
      const pass = await this.generatePass({
        model: selectedModel,
        system,
        messages: continuationPass
          ? buildContinuationMessages(messages, accumulatedText)
          : messages
      });

      accumulatedText = appendContinuation(accumulatedText, pass.text);
      inputTokens = addTokenCount(inputTokens, pass.usage.inputTokens);
      outputTokens = addTokenCount(outputTokens, pass.usage.outputTokens);
      stopReason = pass.stopReason;

      if (stopReason !== "max_tokens") {
        return toProviderResponse({
          text: accumulatedText,
          model: selectedModel,
          provider: this.name,
          stopReason,
          continuationCount,
          inputTokens,
          outputTokens,
          truncated: false
        });
      }

      if (passIndex < CLAUDE_MAX_CONTINUATIONS) {
        continuationCount += 1;
        console.warn("[ClaudeProvider] Output reached max_tokens; continuing generation.", {
          model: selectedModel,
          continuationCount,
          maxOutputTokensPerPass: CLAUDE_MAX_OUTPUT_TOKENS
        });
      }
    }

    accumulatedText += CLAUDE_TRUNCATION_NOTICE;
    console.error("[ClaudeProvider] Output remained truncated after all continuation passes.", {
      model: selectedModel,
      continuationCount,
      maxOutputTokensPerPass: CLAUDE_MAX_OUTPUT_TOKENS
    });

    return toProviderResponse({
      text: accumulatedText,
      model: selectedModel,
      provider: this.name,
      stopReason: stopReason ?? "max_tokens",
      continuationCount,
      inputTokens,
      outputTokens,
      truncated: true
    });
  }

  async generateStream(
    params: ChatGenerateParams,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse> {
    const { selectedModel, system, messages } = this.buildRequestContext(params);

    let accumulatedText = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    let continuationCount = 0;

    for (let passIndex = 0; passIndex <= CLAUDE_MAX_CONTINUATIONS; passIndex += 1) {
      const continuationPass = passIndex > 0;
      const pass = await this.generateStreamPass(
        {
          model: selectedModel,
          system,
          messages: continuationPass
            ? buildContinuationMessages(messages, accumulatedText)
            : messages
        },
        handlers
      );

      accumulatedText = appendContinuation(accumulatedText, pass.text);
      inputTokens = addTokenCount(inputTokens, pass.usage.inputTokens);
      outputTokens = addTokenCount(outputTokens, pass.usage.outputTokens);
      stopReason = pass.stopReason;

      if (stopReason !== "max_tokens") {
        return toProviderResponse({
          text: accumulatedText,
          model: selectedModel,
          provider: this.name,
          stopReason,
          continuationCount,
          inputTokens,
          outputTokens,
          truncated: false
        });
      }

      if (passIndex < CLAUDE_MAX_CONTINUATIONS) {
        continuationCount += 1;
        console.warn("[ClaudeProvider] Stream reached max_tokens; continuing generation.", {
          model: selectedModel,
          continuationCount,
          maxOutputTokensPerPass: CLAUDE_MAX_OUTPUT_TOKENS
        });
      }
    }

    accumulatedText += CLAUDE_TRUNCATION_NOTICE;
    await handlers.onTextDelta?.(CLAUDE_TRUNCATION_NOTICE);
    console.error("[ClaudeProvider] Stream remained truncated after all continuation passes.", {
      model: selectedModel,
      continuationCount,
      maxOutputTokensPerPass: CLAUDE_MAX_OUTPUT_TOKENS
    });

    return toProviderResponse({
      text: accumulatedText,
      model: selectedModel,
      provider: this.name,
      stopReason: stopReason ?? "max_tokens",
      continuationCount,
      inputTokens,
      outputTokens,
      truncated: true
    });
  }
}
