import OpenAI from "openai";
import {
  isImageGenerationModel as isGoogleImageGenerationModel,
  isVisionAnalysisModel as isGoogleVisionAnalysisModel
} from "@/lib/providers/google-model-capabilities";
import { LlmProvider } from "@/lib/providers/types";

export type ProviderName = "openai" | "google" | "grok" | "anthropic";
export type RoutingChoice = { providerName: ProviderName; modelId: string };
export type RequestIntent =
  | "text"
  | "general-text"
  | "rewrite"
  | "emotional-analysis"
  | "news-summary"
  | "web-search"
  | "technical-debugging"
  | "architecture-review"
  | "code-generation"
  | "vision-analysis"
  | "multimodal-reasoning"
  | "image-generation";
export type ScoreAdjustment = { label: string; delta: number };
export type CandidateScoreBreakdown = {
  providerName: ProviderName;
  modelId: string;
  baseScore: number | null;
  adjustments: ScoreAdjustment[];
  finalScore: number;
  excluded: boolean;
  exclusionReason: string | null;
};

const IMAGE_GENERATION_MODEL_PATTERNS = [
  "banana",
  "image",
  "image-preview",
  "imagen",
  "stable-diffusion",
  "sdxl",
  "dall-e",
  "midjourney",
  "flux"
];

function isImageGenerationModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (IMAGE_GENERATION_MODEL_PATTERNS.some((pattern) => normalizedModel.includes(pattern))) {
    return true;
  }

  if (providerName === "google") {
    return isGoogleImageGenerationModel(modelId);
  }

  return false;
}

function isVisionAnalysisModel(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();

  if (isImageGenerationModel(providerName, modelId)) {
    return false;
  }

  if (providerName === "google") {
    return isGoogleVisionAnalysisModel(modelId);
  }

  if (providerName === "openai") {
    return (
      normalizedModel.includes("gpt-4o") ||
      normalizedModel.includes("gpt-4.1") ||
      normalizedModel.includes("gpt-5") ||
      normalizedModel.includes("o3")
    );
  }

  if (providerName === "anthropic") {
    return normalizedModel.includes("claude-4.5") || normalizedModel.includes("claude-4.6");
  }

  if (providerName === "grok") {
    return normalizedModel.includes("vision");
  }

  return normalizedModel.includes("vision");
}

function supportsWebSearch(providerName: ProviderName, modelId: string): boolean {
  const normalizedModel = modelId.toLowerCase();
  if (providerName === "grok") {
    return true;
  }
  if (providerName === "openai") {
    return normalizedModel.includes("search") || normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1");
  }
  if (providerName === "google") {
    return normalizedModel.includes("gemini");
  }
  return false;
}

// Request intent drives validation. The router is allowed to be creative. Validation is not.
const INTENT_CLASSIFICATION_MODEL_ID = "gpt-4o";

