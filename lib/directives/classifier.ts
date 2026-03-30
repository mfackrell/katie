import { extractDirectiveCandidate, isDirectiveRemovalRequest, normalizeDirectiveText } from "@/lib/directives/extraction";

export type DirectiveAction =
  | "persistent_directive_add"
  | "persistent_directive_update"
  | "persistent_directive_remove"
  | "normal_message";

export type DirectiveDecision =
  | {
      action: "persistent_directive_add" | "persistent_directive_update";
      directive: string;
      confidence: number | null;
      rationale?: string;
    }
  | {
      action: "persistent_directive_remove";
      directive?: string | null;
      confidence: number | null;
      rationale?: string;
    }
  | {
      action: "normal_message";
      confidence: number | null;
      rationale?: string;
    };

type OpenAIClient = import("openai").default;

const DIRECTIVE_CLASSIFIER_MODEL_ID = "gpt-4o-mini";

let openaiClient: OpenAIClient | null | undefined;

async function getOpenAIClient(): Promise<OpenAIClient | null> {
  if (openaiClient) {
    return openaiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    openaiClient = null;
    return null;
  }

  try {
    const { default: OpenAI } = await import("openai");
    openaiClient = new OpenAI({ apiKey });
    return openaiClient;
  } catch {
    openaiClient = null;
    return null;
  }
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function parseDecisionPayload(raw: string): DirectiveDecision | null {
  try {
    const parsed = JSON.parse(raw) as {
      action?: string;
      directive?: string | null;
      confidence?: number | null;
      rationale?: string;
    };

    if (parsed.action === "normal_message") {
      return {
        action: "normal_message",
        confidence: clampConfidence(parsed.confidence),
        ...(typeof parsed.rationale === "string" ? { rationale: parsed.rationale } : {})
      };
    }

    if (parsed.action === "persistent_directive_remove") {
      return {
        action: "persistent_directive_remove",
        directive: typeof parsed.directive === "string" ? normalizeDirectiveText(parsed.directive) : null,
        confidence: clampConfidence(parsed.confidence),
        ...(typeof parsed.rationale === "string" ? { rationale: parsed.rationale } : {})
      };
    }

    if (parsed.action === "persistent_directive_add" || parsed.action === "persistent_directive_update") {
      const normalized = typeof parsed.directive === "string" ? normalizeDirectiveText(parsed.directive) : "";
      if (!normalized) {
        return null;
      }

      return {
        action: parsed.action,
        directive: normalized,
        confidence: clampConfidence(parsed.confidence),
        ...(typeof parsed.rationale === "string" ? { rationale: parsed.rationale } : {})
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildClassifierMessages(message: string) {
  return [
    {
      role: "system" as const,
      content:
        "You are a narrow classifier for persistent directives. Decide whether the user message asks to add/update/remove a persistent instruction to be stored for future conversations, or is a normal chat message. Return strict JSON only with this schema: {\"action\":\"persistent_directive_add|persistent_directive_update|persistent_directive_remove|normal_message\",\"directive\":string|null,\"confidence\":number|null,\"rationale\":string}. Rules: 1) Only classify as persistent directive if message clearly asks memory/instruction persistence (e.g., remember this, from now on, keep in mind). 2) For add/update, provide normalized directive text. 3) For remove, include target directive if explicitly named, else null. 4) If ordinary question or statement, return normal_message. 5) No markdown; JSON only."
    },
    {
      role: "user" as const,
      content: message
    }
  ];
}

export async function classifyDirectiveIntent(message: string): Promise<DirectiveDecision | null> {
  console.log("[Directive Classifier] attempting LLM classification");
  const openai = await getOpenAIClient();
  if (!openai) {
    console.warn("[Directive Classifier] OpenAI unavailable; classifier skipped");
    return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: DIRECTIVE_CLASSIFIER_MODEL_ID,
      temperature: 0,
      messages: buildClassifierMessages(message),
      response_format: { type: "json_object" }
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const parsed = parseDecisionPayload(raw);
    if (!parsed) {
      console.warn("[Directive Classifier] invalid classifier payload", { raw: raw.slice(0, 200) });
      return null;
    }

    console.log(`[Directive Classifier] action=${parsed.action} confidence=${parsed.confidence ?? "null"}`);
    return parsed;
  } catch (error) {
    console.warn("[Directive Classifier] provider error", error);
    return null;
  }
}

export function classifyDirectiveFallback(message: string): DirectiveDecision {
  if (isDirectiveRemovalRequest(message)) {
    console.log("[Directive Fallback] remove heuristic matched");
    return { action: "persistent_directive_remove", directive: null, confidence: null, rationale: "heuristic_remove" };
  }

  const candidate = extractDirectiveCandidate(message);
  if (candidate?.confidence === "high") {
    console.log("[Directive Fallback] add heuristic matched");
    return {
      action: "persistent_directive_add",
      directive: candidate.directive,
      confidence: null,
      rationale: "heuristic_add"
    };
  }

  console.log("[Directive Fallback] no heuristic match");
  return { action: "normal_message", confidence: null, rationale: "heuristic_normal" };
}
