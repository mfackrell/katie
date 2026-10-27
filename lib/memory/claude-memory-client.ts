/** Transport adapter only: keep the LTM editor's existing JSON/client contract. */
export const MEMORY_EDITOR_MODEL = "claude-sonnet-5-5";

type MemoryRequest = {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

type ClaudeResponse = {
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
};

// These are the EXISTING editor, review and handoff response fields. The native
// JSON-output constraint replaces OpenAI JSON mode; domain validation stays in
// long-term-editor.ts. Anthropic's OpenAI compatibility endpoint ignores JSON mode.
const text = { type: "string" };
const strings = { type: "array", items: text };
const entries = {
  type: "array",
  items: {
    type: "object", additionalProperties: false,
    properties: {
      key: text, category: text, value: text, source: text, confidence: text,
      evidenceMessageIds: strings,
      evidenceQuotes: {
        type: "array", items: {
          type: "object", additionalProperties: false,
          properties: { messageId: text, quote: text }, required: ["messageId", "quote"],
        },
      },
      lastConfirmedAt: text,
    },
    required: ["key", "category", "value", "source", "confidence"],
  },
};
const snapshot = {
  type: "object", additionalProperties: false,
  properties: { version: { type: "integer" }, purpose: text, entries },
  required: ["version", "purpose", "entries"],
};
const responseSchema = {
  type: "object", additionalProperties: false,
  properties: {
    action: text, updatedContent: snapshot,
    // Retain support for the existing unwrapped version-3 response too.
    ...snapshot.properties,
    keys: strings,
    verdicts: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: {
          key: text, supported: { type: "boolean" }, durable: { type: "boolean" }, reason: text,
        },
        required: ["key", "supported", "durable", "reason"],
      },
    },
  },
};

export function createClaudeMemoryClient() {
  // Match Katie's existing Claude-provider credentials, without changing global routing.
  const apiKey = process.env.CLAUDE_API_KEY ?? process.env["claude_api_key"];
  if (!apiKey) return null;
  try {
    // Reuse the installed SDK's HTTP transport and its existing retry/timeout
    // defaults. No dependency, retry loop, fallback model or orchestration is added.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: OpenAI } = require("openai") as typeof import("openai");
    const transport = new OpenAI({
      apiKey,
      baseURL: "https://api.anthropic.com/v1",
      defaultHeaders: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    return { chat: { completions: { async create(params: MemoryRequest) {
      const result = await transport.post<ClaudeResponse>("/messages", {
        body: {
          model: params.model,
          max_tokens: 16_384,
          system: params.messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
          messages: params.messages.filter(message => message.role === "user"),
          // Sonnet 5.5 rejects temperature:0 and thinking:disabled. Keep this a
          // non-tool, non-thinking JSON call, as with the previous memory client.
          thinking: { type: "between_tools" },
          output_config: { effort: "high", format: { type: "json_schema", schema: responseSchema } },
        },
      });
      if (result.stop_reason !== "end_turn") {
        throw new Error(`Claude memory response incomplete: ${result.stop_reason ?? "missing stop reason"}`);
      }
      const content = (result.content ?? [])
        .filter(block => block.type === "text" && typeof block.text === "string")
        .map(block => block.text).join("");
      if (!content.trim()) throw new Error("Claude memory response contained no text");
      return { choices: [{ message: { content } }] };
    } } } };
  } catch {
    return null;
  }
}