const intentDescriptions: Record<RequestIntent, string> = {
  text: "General text processing, base type.",
  "general-text":
    "For broad, non-specific questions or casual conversation where no other specific intent applies.",
  rewrite: "For rephrasing, editing, polishing, or adjusting the tone of text.",
  "emotional-analysis": "For analyzing sentiment, tone, feelings, or emotional nuance in text.",
  "news-summary": "For summarizing current events, headlines, or recent news.",
  "web-search": "For queries requiring up-to-date information, current events, or live data via a web search.",
  "technical-debugging": "For debugging, fixing, troubleshooting code, errors, exceptions, or system incidents.",
  "architecture-review":
    "For reviewing technical configurations, code, deployment manifests, system designs, or suggesting improvements for infrastructure.",
  "code-generation": "For writing, generating, creating, implementing, or refactoring code, functions, or scripts.",
  "vision-analysis": "For analyzing visual content (charts, images) to extract trends, outliers, or describe scenes.",
  "multimodal-reasoning":
    "For complex analytical tasks that might combine text, data, or require forecasting and deep reasoning.",
  "image-generation": "For creating or generating images, photos, or digital art."
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function classifyIntentWithLLM(prompt: string, intents: RequestIntent[]): Promise<RequestIntent | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[Intent Classifier] OPENAI_API_KEY is not configured. Falling back to heuristic defaults.");
    return null;
  }

  const intentGuide = intents.map((intent) => `- ${intent}: ${intentDescriptions[intent]}`).join("\n");
  const examples = [
    { user: "Rewrite this paragraph in a friendly tone.", intent: "rewrite" },
    { user: "Summarise today’s NYT front page.", intent: "news-summary" },
    { user: "Here is a Kubernetes deployment YAML. Spot the risks.", intent: "architecture-review" }
  ];
  const systemPrompt = `
You are an expert intent classifier.
Return ONLY a JSON object like {"intent":"<one_of:${intents.join("|")}>"}.
If unsure use {"intent":"null"}.
No other keys.
${intentGuide}
  `.trim();
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...examples.flatMap((example) => [
      { role: "user" as const, content: example.user },
      { role: "assistant" as const, content: JSON.stringify({ intent: example.intent }) }
    ]),
    { role: "user" as const, content: prompt }
  ];

  try {
    const llmResponse = await openai.chat.completions.create({
      model: INTENT_CLASSIFICATION_MODEL_ID,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 100,
      messages
    });

    const raw = llmResponse.choices[0]?.message?.content ?? "";
    console.debug("[Intent Classifier] raw model output:", raw);

    let classifiedIntent: string | null = null;

    try {
      const parsed = JSON.parse(raw);
      classifiedIntent = (parsed.intent ?? "").trim().toLowerCase();
    } catch (err) {
      console.error("[Intent Classifier] JSON parse error", err);
    }

    if (intents.includes(classifiedIntent as RequestIntent)) {
      return classifiedIntent as RequestIntent;
    }

    if (classifiedIntent === "null") {
      console.warn("[Intent Classifier] model returned null");
      return null;
    }

    console.warn(`[Intent Classifier] invalid intent "${classifiedIntent}"`);
    return null;
  } catch (error) {
    const err = error as {
      message?: string;
      status?: number;
      code?: string;
      type?: string;
      param?: string;
      request_id?: string;
    };

    console.error("[Intent Classifier] Failed to classify request intent", {
      message: err?.message ?? "Unknown error",
      status: err?.status ?? null,
      code: err?.code ?? null,
      type: err?.type ?? null,
      param: err?.param ?? null,
      request_id: err?.request_id ?? null
    });

    return null;
  }
}

export async function inferRequestIntent(prompt: string, hasImages: boolean): Promise<RequestIntent> {
  const availableIntents: RequestIntent[] = [
    "web-search",
    "news-summary",
    "emotional-analysis",
    "rewrite",
    "technical-debugging",
    "architecture-review",
    "code-generation",
    "multimodal-reasoning",
    "vision-analysis",
    "image-generation"
  ];

  const classifiedIntent = await classifyIntentWithLLM(prompt, availableIntents);

  if (classifiedIntent && availableIntents.includes(classifiedIntent)) {
    return classifiedIntent;
  }

  if (hasImages) {
    return "vision-analysis";
  }

  return "general-text";
}


function modelSupportsIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): boolean {
  switch (intent) {
    case "web-search":
    case "news-summary":
      return !isImageGenerationModel(providerName, modelId) && supportsWebSearch(providerName, modelId);
    case "image-generation":
      return isImageGenerationModel(providerName, modelId);
    case "vision-analysis":
    case "multimodal-reasoning":
      return isVisionAnalysisModel(providerName, modelId) && !isImageGenerationModel(providerName, modelId);
    case "text":
    case "general-text":
    case "rewrite":
    case "emotional-analysis":
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
      return !isImageGenerationModel(providerName, modelId);
  }
}

function rankTechnicalModel(providerName: ProviderName, modelId: string): number {
  if (isImageGenerationModel(providerName, modelId)) {
    return -1;
  }

  const normalizedModel = modelId.toLowerCase();
  let score = 10;

  if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
    score += 8;
  }
  if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
    score += 6;
  }
  if (normalizedModel.includes("pro")) {
    score += 4;
  }
  if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
    score += 4;
  }
  if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
    score -= 4;
  }
  if (normalizedModel.includes("pulse")) {
    score -= 6;
  }

  return score;
}

function rankModelForIntent(providerName: ProviderName, modelId: string, intent: RequestIntent): number {
  const normalizedModel = modelId.toLowerCase();

  switch (intent) {
    case "image-generation":
      if (!isImageGenerationModel(providerName, modelId)) {
        return -1;
      }
      return normalizedModel.includes("banana") ? 4 : 2;
    case "multimodal-reasoning":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        return 5;
      }
      if (normalizedModel.includes("pro") && normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "vision-analysis":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        return 5;
      }
      if (normalizedModel.includes("vision")) {
        return 5;
      }
      if (normalizedModel.includes("pro")) {
        return 4;
      }
      if (normalizedModel.includes("flash")) {
        return 3;
      }
      return 1;
    case "text":
    case "general-text":
    case "rewrite":
    case "emotional-analysis":
    case "news-summary":
    case "web-search":
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return -1;
      }

      let score = 10;

      if (normalizedModel.includes("flash") || normalizedModel.includes("haiku") || normalizedModel.includes("mini")) {
        score += 4;
      }

      if (normalizedModel.includes("gpt-5.2-unified") || normalizedModel.includes("grok-2-1212")) {
        score += 6;
      }

      if (normalizedModel.includes("unified") || normalizedModel.includes("grok-2")) {
        score += 3;
      }

      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("architect") ||
        normalizedModel.includes("reason")
      ) {
        score -= 8;
      }

      if (normalizedModel.includes("pro") && !normalizedModel.includes("gpt-5.2-unified")) {
        score -= 4;
      }

      if (providerName === "anthropic" && (intent === "rewrite" || intent === "emotional-analysis")) {
        score += 10;
      }
      if (providerName === "grok" && (intent === "news-summary" || intent === "web-search")) {
        score += 9;
      }
      if (providerName === "google" && intent === "general-text") {
        score += 4;
      }

      return score;
    case "technical-debugging":
    case "architecture-review":
    case "code-generation":
      return rankTechnicalModel(providerName, modelId);
  }
}

export function scoreModelsForIntent(
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
): Array<{ provider: LlmProvider; modelId: string; score: number }> {
  return availableByProvider
    .flatMap(({ provider, models }) =>
      models
        .map((modelId) => ({ provider, modelId, score: rankModelForIntent(provider.name, modelId, intent) }))
        .filter((candidate) => candidate.score >= 0)
    )
    .sort((left, right) => right.score - left.score);
}

export function scoreModelCandidateWithBreakdown(
  providerName: ProviderName,
  modelId: string,
  intent: RequestIntent
): CandidateScoreBreakdown {
  const normalizedModel = modelId.toLowerCase();
  const adjustments: ScoreAdjustment[] = [];

  const finalize = (baseScore: number | null, finalScore: number, exclusionReason: string | null): CandidateScoreBreakdown => ({
    providerName,
    modelId,
    baseScore,
    adjustments,
    finalScore,
    excluded: finalScore < 0,
    exclusionReason: exclusionReason ?? (finalScore < 0 ? "score_below_zero" : null)
  });

  switch (intent) {
    case "image-generation": {
      if (!isImageGenerationModel(providerName, modelId)) {
        return finalize(null, -1, "intent_mismatch:image-generation");
      }
      const baseScore = normalizedModel.includes("banana") ? 4 : 2;
      return finalize(baseScore, baseScore, null);
    }
    case "multimodal-reasoning": {
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return finalize(null, -1, "intent_mismatch:multimodal-reasoning");
      }
      const baseScore = 1;
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        adjustments.push({ label: "frontier_multimodal_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro") && normalizedModel.includes("vision")) {
        adjustments.push({ label: "vision_pro_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 3 });
      } else if (normalizedModel.includes("flash")) {
        adjustments.push({ label: "flash_bonus", delta: 2 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "vision-analysis": {
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        return finalize(null, -1, "intent_mismatch:vision-analysis");
      }
      const baseScore = 1;
      if (
        normalizedModel.includes("gpt-5") ||
        normalizedModel.includes("gpt-4o") ||
        normalizedModel.includes("claude-4.5") ||
        normalizedModel.includes("claude-4.6") ||
        normalizedModel.includes("o3")
      ) {
        adjustments.push({ label: "frontier_vision_bonus", delta: 4 });
      } else if (normalizedModel.includes("vision")) {
        adjustments.push({ label: "vision_bonus", delta: 4 });
      } else if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 3 });
      } else if (normalizedModel.includes("flash")) {
        adjustments.push({ label: "flash_bonus", delta: 2 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "text":
    case "general-text":
    case "rewrite":
    case "emotional-analysis":
    case "news-summary":
    case "web-search": {
      if (!modelSupportsIntent(providerName, modelId, intent)) {
        const reason = intent === "web-search" || intent === "news-summary" ? "missing_web_search_capability" : `intent_mismatch:${intent}`;
        return finalize(null, -1, reason);
      }
      const baseScore = 10;
      if (normalizedModel.includes("flash") || normalizedModel.includes("haiku") || normalizedModel.includes("mini")) {
        adjustments.push({ label: "speed_efficiency_bonus", delta: 4 });
      }
      if (normalizedModel.includes("gpt-5.2-unified") || normalizedModel.includes("grok-2-1212")) {
        adjustments.push({ label: "preferred_general_model_bonus", delta: 6 });
      }
      if (normalizedModel.includes("unified") || normalizedModel.includes("grok-2")) {
        adjustments.push({ label: "general_conversation_bonus", delta: 3 });
      }
      if (
        normalizedModel.includes("opus") ||
        normalizedModel.includes("o3-pro") ||
        normalizedModel.includes("codex") ||
        normalizedModel.includes("architect") ||
        normalizedModel.includes("reason")
      ) {
        adjustments.push({ label: "deep_reasoning_penalty", delta: -8 });
      }
      if (normalizedModel.includes("pro") && !normalizedModel.includes("gpt-5.2-unified")) {
        adjustments.push({ label: "pro_model_penalty", delta: -4 });
      }
      if (providerName === "anthropic" && (intent === "rewrite" || intent === "emotional-analysis")) {
        adjustments.push({ label: "claude_nuanced_writing_bonus", delta: 10 });
      }
      if (providerName === "grok" && (intent === "news-summary" || intent === "web-search")) {
        adjustments.push({ label: "grok_realtime_news_bonus", delta: 9 });
      }
      if (providerName === "google" && intent === "general-text") {
        adjustments.push({ label: "gemini_general_reasoning_bonus", delta: 4 });
      }
      if (intent === "web-search" && supportsWebSearch(providerName, modelId)) {
        adjustments.push({ label: "web_search_hard_requirement_met", delta: 3 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
    case "technical-debugging":
    case "architecture-review":
    case "code-generation": {
      if (isImageGenerationModel(providerName, modelId)) {
        return finalize(null, -1, "image_generation_model_excluded_for_technical_intent");
      }
      const baseScore = 10;
      if (normalizedModel.includes("codex") || normalizedModel.includes("o3-pro")) {
        adjustments.push({ label: "coding_reasoning_bonus", delta: 8 });
      }
      if (normalizedModel.includes("opus") || normalizedModel.includes("sonnet")) {
        adjustments.push({ label: "architecture_depth_bonus", delta: 6 });
      }
      if (normalizedModel.includes("pro")) {
        adjustments.push({ label: "pro_bonus", delta: 4 });
      }
      if (normalizedModel.includes("gpt-5") || normalizedModel.includes("gpt-4.1")) {
        adjustments.push({ label: "latest_gpt_bonus", delta: 4 });
      }
      if (normalizedModel.includes("mini") || normalizedModel.includes("flash") || normalizedModel.includes("haiku")) {
        adjustments.push({ label: "small_model_penalty", delta: -4 });
      }
      if (normalizedModel.includes("pulse")) {
        adjustments.push({ label: "realtime_model_penalty", delta: -6 });
      }
      const finalScore = baseScore + adjustments.reduce((total, current) => total + current.delta, 0);
      return finalize(baseScore, finalScore, null);
    }
  }
}

export function validateRoutingDecision(
  decision: RoutingChoice,
  availableByProvider: Array<{ provider: LlmProvider; models: string[] }>,
  intent: RequestIntent
): { provider: LlmProvider; modelId: string; reasoning: string; changed: boolean } {
  if (["technical-debugging", "code-generation", "architecture-review"].includes(intent)) {
    availableByProvider = availableByProvider.map(({ provider, models }) => ({
      provider,
      models: models.filter((modelId) => !isImageGenerationModel(provider.name, modelId))
    }));
  }

  const selectedProvider = availableByProvider.find(({ provider }) => provider.name === decision.providerName);

  if (
    selectedProvider &&
    modelSupportsIntent(decision.providerName, decision.modelId, intent) &&
    selectedProvider.models.includes(decision.modelId)
  ) {
    return {
      provider: selectedProvider.provider,
      modelId: decision.modelId,
      reasoning: `Validated ${decision.providerName}:${decision.modelId} for ${intent}.`,
      changed: false
    };
  }

  const compatibleChoices = scoreModelsForIntent(availableByProvider, intent);

  const fallback = compatibleChoices[0];

  if (fallback) {
    return {
      provider: fallback.provider,
      modelId: fallback.modelId,
      reasoning: `Rejected ${decision.providerName}:${decision.modelId} for ${intent}; fell back to ${fallback.provider.name}:${fallback.modelId}.`,
      changed: true
    };
  }

  const firstProvider = selectedProvider ?? availableByProvider[0];
  const modelId = selectedProvider?.models[0] ?? availableByProvider[0]?.models[0] ?? decision.modelId;

  return {
    provider: firstProvider.provider,
    modelId,
    reasoning: `No compatible model found for ${intent}; kept closest available ${firstProvider.provider.name}:${modelId}.`,
    changed: true
  };
}
